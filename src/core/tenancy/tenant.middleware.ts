import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { tenantContext, type TenantStore } from './tenant.context';

/**
 * Establishes the AsyncLocalStorage scope for the whole request.
 *
 * This has to be middleware rather than a guard. Nest's pipeline is
 * middleware -> guards -> interceptors -> handler, and ALS context only
 * survives for the duration of the callback passed to `run()`. Express
 * middleware's `next()` executes the entire remaining chain inside that
 * callback, so a store opened here is visible everywhere downstream. A guard
 * calling `run()` would see its context torn down the moment `canActivate`
 * returned — the classic mistake, and a silent one, because queries would then
 * throw MissingTenantContextError with no obvious cause.
 *
 * The store starts empty. TenantGuard fills it in once the JWT is verified,
 * which is why TenantStore is mutable.
 */
@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  use(_req: Request, _res: Response, next: NextFunction): void {
    const store: TenantStore = { clientId: null, actorType: null, actorId: null };
    tenantContext.run(store, () => next());
  }
}
