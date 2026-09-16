import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from './env.schema';

/**
 * Typed accessor over the validated environment.
 *
 * Services depend on this rather than reading process.env directly, so that the
 * set of configuration a module actually uses is visible in its constructor.
 */
@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService<Env, true>) {}

  get<K extends keyof Env>(key: K): Env[K] {
    return this.config.get(key, { infer: true });
  }

  get isProduction(): boolean {
    return this.get('NODE_ENV') === 'production';
  }

  get isDevelopment(): boolean {
    return this.get('NODE_ENV') === 'development';
  }

  /** Where the web app lives. Used to turn a notification's linkPath into a URL. */
  get webOrigin(): string {
    return this.get('WEB_ORIGIN');
  }

  /** Raw 32-byte master key. Only CryptoModule should ever call this. */
  get encryptionKey(): Buffer {
    return Buffer.from(this.get('ENCRYPTION_KEY'), 'base64');
  }
}
