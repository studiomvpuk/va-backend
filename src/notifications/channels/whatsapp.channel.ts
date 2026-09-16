import { Inject, Injectable } from '@nestjs/common';
import { AppConfigService } from '../../core/config/app-config.service';
import { HTTP_TRANSPORT, TransportFailure, type HttpTransport } from '../../ai/providers/transport';
import { PrismaService } from '../../core/persistence/prisma.service';
import { currentTenant } from '../../core/tenancy/tenant.context';
import {
  PermanentDeliveryError,
  type ChannelPayload,
  type INotificationChannel,
} from './notification-channel';

const GRAPH_API = 'https://graph.facebook.com/v21.0';

/**
 * WhatsApp Business, the third channel — and the whole payoff of Phase 7's
 * interface.
 *
 * Adding it is this file plus one entry in the channel array. No caller
 * changed, the dispatcher did not change, and its retry and isolation come free
 * because they belong to the dispatcher rather than to any channel.
 *
 * ── Why the message is a template, not free text ────────────────────────────
 * WhatsApp only permits a business to open a conversation with an approved
 * template; free-form text is allowed for 24 hours after the person last
 * replied, and not before. A notification almost always arrives outside that
 * window, so this always sends the template. It is not a limitation being
 * worked around — the template is what the recipient agreed to receive.
 */
@Injectable()
export class WhatsAppChannel implements INotificationChannel {
  readonly channel = 'whatsapp';

  constructor(
    @Inject(HTTP_TRANSPORT) private readonly transport: HttpTransport,
    private readonly config: AppConfigService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Urgent only, and only if the Client turned it on and gave a number.
   *
   * A stricter bar than email, deliberately. WhatsApp arrives on a phone with a
   * notification sound; a Client who gets one for every application will mute
   * the channel, and then the one message that mattered is muted too.
   */
  async shouldSend(payload: ChannelPayload): Promise<boolean> {
    if (!payload.urgent) return false;
    if (!this.configured) return false;

    const settings = await this.settings();
    return settings.whatsappEnabled && isPlausibleNumber(settings.whatsappNumber);
  }

  async send(payload: ChannelPayload): Promise<void> {
    const settings = await this.settings();
    const to = normaliseNumber(settings.whatsappNumber ?? '');

    if (!isPlausibleNumber(to)) {
      throw new PermanentDeliveryError(this.channel, 'no usable number');
    }

    const phoneNumberId = this.config.get('WHATSAPP_PHONE_NUMBER_ID');
    let response;
    try {
      response = await this.transport.send({
        url: `${GRAPH_API}/${phoneNumberId ?? ''}/messages`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.get('WHATSAPP_ACCESS_TOKEN') ?? ''}`,
        },
        body: {
          messaging_product: 'whatsapp',
          to,
          type: 'template',
          template: {
            name: this.config.get('WHATSAPP_TEMPLATE_NAME'),
            language: { code: 'en_GB' },
            components: [
              {
                type: 'body',
                // Two parameters, and neither is the answer or any profile
                // value. WhatsApp messages sit unencrypted on Meta's servers
                // before delivery and on the recipient's phone afterwards, so
                // this says what is waiting and where — never what it contains.
                parameters: [
                  { type: 'text', text: truncate(payload.notification.title, 60) },
                  { type: 'text', text: this.link(payload) },
                ],
              },
            ],
          },
        },
      });
    } catch (e) {
      if (e instanceof TransportFailure) throw new Error(`whatsapp unreachable: ${e.message}`);
      throw e;
    }

    if (response.status >= 200 && response.status < 300) return;

    // A 4xx other than 429 is the request being wrong — an unregistered number,
    // an unapproved template, a revoked token. Retrying changes nothing.
    if (response.status >= 400 && response.status < 500 && response.status !== 429) {
      throw new PermanentDeliveryError(
        this.channel,
        `HTTP ${response.status}: ${detail(response.body)}`,
      );
    }
    throw new Error(`whatsapp HTTP ${response.status}: ${detail(response.body)}`);
  }

  private get configured(): boolean {
    // All three or none: a token without a phone number id sends nothing and a
    // template name is required to send at all.
    return Boolean(
      this.config.get('WHATSAPP_ACCESS_TOKEN') &&
        this.config.get('WHATSAPP_PHONE_NUMBER_ID') &&
        this.config.get('WHATSAPP_TEMPLATE_NAME'),
    );
  }

  private link(payload: ChannelPayload): string {
    return `${this.config.webOrigin}${payload.notification.linkPath ?? ''}`;
  }

  private async settings(): Promise<{ whatsappEnabled: boolean; whatsappNumber: string | null }> {
    const clientId = currentTenant()?.clientId;
    if (!clientId) throw new PermanentDeliveryError(this.channel, 'no tenant in context');

    const row = await this.prisma.client.clientSettings.findFirst({
      select: { whatsappEnabled: true, whatsappNumber: true },
    });
    return row ?? { whatsappEnabled: false, whatsappNumber: null };
  }
}

/** E.164, loosely: a plus, then 8–15 digits. */
export function isPlausibleNumber(value: string | null | undefined): boolean {
  return typeof value === 'string' && /^\+[1-9]\d{7,14}$/.test(normaliseNumber(value));
}

/**
 * People type numbers with spaces, brackets and dashes.
 *
 * Normalised here rather than rejected at the form, because a Client who typed
 * their own number the way they always write it should not have to learn E.164
 * to receive a notification.
 */
export function normaliseNumber(value: string): string {
  const trimmed = value.replace(/[\s()\-.]/g, '');
  return trimmed.startsWith('00') ? `+${trimmed.slice(2)}` : trimmed;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function detail(body: unknown): string {
  const e = body as { error?: { message?: string } };
  return e?.error?.message ?? (typeof body === 'string' ? body.slice(0, 200) : 'no detail');
}
