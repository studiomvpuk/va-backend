import { Inject, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { AppConfigService } from '../core/config/app-config.service';
import {
  PROVIDER_KEY_REPOSITORY,
  type IProviderKeyRepository,
  type Provider,
} from './provider-key.repository';
import {
  SETTINGS_REPOSITORY,
  type ISettingsRepository,
} from '../settings/settings.repository';

export type BillingMode = 'byok' | 'platform';

export interface ResolvedKey {
  key: string;
  mode: BillingMode;
  provider: Provider;
}

export interface KeyringStatus {
  byokEnabled: boolean;
  providers: {
    provider: Provider;
    /** Which key a request would use right now. */
    mode: BillingMode | 'unavailable';
    configured: boolean;
    hint: string | null;
  }[];
}

/**
 * Decides whose key — and therefore whose bill — a request uses.
 *
 * PRD §5.4: the same codebase runs self-hosted and free, managed and free, or
 * managed and charged, depending only on which key is in play.
 *
 * ── The one decision worth arguing about ─────────────────────────────────────
 * When BYOK is on and the Client's key is missing or rejected, this throws
 * rather than falling back to the platform key.
 *
 * A silent fallback would be the friendlier-looking choice and the wrong one:
 * the Client believes they are paying their own provider, and StudioMVP quietly
 * picks up the bill instead. That is a financial surprise for whoever is
 * running this, discovered at the end of the month. Failing loudly with a
 * message naming the fix costs one interrupted request and no money.
 */
@Injectable()
export class KeyringService {
  constructor(
    @Inject(PROVIDER_KEY_REPOSITORY) private readonly keys: IProviderKeyRepository,
    @Inject(SETTINGS_REPOSITORY) private readonly settings: ISettingsRepository,
    private readonly config: AppConfigService,
  ) {}

  async resolve(provider: Provider): Promise<ResolvedKey> {
    const { byokEnabled } = await this.settings.get();

    if (byokEnabled) {
      const key = await this.keys.read(provider);
      if (!key) {
        throw new UnprocessableEntityException(
          `You have "bring your own API key" switched on, but no ${label(provider)} ` +
            `key is stored. Add one in Settings, or switch BYOK off to use the ` +
            `platform key instead.`,
        );
      }
      return { key, mode: 'byok', provider };
    }

    const platform = this.platformKey(provider);
    if (!platform) {
      throw new UnprocessableEntityException(
        `No ${label(provider)} key is available. Add your own in Settings and ` +
          `switch on "bring your own API key".`,
      );
    }
    return { key: platform, mode: 'platform', provider };
  }

  /** What the dashboard shows: which key is in use, and whose usage is billed. */
  async status(): Promise<KeyringStatus> {
    const [{ byokEnabled }, stored] = await Promise.all([
      this.settings.get(),
      this.keys.status(),
    ]);

    return {
      byokEnabled,
      providers: stored.map((s) => ({
        provider: s.provider,
        configured: s.configured,
        hint: s.hint,
        mode: byokEnabled
          ? s.configured
            ? 'byok'
            : 'unavailable'
          : this.platformKey(s.provider)
            ? 'platform'
            : 'unavailable',
      })),
    };
  }

  private platformKey(provider: Provider): string | undefined {
    return provider === 'ANTHROPIC'
      ? this.config.get('ANTHROPIC_API_KEY')
      : this.config.get('OPENAI_API_KEY');
  }
}

function label(provider: Provider): string {
  return provider === 'ANTHROPIC' ? 'Anthropic' : 'OpenAI';
}
