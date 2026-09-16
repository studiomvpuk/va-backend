import { Inject, Injectable } from '@nestjs/common';
import { AppConfigService } from '../../core/config/app-config.service';
import { HTTP_TRANSPORT, type HttpTransport } from '../../ai/providers/transport';
import { TransportFailure } from '../../ai/providers/transport';
import { PermanentDeliveryError } from './notification-channel';
import type { IEmailSender, OutboundEmail } from './email-sender';

const RESEND_API = 'https://api.resend.com/emails';

/**
 * Resend over the same injected HttpTransport the AI providers use.
 *
 * Reusing it is not tidiness: it means this class is tested against a scripted
 * transport with no network, exactly like every provider, and that a 429 here
 * is distinguishable from a 422 without anyone running a live send to find out.
 */
@Injectable()
export class ResendEmailSender implements IEmailSender {
  readonly name = 'resend';

  constructor(
    @Inject(HTTP_TRANSPORT) private readonly transport: HttpTransport,
    private readonly config: AppConfigService,
  ) {}

  async send(email: OutboundEmail): Promise<void> {
    let response;
    try {
      response = await this.transport.send({
        url: RESEND_API,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.get('RESEND_API_KEY') ?? ''}`,
        },
        body: {
          from: this.config.get('EMAIL_FROM'),
          to: [email.to],
          subject: email.subject,
          text: email.text,
          ...(email.html ? { html: email.html } : {}),
        },
      });
    } catch (e) {
      // Network trouble is transient by definition — let the dispatcher retry.
      if (e instanceof TransportFailure) throw new Error(`resend unreachable: ${e.message}`);
      throw e;
    }

    if (response.status >= 200 && response.status < 300) return;

    // 4xx other than 429 means the request itself is wrong — a bad address, an
    // unverified sender, a revoked key. Sending it again changes nothing.
    if (response.status >= 400 && response.status < 500 && response.status !== 429) {
      throw new PermanentDeliveryError('email', `HTTP ${response.status}: ${detail(response.body)}`);
    }
    throw new Error(`resend HTTP ${response.status}: ${detail(response.body)}`);
  }
}

function detail(body: unknown): string {
  const e = body as { message?: string; error?: string };
  return e?.message ?? e?.error ?? (typeof body === 'string' ? body.slice(0, 200) : 'no detail');
}
