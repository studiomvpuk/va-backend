/**
 * Thrown when a tenant-scoped model is queried with no tenant in context.
 *
 * This is deliberately an exception and not a silent empty result. A developer
 * who forgets the guard should see a loud failure in development, not a data
 * leak in production.
 */
export class MissingTenantContextError extends Error {
  constructor(model: string) {
    super(
      `Query on tenant-scoped model "${model}" was issued with no tenant context. ` +
        `Add TenantGuard to the route, or wrap the call in runWithoutTenantScope() ` +
        `if it genuinely operates across tenants.`,
    );
    this.name = 'MissingTenantContextError';
  }
}

export class CrossTenantWriteError extends Error {
  constructor(model: string) {
    super(
      `Attempted to write "${model}" with a clientId that does not match the ` +
        `current tenant context.`,
    );
    this.name = 'CrossTenantWriteError';
  }
}
