import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { BullMqQueue } from './bullmq.queue';
import { InProcessQueue } from './in-process.queue';
import { JobRegistry } from './job-registry';
import { JOB_QUEUE, type IJobQueue } from './job-queue';

/**
 * Which queue is real is decided once, at boot, by whether REDIS_URL is set.
 *
 * Not per call, and not by a flag a caller can pass. A call site that could
 * choose would eventually choose the in-process one in production to avoid a
 * Redis dependency, and the failure that follows is a job lost on deploy with
 * nothing in the logs to say so.
 */
const queueProvider = {
  provide: JOB_QUEUE,
  inject: [AppConfigService],
  useFactory: (config: AppConfigService): IJobQueue => {
    const url = config.get('REDIS_URL');
    return url ? new BullMqQueue({ url }) : new InProcessQueue();
  },
};

@Injectable()
export class JobRegistrar implements OnApplicationBootstrap {
  private readonly logger = new Logger(JobRegistrar.name);

  constructor(
    @Inject(JOB_QUEUE) private readonly queue: IJobQueue,
    private readonly registry: JobRegistry,
  ) {}

  onApplicationBootstrap(): void {
    const map = this.registry.asMap();

    if (this.queue instanceof BullMqQueue) {
      this.queue.startWorker(map);
      this.logger.log(`Redis-backed queue, ${map.size} handler(s)`);
      return;
    }

    if (this.queue instanceof InProcessQueue) {
      for (const [name, handle] of map) {
        this.queue.register(name, handle);
      }
      // Said out loud at every boot, because "why did that job vanish when I
      // redeployed" is a much worse thing to work out later.
      this.logger.warn(
        `No REDIS_URL — running ${map.size} handler(s) in process. Jobs are not durable.`,
      );
    }
  }
}

@Global()
@Module({
  // AppConfigModule is @Global, so nothing to import.
  providers: [queueProvider, JobRegistry, JobRegistrar],
  exports: [JOB_QUEUE, JobRegistry],
})
export class JobsModule {}
