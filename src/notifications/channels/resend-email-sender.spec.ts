import { ResendEmailSender } from './resend-email-sender';
import { PermanentDeliveryError } from './notification-channel';
import { ScriptedTransport } from '../../ai/providers/provider-contract';
import { TransportFailure } from '../../ai/providers/transport';
import type { AppConfigService } from '../../core/config/app-config.service';

const config = {
  get: (key: string) =>
    key === 'RESEND_API_KEY' ? 'test-key' : key === 'EMAIL_FROM' ? 'bot@example.com' : undefined,
} as unknown as AppConfigService;

const email = { to: 'client@example.com', subject: 'Subject', text: 'Body' };

describe('ResendEmailSender', () => {
  it('resolves on a 2xx', async () => {
    const transport = new ScriptedTransport([{ status: 200, body: { id: 'sent' } }]);
    await expect(new ResendEmailSender(transport, config).send(email)).resolves.toBeUndefined();
  });

  it('sends from the configured address and authenticates with the key', async () => {
    const transport = new ScriptedTransport([{ status: 200, body: {} }]);
    await new ResendEmailSender(transport, config).send(email);

    const sent = transport.sent[0];
    expect(sent.headers.authorization).toBe('Bearer test-key');
    expect(JSON.stringify(sent.body)).toContain('bot@example.com');
  });

  it('treats a 4xx as permanent — retrying a rejected recipient changes nothing', async () => {
    const transport = new ScriptedTransport([
      { status: 422, body: { message: 'Invalid `to` field' } },
    ]);
    await expect(
      new ResendEmailSender(transport, config).send(email),
    ).rejects.toBeInstanceOf(PermanentDeliveryError);
  });

  it('treats a 429 as transient, unlike the rest of the 4xx range', async () => {
    const transport = new ScriptedTransport([{ status: 429, body: { message: 'slow down' } }]);
    const error = await new ResendEmailSender(transport, config).send(email).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PermanentDeliveryError);
  });

  it('treats a 5xx as transient', async () => {
    const transport = new ScriptedTransport([{ status: 503, body: 'unavailable' }]);
    const error = await new ResendEmailSender(transport, config).send(email).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(PermanentDeliveryError);
  });

  it('treats an unreachable host as transient', async () => {
    const transport = new ScriptedTransport([], [], new TransportFailure('ECONNRESET'));
    const error = await new ResendEmailSender(transport, config).send(email).catch((e: unknown) => e);

    expect(error).not.toBeInstanceOf(PermanentDeliveryError);
    expect((error as Error).message).toContain('resend unreachable');
  });
});
