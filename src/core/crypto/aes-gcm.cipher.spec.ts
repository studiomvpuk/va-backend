import { AesGcmCipher } from './aes-gcm.cipher';
import { cipherConfig } from './test-config';

const config = cipherConfig({ key: Buffer.alloc(32, 3) });

describe('AesGcmCipher', () => {
  const cipher = new AesGcmCipher(config);

  it('round-trips a secret', async () => {
    const envelope = await cipher.encrypt('hunter2-but-longer');
    expect(await cipher.decrypt(envelope)).toBe('hunter2-but-longer');
  });

  it('never produces the same ciphertext twice for the same input', async () => {
    const a = await cipher.encrypt('same input');
    const b = await cipher.encrypt('same input');
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.iv.equals(b.iv)).toBe(false);
  });

  it('rejects a tampered payload', async () => {
    const envelope = await cipher.encrypt('do not modify me');
    envelope.ciphertext[20] ^= 0xff;
    await expect(cipher.decrypt(envelope)).rejects.toThrow(/authentication/);
  });

  it('rejects a tampered auth tag', async () => {
    const envelope = await cipher.encrypt('do not modify me');
    envelope.authTag[0] ^= 0xff;
    await expect(cipher.decrypt(envelope)).rejects.toThrow(/authentication/);
  });

  it('refuses to construct with a short key', () => {
    expect(
      () => new AesGcmCipher(cipherConfig({ key: Buffer.alloc(16) })),
    ).toThrow(/32 bytes/);
  });

  it('does not leak plaintext through the error message', async () => {
    const envelope = await cipher.encrypt('super-secret-value');
    envelope.authTag[0] ^= 0xff;
    await expect(cipher.decrypt(envelope)).rejects.not.toThrow(/super-secret/);
  });
});
