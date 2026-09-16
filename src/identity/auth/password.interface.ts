/**
 * Password hashing seam.
 *
 * Behind an interface because hashing parameters are the kind of thing that
 * needs to change on a security advisory, and because every test that needs a
 * user should not pay 50ms of deliberate KDF cost per fixture.
 */
export interface IPasswordHasher {
  hash(plaintext: string): Promise<string>;
  /** Constant-time. Returns false rather than throwing on a malformed hash. */
  verify(hash: string, plaintext: string): Promise<boolean>;
  /** True when the stored hash used weaker parameters than current policy. */
  needsRehash(hash: string): boolean;
}

export const PASSWORD_HASHER = Symbol('PASSWORD_HASHER');
