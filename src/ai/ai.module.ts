import { Module } from '@nestjs/common';
import { ProviderFactory } from './provider-factory';
import { FetchTransport } from './providers/fetch-transport';
import { HTTP_TRANSPORT, type HttpTransport } from './providers/transport';
import { SEARCH_PROVIDER } from './providers/ai-provider.interface';
import { BraveSearchProvider } from './providers/brave-search.provider';
import { NoSearchProvider } from './providers/no-search.provider';
import { AppConfigService } from '../core/config/app-config.service';
import { KeyringModule } from '../keyring/keyring.module';
import { SettingsModule } from '../settings/settings.module';

/**
 * The AI seam.
 *
 * Note what is NOT here: no orchestration, no drafting, no scoring. Those are
 * Phase 6 and they consume this. Keeping the seam empty of product logic is
 * what lets it be tested exhaustively against scripted transports while the
 * logic above it is tested against fake generators.
 */
/**
 * Search is bound at boot rather than per request, unlike the model providers.
 *
 * The difference is whose key it is: model keys can be the Client's own (BYOK),
 * so a provider cannot be built until a tenant is in context. Search runs on
 * the operator's key for everyone, so there is nothing per-request about it —
 * and when the key is absent the null object is bound, which means the
 * "no findable company information" path is what runs by default rather than
 * being a branch nobody exercises.
 */
const searchProvider = {
  provide: SEARCH_PROVIDER,
  inject: [AppConfigService, HTTP_TRANSPORT],
  useFactory: (config: AppConfigService, transport: HttpTransport) => {
    const key = config.get('BRAVE_SEARCH_API_KEY');
    return key ? new BraveSearchProvider(transport, key) : new NoSearchProvider();
  },
};

@Module({
  imports: [KeyringModule, SettingsModule],
  providers: [
    /*
     * useFactory, not useClass. FetchTransport's only constructor parameter is
     * a timeout with a default value, and `useClass` makes Nest try to *inject*
     * it — a `number` has no provider token, so the graph fails to resolve.
     * Nest never applies TypeScript default parameters; it always constructs
     * with what it resolved. A factory calls the constructor the ordinary way,
     * so the default applies.
     */
    { provide: HTTP_TRANSPORT, useFactory: () => new FetchTransport() },
    ProviderFactory,
    searchProvider,
  ],
  exports: [ProviderFactory, HTTP_TRANSPORT, SEARCH_PROVIDER],
})
export class AiModule {}
