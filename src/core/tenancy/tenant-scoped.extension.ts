import { Prisma } from '@prisma/client';
import { currentTenant } from './tenant.context';
import { MissingTenantContextError, CrossTenantWriteError } from './errors';
import { TENANT_SCOPED_MODELS } from './tenant-scoped.models';

/**
 * Multi-tenant isolation (PRD §2.5).
 *
 * This is the whole reason a Client can never see another Client's data. It is
 * NOT a `where` clause that every developer has to remember — it is applied to
 * every operation on every tenant-scoped model, and a query issued with no
 * tenant in context throws rather than returning rows.
 *
 * The failure mode is therefore an exception in development, never a leak in
 * production.
 */

const READ_OPS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);

const MUTATE_OPS = new Set([
  'update',
  'updateMany',
  'delete',
  'deleteMany',
  'upsert',
]);

const CREATE_OPS = new Set(['create', 'createMany', 'createManyAndReturn']);

export const tenantScopedExtension = Prisma.defineExtension({
  name: 'tenant-scoped',
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        if (!model || !TENANT_SCOPED_MODELS.has(model)) {
          return query(args);
        }

        const tenant = currentTenant();

        // The auth-bootstrap hole. Narrow, named, and restricted to an
        // allowlist of call sites by an architecture test.
        if (tenant?.unscoped) return query(args);

        if (!tenant || !tenant.clientId) {
          throw new MissingTenantContextError(model);
        }
        const { clientId } = tenant;

        // Reads and mutations: constrain to this tenant, always.
        if (READ_OPS.has(operation) || MUTATE_OPS.has(operation)) {
          const a = args as { where?: Record<string, unknown> };
          a.where = { ...(a.where ?? {}), clientId };
        }

        // Creates: stamp the tenant, and reject an explicit mismatch outright
        // rather than silently overwriting it — a mismatch means the caller
        // believed something false, and that is worth surfacing.
        if (CREATE_OPS.has(operation)) {
          const a = args as { data?: Record<string, unknown> | Record<string, unknown>[] };
          const stamp = (row: Record<string, unknown>) => {
            if (row.clientId !== undefined && row.clientId !== clientId) {
              throw new CrossTenantWriteError(model);
            }
            row.clientId = clientId;
            return row;
          };
          if (Array.isArray(a.data)) a.data.forEach(stamp);
          else if (a.data) stamp(a.data);
        }

        // upsert carries both a where and a create payload.
        if (operation === 'upsert') {
          const a = args as { create?: Record<string, unknown> };
          if (a.create) a.create.clientId = clientId;
        }

        return query(args);
      },
    },
  },
});
