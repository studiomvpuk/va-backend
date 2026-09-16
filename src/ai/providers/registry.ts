import type { HttpTransport } from './transport';
import type {
  IEmbedder,
  ITextGenerator,
  ITranscriber,
  IVisionExtractor,
} from './ai-provider.interface';
import { AnthropicProvider } from './anthropic.provider';
import { OpenAiProvider } from './openai.provider';
import { EchoProvider } from './echo.provider';
import type { Provider as BillableProvider } from '../../keyring/provider-key.repository';

/**
 * Every provider implementation that exists.
 *
 * ── Adding one ──────────────────────────────────────────────────────────────
 * Write the class in this directory, add one line to REGISTRY, and you are
 * done. Nothing outside `src/ai/providers/` changes, because callers depend on
 * ITextGenerator rather than on which one — that is PRD §2.4's open/closed
 * claim, and an experiment adding a third provider is what proved this file
 * needed to exist.
 *
 * The one thing that is NOT free: a provider a Client can supply their own key
 * for also needs a `Provider` enum value in schema.prisma and a migration.
 * That is unavoidable — it is a new column value, not a new abstraction — and
 * it is why BillableProvider is a separate, narrower type.
 */
export type ProviderId = 'ANTHROPIC' | 'OPENAI' | 'ECHO';

type ProviderConstructor = new (
  transport: HttpTransport,
  apiKey: string,
) => ITextGenerator | IVisionExtractor | ITranscriber | IEmbedder;

export const REGISTRY: Record<ProviderId, ProviderConstructor> = {
  ANTHROPIC: AnthropicProvider,
  OPENAI: OpenAiProvider,
  ECHO: EchoProvider,
};

/** Providers that need a key, and therefore appear in the keyring. */
const BILLABLE = new Set<string>(['ANTHROPIC', 'OPENAI']);

export function isBillable(id: ProviderId): id is ProviderId & BillableProvider {
  return BILLABLE.has(id);
}
