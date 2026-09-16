import { EmailChannel, isPlausibleAddress } from './email.channel';
import { ConsoleEmailSender, redactAddress } from './console-email-sender';
import { PermanentDeliveryError } from './notification-channel';
import type { IEmailSender, OutboundEmail } from './email-sender';
import type { AppConfigService } from '../../core/config/app-config.service';
import type { ChannelPayload } from './notification-channel';
import type { NotificationView } from '../notification.types';

class RecordingSender implements IEmailSender {
  readonly name = 'recording';
  readonly sent: OutboundEmail[] = [];
  send(email: OutboundEmail): Promise<void> {
    this.sent.push(email);
    return Promise.resolve();
  }
}

const config = { webOrigin: 'https://app.example.com' } as AppConfigService;

function payload(overrides: Partial<ChannelPayload> = {}): ChannelPayload {
  const notification: NotificationView = {
    id: 'n1',
    kind: 'KNOWLEDGE_GAP',
    title: 'A question needs your answer',
    body: 'Sky Capital asked about your notice period.',
    linkPath: '/dashboard#gap-1',
    readAt: null,
    createdAt: new Date(),
  };
  return {
    notification,
    urgent: true,
    clientEmail: 'client@example.com',
    ...overrides,
  };
}

describe('EmailChannel', () => {
  it('sends when something is waiting on the Client', async () => {
    const sender = new RecordingSender();
    await expect(new EmailChannel(sender, config).shouldSend(payload())).resolves.toBe(true);
  });

  it('stays silent for routine notifications', async () => {
    // The Client hired a VA to stop doing this. An email per application would
    // recreate the inbox they were escaping, and a muted channel then loses the
    // one message that mattered.
    const channel = new EmailChannel(new RecordingSender(), config);
    await expect(channel.shouldSend(payload({ urgent: false }))).resolves.toBe(false);
  });

  it('declines rather than fails when there is no address', async () => {
    const channel = new EmailChannel(new RecordingSender(), config);
    await expect(channel.shouldSend(payload({ clientEmail: '' }))).resolves.toBe(false);
  });

  it('throws a permanent error if sent an unusable address anyway', async () => {
    const channel = new EmailChannel(new RecordingSender(), config);
    await expect(channel.send(payload({ clientEmail: 'not-an-address' }))).rejects.toBeInstanceOf(
      PermanentDeliveryError,
    );
  });

  it('builds an absolute link from the notification path', async () => {
    const sender = new RecordingSender();
    await new EmailChannel(sender, config).send(payload());

    expect(sender.sent[0].text).toContain('https://app.example.com/dashboard#gap-1');
    expect(sender.sent[0].subject).toBe('A question needs your answer');
  });

  it('carries no application content beyond the notification body', async () => {
    // Email leaves our control the moment it is sent. It gets forwarded,
    // indexed, and sits on a third party's disk.
    const sender = new RecordingSender();
    await new EmailChannel(sender, config).send(payload());

    const body = sender.sent[0].text;
    expect(body).toContain('Sky Capital asked about your notice period.');
    expect(body).not.toMatch(/password|credential|api[_ -]?key/i);
  });
});

describe('isPlausibleAddress', () => {
  it.each(['a@b.co', 'first.last+tag@sub.example.co.uk', 'ünicode@example.com'])(
    'accepts %s',
    (address) => expect(isPlausibleAddress(address)).toBe(true),
  );

  it.each(['', 'no-at-sign', '@example.com', 'two@@example.com', 'a b@example.com', 'a@'])(
    'rejects %s',
    (address) => expect(isPlausibleAddress(address)).toBe(false),
  );
});

describe('ConsoleEmailSender', () => {
  it('never logs the body', async () => {
    const logged: string[] = [];
    const sender = new ConsoleEmailSender();
    jest
      .spyOn(sender['logger'], 'log')
      .mockImplementation((message: unknown) => logged.push(String(message)));

    await sender.send({
      to: 'client@example.com',
      subject: 'A question needs your answer',
      text: 'Sky Capital asked about your notice period.',
    });

    expect(logged.join('\n')).not.toContain('notice period');
    expect(logged.join('\n')).not.toContain('client@example.com');
  });
});

describe('redactAddress', () => {
  it('keeps the domain and the first character only', () => {
    expect(redactAddress('client@example.com')).toBe('c***@example.com');
  });

  it('gives up entirely rather than half-revealing something odd', () => {
    expect(redactAddress('@example.com')).toBe('***');
    expect(redactAddress('nonsense')).toBe('***');
  });
});
