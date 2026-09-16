import { Global, Module } from '@nestjs/common';
import { RATE_LIMIT_STORE } from './rate-limit.store';
import { MemoryRateLimitStore } from './memory-rate-limit.store';
import { RateLimitService } from './rate-limit.service';

@Global()
@Module({
  providers: [
    { provide: RATE_LIMIT_STORE, useClass: MemoryRateLimitStore },
    RateLimitService,
  ],
  exports: [RateLimitService, RATE_LIMIT_STORE],
})
export class RateLimitModule {}
