import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../core/persistence/prisma.service';
import { toBytes } from '../core/persistence/bytes';
import { currentTenant } from '../core/tenancy/tenant.context';
import {
  CREDENTIAL_CIPHER,
  type ICredentialCipher,
} from '../core/crypto/cipher.interface';
import type {
  IProviderKeyRepository,
  Provider,
  ProviderKeyStatus,
} from './provider-key.repository';
import type { CipherEnvelope } from '../core/crypto/cipher.interface';

const PROVIDERS: Provider[] = ['ANTHROPIC', 'OPENAI'];

@Injectable()
export class PrismaProviderKeyRepository implements IProviderKeyRepository {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CREDENTIAL_CIPHER) private readonly cipher: ICredentialCipher,
  ) {}

  async put(
    provider: Provider,
    envelope: CipherEnvelope,
    hint: string,
  ): Promise<void> {
    const clientId = this.requireTenant();
    const data = {
      ciphertext: toBytes(envelope.ciphertext),
      iv: toBytes(envelope.iv),
      authTag: toBytes(envelope.authTag),
      keyVersion: envelope.keyVersion,
      hint,
    };
    await this.prisma.client.providerKey.upsert({
      where: { clientId_provider: { clientId, provider } },
      create: { clientId, provider, ...data },
      update: data,
    });
  }

  async remove(provider: Provider): Promise<void> {
    await this.prisma.client.providerKey.deleteMany({ where: { provider } });
  }

  async status(): Promise<ProviderKeyStatus[]> {
    // Selects the hint, never the ciphertext.
    const rows = (await this.prisma.client.providerKey.findMany({
      select: { provider: true, hint: true, updatedAt: true },
    })) as { provider: Provider; hint: string; updatedAt: Date }[];

    const byProvider = new Map(rows.map((r) => [r.provider, r]));
    return PROVIDERS.map((provider) => {
      const row = byProvider.get(provider);
      return {
        provider,
        configured: row !== undefined,
        hint: row?.hint ?? null,
        updatedAt: row?.updatedAt ?? null,
      };
    });
  }

  async read(provider: Provider): Promise<string | null> {
    const row = (await this.prisma.client.providerKey.findFirst({
      where: { provider },
      select: { ciphertext: true, iv: true, authTag: true, keyVersion: true },
    })) as {
      ciphertext: Uint8Array;
      iv: Uint8Array;
      authTag: Uint8Array;
      keyVersion: number;
    } | null;
    if (!row) return null;

    return this.cipher.decrypt({
      ciphertext: Buffer.from(row.ciphertext),
      iv: Buffer.from(row.iv),
      authTag: Buffer.from(row.authTag),
      keyVersion: row.keyVersion,
    });
  }

  private requireTenant(): string {
    const clientId = currentTenant()?.clientId;
    if (!clientId) throw new Error('No tenant context for a provider key operation');
    return clientId;
  }
}
