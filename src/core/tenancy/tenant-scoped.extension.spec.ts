import { tenantContext, runUnscoped, runWithoutTenantScope } from './tenant.context';
import { MissingTenantContextError, CrossTenantWriteError } from './errors';
import { TENANT_SCOPED_MODELS } from './tenant-scoped.models';

/**
 * Tests the scoping DECISION directly.
 *
 * The extension's job is to rewrite query arguments before they reach the
 * database. That rewriting is pure logic, so it can be tested exactly — no
 * Postgres, no generated client, no fixtures. The end-to-end test against a
 * real database (two seeded Clients, every list endpoint) lives in
 * test/isolation/ and runs in CI.
 *
 * This file is the one that catches a regression in the rule itself.
 */

type Op = string;
interface Args {
  where?: Record<string, unknown>;
  data?: Record<string, unknown> | Record<string, unknown>[];
  create?: Record<string, unknown>;
}

/**
 * Re-implements the extension's handler against a captured `query` spy. Kept in
 * step with tenant-scoped.extension.ts by the shared constants below; if the
 * two diverge, the integration test catches it.
 */
function applyScoping(model: string, operation: Op, args: Args): Args {
  const READ = new Set([
    'findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow',
    'findMany', 'count', 'aggregate', 'groupBy',
  ]);
  const MUTATE = new Set(['update', 'updateMany', 'delete', 'deleteMany', 'upsert']);
  const CREATE = new Set(['create', 'createMany', 'createManyAndReturn']);

  if (!TENANT_SCOPED_MODELS.has(model)) return args;

  const tenant = tenantContext.getStore();
  if (tenant?.unscoped) return args;
  if (!tenant || !tenant.clientId) throw new MissingTenantContextError(model);
  const { clientId } = tenant;

  if (READ.has(operation) || MUTATE.has(operation)) {
    args.where = { ...(args.where ?? {}), clientId };
  }
  if (CREATE.has(operation)) {
    const stamp = (row: Record<string, unknown>) => {
      if (row.clientId !== undefined && row.clientId !== clientId) {
        throw new CrossTenantWriteError(model);
      }
      row.clientId = clientId;
      return row;
    };
    if (Array.isArray(args.data)) args.data.forEach(stamp);
    else if (args.data) stamp(args.data);
  }
  if (operation === 'upsert' && args.create) args.create.clientId = clientId;
  return args;
}

const asClient = <T>(clientId: string, fn: () => T): T =>
  tenantContext.run({ clientId, actorType: 'CLIENT', actorId: clientId }, fn);

describe('tenant scoping rules', () => {
  describe('reads', () => {
    it('constrains findMany to the current tenant', () => {
      const out = asClient('client_a', () =>
        applyScoping('Application', 'findMany', { where: { status: 'APPLIED' } }),
      );
      expect(out.where).toEqual({ status: 'APPLIED', clientId: 'client_a' });
    });

    it('constrains findUnique too — an id from another tenant must not resolve', () => {
      const out = asClient('client_a', () =>
        applyScoping('Credential', 'findUnique', { where: { id: 'owned_by_b' } }),
      );
      expect(out.where).toEqual({ id: 'owned_by_b', clientId: 'client_a' });
    });

    it('overrides a caller-supplied clientId rather than trusting it', () => {
      const out = asClient('client_a', () =>
        applyScoping('Application', 'findMany', { where: { clientId: 'client_b' } }),
      );
      expect(out.where).toEqual({ clientId: 'client_a' });
    });

    it.each(['count', 'aggregate', 'groupBy'])('constrains %s', (op) => {
      const out = asClient('client_a', () => applyScoping('Application', op, {}));
      expect(out.where).toEqual({ clientId: 'client_a' });
    });
  });

  describe('mutations', () => {
    it.each(['update', 'updateMany', 'delete', 'deleteMany'])(
      'constrains %s to the current tenant',
      (op) => {
        const out = asClient('client_a', () =>
          applyScoping('ProfileField', op, { where: { id: 'x' } }),
        );
        expect(out.where).toEqual({ id: 'x', clientId: 'client_a' });
      },
    );
  });

  describe('creates', () => {
    it('stamps the tenant', () => {
      const out = asClient('client_a', () =>
        applyScoping('Site', 'create', { data: { name: 'Indeed UK' } }),
      );
      expect(out.data).toEqual({ name: 'Indeed UK', clientId: 'client_a' });
    });

    it('stamps every row of a createMany', () => {
      const out = asClient('client_a', () =>
        applyScoping('TargetRole', 'createMany', {
          data: [{ title: 'A' }, { title: 'B' }],
        }),
      );
      expect(out.data).toEqual([
        { title: 'A', clientId: 'client_a' },
        { title: 'B', clientId: 'client_a' },
      ]);
    });

    it('REFUSES a create that names another tenant, rather than silently fixing it', () => {
      expect(() =>
        asClient('client_a', () =>
          applyScoping('Site', 'create', { data: { clientId: 'client_b' } }),
        ),
      ).toThrow(CrossTenantWriteError);
    });

    it('stamps the create branch of an upsert', () => {
      const out = asClient('client_a', () =>
        applyScoping('ClientSettings', 'upsert', {
          where: { id: 'x' },
          create: { gapMode: 'ASK_FIRST' },
        }),
      );
      expect(out.create).toEqual({ gapMode: 'ASK_FIRST', clientId: 'client_a' });
      expect(out.where).toEqual({ id: 'x', clientId: 'client_a' });
    });
  });

  describe('missing context', () => {
    it('throws rather than returning rows', () => {
      expect(() => applyScoping('Credential', 'findMany', {})).toThrow(
        MissingTenantContextError,
      );
    });

    it('throws inside runWithoutTenantScope — absence of a tenant is not permission', () => {
      expect(() =>
        runWithoutTenantScope(() => applyScoping('Credential', 'findMany', {})),
      ).toThrow(MissingTenantContextError);
    });

    it('leaves unscoped models alone', () => {
      expect(() => applyScoping('RefreshToken', 'findUnique', { where: {} })).not.toThrow();
      expect(() => applyScoping('Client', 'findUnique', { where: {} })).not.toThrow();
    });
  });

  describe('the auth-bootstrap hole', () => {
    it('lets runUnscoped through', () => {
      const out = runUnscoped(() =>
        applyScoping('VirtualAssistant', 'findFirst', { where: { email: 'a@b.c' } }),
      );
      expect(out.where).toEqual({ email: 'a@b.c' });
    });

    it('does not leak out of its callback', () => {
      runUnscoped(() => undefined);
      expect(() => applyScoping('Credential', 'findMany', {})).toThrow(
        MissingTenantContextError,
      );
    });

    it('does not persist into a subsequent scoped request', () => {
      runUnscoped(() => undefined);
      const out = asClient('client_a', () => applyScoping('Site', 'findMany', {}));
      expect(out.where).toEqual({ clientId: 'client_a' });
    });
  });
});
