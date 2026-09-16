import { Injectable } from '@nestjs/common';
import * as argon2 from '@node-rs/argon2';
import type { IPasswordHasher } from './password.interface';

/**
 * Argon2id — the OWASP-recommended default for password storage.
 *
 * Parameters follow OWASP's second configuration (19 MiB, t=2, p=1). Memory
 * cost is the setting that matters against GPU attack; iteration count is the
 * cheaper knob.
 *
 * @node-rs/argon2 is used rather than the `argon2` package because it ships
 * prebuilt binaries — no node-gyp, no compiler on the deploy image, and an
 * install measured in seconds rather than minutes.
 */
const MEMORY_COST = 19456; // KiB
const TIME_COST = 2;
const PARALLELISM = 1;

const OPTIONS: argon2.Options = {
  algorithm: argon2.Algorithm.Argon2id,
  memoryCost: MEMORY_COST,
  timeCost: TIME_COST,
  parallelism: PARALLELISM,
};

/** `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>` */
const ENCODED = /^\$argon2(id|i|d)\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$/;

@Injectable()
export class Argon2Hasher implements IPasswordHasher {
  async hash(plaintext: string): Promise<string> {
    return argon2.hash(plaintext, OPTIONS);
  }

  async verify(hash: string, plaintext: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plaintext, OPTIONS);
    } catch {
      // A malformed or truncated hash is a failed login, not a 500. Returning
      // false keeps the response identical to a wrong password.
      return false;
    }
  }

  /**
   * True when the stored hash used weaker parameters than current policy.
   *
   * This library exposes no equivalent, so the encoded hash is parsed directly.
   * Only *weaker* counts: a hash made with more memory or more iterations than
   * policy is already better than what we would produce, and rehashing it
   * downward would be a downgrade.
   */
  needsRehash(hash: string): boolean {
    const match = ENCODED.exec(hash);
    // Unparseable, or not argon2id, means it did not come from current policy.
    if (!match || match[1] !== 'id') return true;

    const [, , , memory, time, parallelism] = match;
    return (
      Number(memory) < MEMORY_COST ||
      Number(time) < TIME_COST ||
      Number(parallelism) < PARALLELISM
    );
  }
}
