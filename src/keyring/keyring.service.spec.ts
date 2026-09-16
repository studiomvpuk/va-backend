import { UnprocessableEntityException } from '@nestjs/common';
import { KeyringService } from './keyring.service';
import type {
  IProviderKeyRepository,
  Provider,
  ProviderKeyStatus,
} from './provider-key.repository';
import type {
  ClientSettingsView,
  ISettingsRepository,
} from '../settings/settings.repository';
import type { AppConfigService } from '../core/config/app-config.service';

class FakeKeys implements IProviderKeyRepository {
  stored = new Map<Provider, string>();
  async put() {}
  async remove() {}
  async status(): Promise<ProviderKeyStatus[]> {
    return (['ANTHROPIC', 'OPENAI'] as Provider[]).map((provider) => ({
      provider,
      configured: this.stored.has(provider),
      hint: this.stored.get(provider)?.slice(-4) ?? null,
      updatedAt: this.stored.has(provider) ? new Date() : null,
    }));
  }
  async read(provider: Provider) {
    return this.stored.get(provider) ?? null;
  }
}

class FakeSettings implements ISettingsRepository {
  view: ClientSettingsView = {
    minFitScore: 6,
    gapMode: 'GUESS_AND_PROCEED',
    byokEnabled: false,
    whatsappEnabled: false,
  };
  async get() {
    return this.view;
  }
  async update(changes: Partial<ClientSettingsView>) {
    Object.assign(this.view, changes);
    return this.view;
  }
}

const config = (platform: Record<string, string | undefined>) =>
  ({ get: (k: string) => platform[k] }) as unknown as AppConfigService;

describe('KeyringService', () => {
  let keys: FakeKeys;
  let settings: FakeSettings;

  beforeEach(() => {
    keys = new FakeKeys();
    settings = new FakeSettings();
  });

  const service = (platform: Record<string, string | undefined> = {}) =>
    new KeyringService(keys, settings, config(platform));

  describe('BYOK off', () => {
    it('uses the platform key and reports platform billing', async () => {
      const resolved = await service({ ANTHROPIC_API_KEY: 'sk-platform' }).resolve(
        'ANTHROPIC',
      );
      expect(resolved).toEqual({
        key: 'sk-platform',
        mode: 'platform',
        provider: 'ANTHROPIC',
      });
    });

    it('ignores a stored Client key — BYOK off means the platform pays', async () => {
      keys.stored.set('ANTHROPIC', 'sk-client-key');
      const resolved = await service({ ANTHROPIC_API_KEY: 'sk-platform' }).resolve(
        'ANTHROPIC',
      );
      expect(resolved.key).toBe('sk-platform');
    });

    it('fails with an actionable message when no platform key is configured', async () => {
      await expect(service().resolve('OPENAI')).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
      const message = await service()
        .resolve('OPENAI')
        .catch((e: Error) => e.message);
      expect(message).toMatch(/OpenAI/);
      expect(message).toMatch(/Settings/);
    });
  });

  describe('BYOK on', () => {
    beforeEach(() => {
      settings.view.byokEnabled = true;
    });

    it('uses the Client’s key and reports BYOK', async () => {
      keys.stored.set('OPENAI', 'sk-client-key');
      const resolved = await service({ OPENAI_API_KEY: 'sk-platform' }).resolve('OPENAI');
      expect(resolved).toEqual({
        key: 'sk-client-key',
        mode: 'byok',
        provider: 'OPENAI',
      });
    });

    /**
     * The decision worth defending: no silent fallback.
     */
    it('REFUSES to fall back to the platform key when the Client key is missing', async () => {
      const platform = { ANTHROPIC_API_KEY: 'sk-platform' };
      await expect(service(platform).resolve('ANTHROPIC')).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
    });

    it('says exactly what to do about it', async () => {
      const message = await service({ ANTHROPIC_API_KEY: 'sk-platform' })
        .resolve('ANTHROPIC')
        .catch((e: Error) => e.message);
      expect(message).toMatch(/no Anthropic key is stored/i);
      expect(message).toMatch(/switch BYOK off/i);
    });

    it('resolves per provider — one key missing does not block the other', async () => {
      keys.stored.set('ANTHROPIC', 'sk-anthropic-client');
      await expect(service().resolve('ANTHROPIC')).resolves.toMatchObject({
        mode: 'byok',
      });
      await expect(service().resolve('OPENAI')).rejects.toThrow();
    });
  });

  describe('status', () => {
    it('reports which key each provider would use right now', async () => {
      keys.stored.set('ANTHROPIC', 'sk-client-abcd');
      settings.view.byokEnabled = true;

      const status = await service({ OPENAI_API_KEY: 'sk-platform' }).status();

      expect(status.byokEnabled).toBe(true);
      expect(status.providers).toEqual([
        { provider: 'ANTHROPIC', configured: true, hint: 'abcd', mode: 'byok' },
        // BYOK is on and no Client key is stored, so this one cannot run —
        // reporting "platform" here would be the silent fallback in disguise.
        { provider: 'OPENAI', configured: false, hint: null, mode: 'unavailable' },
      ]);
    });

    it('reports platform mode when BYOK is off and a platform key exists', async () => {
      const status = await service({
        ANTHROPIC_API_KEY: 'sk-a',
        OPENAI_API_KEY: 'sk-o',
      }).status();
      expect(status.providers.every((p) => p.mode === 'platform')).toBe(true);
    });

    it('never returns a key or ciphertext', async () => {
      keys.stored.set('ANTHROPIC', 'sk-client-secret-value');
      const payload = JSON.stringify(await service().status());
      expect(payload).not.toContain('sk-client-secret-value');
      expect(payload).not.toContain('ciphertext');
    });
  });
});
