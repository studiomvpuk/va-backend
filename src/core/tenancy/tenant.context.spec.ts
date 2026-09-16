import { tenantContext, runWithoutTenantScope, currentTenant } from './tenant.context';
import { MissingTenantContextError } from './errors';
import { TENANT_SCOPED_MODELS } from './tenant-scoped.models';

/**
 * These exercise the scoping decision in isolation from Prisma. The full
 * end-to-end isolation test (two seeded Clients, every list endpoint) arrives
 * with Phase 1 and runs against a real database.
 */
describe('tenant context', () => {
  it('is empty outside a request', () => {
    expect(currentTenant()).toBeUndefined();
  });

  it('carries the tenant through async boundaries', async () => {
    await new Promise<void>((resolve) => {
      tenantContext.run(
        { clientId: 'client_a', actorType: 'CLIENT', actorId: 'u1' },
        () => {
          void (async () => {
            await new Promise((r) => setTimeout(r, 1));
            expect(currentTenant()?.clientId).toBe('client_a');
            resolve();
          })();
        },
      );
    });
  });

  it('keeps two concurrent requests isolated', async () => {
    const seen: string[] = [];
    const run = (id: string, delay: number) =>
      new Promise<void>((resolve) => {
        tenantContext.run(
          { clientId: id, actorType: 'CLIENT', actorId: id },
          () => {
            void (async () => {
              await new Promise((r) => setTimeout(r, delay));
              seen.push(currentTenant()!.clientId!);
              resolve();
            })();
          },
        );
      });

    await Promise.all([run('client_a', 20), run('client_b', 5)]);
    expect(seen.sort()).toEqual(['client_a', 'client_b']);
  });

  it('runWithoutTenantScope has a null clientId, so scoped queries still throw', () => {
    runWithoutTenantScope(() => {
      expect(currentTenant()?.clientId).toBeNull();
    });
  });

  it('every sensitive model is registered', () => {
    for (const m of ['Credential', 'SensitiveValue', 'AuditEvent', 'PrepDocument']) {
      expect(TENANT_SCOPED_MODELS.has(m)).toBe(true);
    }
  });

  it('MissingTenantContextError names the model and how to fix it', () => {
    const e = new MissingTenantContextError('Credential');
    expect(e.message).toMatch(/Credential/);
    expect(e.message).toMatch(/TenantGuard/);
  });
});
