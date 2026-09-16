import type { CipherEnvelope } from '../core/crypto/cipher.interface';

/**
 * Providers a Client can store their own key for.
 *
 * Mirrors the Prisma `Provider` enum, and is deliberately NARROWER than the set
 * of implementations that exist: a provider needing no key (a local stub, say)
 * belongs in the implementation registry and not here. Keeping these separate
 * is what stops adding an implementation from reaching into billing.
 */
export type Provider = 'ANTHROPIC' | 'OPENAI';

/** What a route is allowed to know about a stored key. */
export interface ProviderKeyStatus {
  provider: Provider;
  configured: boolean;
  /** Last four characters, so the Client can tell which key is stored. */
  hint: string | null;
  updatedAt: Date | null;
}

/**
 * BYOK storage. Write-only from the outside.
 *
 * `read` exists because Phase 4's keyring must decrypt the key to call the
 * provider — but nothing in the HTTP layer may reach it, and the architecture
 * test enforces that no controller injects this token. The Client who set the
 * key cannot read it back either; if they lose it, they replace it.
 */
export interface IProviderKeyRepository {
  put(provider: Provider, envelope: CipherEnvelope, hint: string): Promise<void>;
  remove(provider: Provider): Promise<void>;
  status(): Promise<ProviderKeyStatus[]>;
  /** Server-side only. Never reachable from a route. */
  read(provider: Provider): Promise<string | null>;
}

export const PROVIDER_KEY_REPOSITORY = Symbol('PROVIDER_KEY_REPOSITORY');
