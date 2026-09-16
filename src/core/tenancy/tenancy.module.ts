import { Global, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { TenantGuard } from './tenant.guard';
import { TenantContextMiddleware } from './tenant.middleware';

@Global()
@Module({
  providers: [TenantGuard, TenantContextMiddleware],
  exports: [TenantGuard],
})
export class TenancyModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Every route, without exception. Routes that legitimately operate across
    // tenants use runWithoutTenantScope() explicitly rather than opting out of
    // the middleware — opting out is how a route ends up unscoped by accident.
    consumer.apply(TenantContextMiddleware).forRoutes('*path');
  }
}
