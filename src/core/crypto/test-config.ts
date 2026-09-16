import type { AppConfigService } from '../config/app-config.service';

/**
 * An AppConfigService good enough to build a cipher with, for tests.
 *
 * Shared rather than rebuilt per spec: three specs each had their own
 * `{ encryptionKey: Buffer.alloc(32) } as never`, and adding a second key to
 * the cipher's constructor broke all three at once. One fake means the next
 * change to that constructor is one edit.
 */
export function cipherConfig(options: {
  key?: Buffer;
  version?: number;
  previous?: string;
  previousVersion?: number;
} = {}): AppConfigService {
  const values: Record<string, unknown> = {
    ENCRYPTION_KEY_VERSION: options.version ?? 1,
    ENCRYPTION_KEY_PREVIOUS: options.previous,
    ENCRYPTION_KEY_PREVIOUS_VERSION: options.previousVersion,
  };

  return {
    encryptionKey: options.key ?? Buffer.alloc(32, 3),
    get: (name: string) => values[name],
  } as unknown as AppConfigService;
}
