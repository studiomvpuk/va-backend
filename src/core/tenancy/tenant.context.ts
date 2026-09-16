import { AsyncLocalStorage } from 'node:async_hooks';

export type ActorType = 'CLIENT' | 'VA' | 'SYSTEM';

/**
 * Mutable by design — see tenant.middleware.ts for why.
 */
export interface TenantStore {
  /** The Client account every query in this request is scoped to. */
  clientId: string | null;
  /** Who is acting: the Client themselves, or one of their VAs. */
  actorType: ActorType | null;
  actorId: string | null;
  /**
   * Suspends tenant scoping. See runUnscoped() — this is the one hole in the
   * isolation mechanism and it is deliberately awkward to open.
   */
  unscoped?: boolean;
  /** Why scoping was suspended, for the log and for whoever reads this later. */
  unscopedReason?: string;
}

/**
 * Request-scoped tenant context.
 *
 * AsyncLocalStorage rather than a request-scoped Nest provider, because the
 * Prisma client extension needs to read this from deep inside the query
 * pipeline where the DI container is not reachable.
 */
export const tenantContext = new AsyncLocalStorage<TenantStore>();

export function currentTenant(): TenantStore | undefined {
  return tenantContext.getStore();
}

/**
 * Runs with no tenant. Queries on tenant-scoped models still THROW.
 *
 * For work that touches only unscoped models — a health check, the refresh-token
 * table, a migration. It is not an escape hatch; it is the absence of a tenant.
 */
export function runWithoutTenantScope<T>(fn: () => T): T {
  return tenantContext.run(
    { clientId: null, actorType: 'SYSTEM', actorId: 'system' },
    fn,
  );
}

/**
 * THE ONE HOLE IN TENANT ISOLATION. Read this before using it.
 *
 * Suspends scoping so a tenant-scoped model can be queried across tenants.
 * There is exactly one legitimate reason for this in the product: authentication
 * has to find an account before it can know which tenant that account belongs
 * to. A VA's email is what tells you their Client; you cannot scope the lookup
 * by the thing the lookup exists to discover.
 *
 * Everything else that feels like it needs this does not. If a Client route
 * "needs" cross-tenant data, that is a bug in the route.
 *
 * Calls are restricted by an architecture test to a named allowlist of files
 * (test/architecture/unscoped-access.spec.ts). Adding a call site means editing
 * that allowlist, which means someone reviews it. That is the entire point.
 *
 * @param reason Short, specific, and written for whoever finds this in a log.
 */
export function runUnscoped<T>(fn: () => T, reason = 'auth bootstrap'): T {
  const parent = tenantContext.getStore();
  return tenantContext.run(
    {
      clientId: parent?.clientId ?? null,
      actorType: parent?.actorType ?? 'SYSTEM',
      actorId: parent?.actorId ?? 'system',
      unscoped: true,
      unscopedReason: reason,
    },
    fn,
  );
}
