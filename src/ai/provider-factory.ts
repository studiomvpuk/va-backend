import { Inject, Injectable } from '@nestjs/common';
import { KeyringService } from '../keyring/keyring.service';
import { HTTP_TRANSPORT, type HttpTransport } from './providers/transport';
import { REGISTRY, isBillable, type ProviderId } from './providers/registry';
import type {
  IEmbedder,
  ITextGenerator,
  ITranscriber,
  IVisionExtractor,
} from './providers/ai-provider.interface';

/**
 * Builds a provider around the key that belongs to THIS request's Client.
 *
 * Providers cannot be plain singletons: the API key is per Client and is only
 * known once a tenant is in context, so the DI container cannot construct them
 * at boot. This factory is where that per-request binding happens.
 *
 * It knows nothing about which providers exist — that is registry.ts, inside
 * providers/. This file does not change when one is added.
 */
@Injectable()
export class ProviderFactory {
  constructor(
    private readonly keyring: KeyringService,
    @Inject(HTTP_TRANSPORT) private readonly transport: HttpTransport,
  ) {}

  /** The model that drafts when context is clear (PRD §5.5a). */
  async textGenerator(provider: ProviderId = 'ANTHROPIC'): Promise<ITextGenerator> {
    return (await this.build(provider)) as ITextGenerator;
  }

  async visionExtractor(provider: ProviderId = 'ANTHROPIC'): Promise<IVisionExtractor> {
    return (await this.build(provider)) as IVisionExtractor;
  }

  /**
   * Transcription is OpenAI-only today — Anthropic does not implement
   * ITranscriber, which is exactly why the interfaces are split. Asking a
   * provider for a capability it lacks is a type error, not a runtime throw.
   */
  async transcriber(): Promise<ITranscriber> {
    return (await this.build('OPENAI')) as ITranscriber;
  }

  /**
   * Embeddings for the Q&A bank.
   *
   * Defaults to OPENAI because it is the only provider with a real embeddings
   * endpoint. ECHO is accepted so the flow runs without a key — its vectors are
   * lexical, and the `embeddingModel` tag is what stops them being compared
   * with real ones.
   */
  async embedder(provider: ProviderId = 'OPENAI'): Promise<IEmbedder> {
    return (await this.build(provider)) as IEmbedder;
  }

  /** Which key each provider would use, for the dashboard. */
  async billingStatus() {
    return this.keyring.status();
  }

  private async build(provider: ProviderId) {
    // A provider that needs no key skips the keyring entirely rather than
    // being handed an empty string and hoping.
    const key = isBillable(provider)
      ? (await this.keyring.resolve(provider)).key
      : '';
    return new REGISTRY[provider](this.transport, key);
  }
}
