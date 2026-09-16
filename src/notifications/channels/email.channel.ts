import { Inject, Injectable } from '@nestjs/common';
import { AppConfigService } from '../../core/config/app-config.service';
import { EMAIL_SENDER, type IEmailSender } from './email-sender';
import {
  PermanentDeliveryError,
  type ChannelPayload,
  type INotificationChannel,
} from './notification-channel';

/**
 * Email, and only when something is actually waiting on the Client.
 *
 * PRD §5.6 has the Client hiring a VA precisely so they stop doing this work
 * themselves. An email for every application drafted would recreate the inbox
 * they were trying to escape, and a Client who mutes this channel loses the one
 * message that mattered. So the bar is `urgent` — an application has stopped
 * and cannot continue without them.
 */
@Injectable()
export class EmailChannel implements INotificationChannel {
  readonly channel = 'email';

  constructor(
    @Inject(EMAIL_SENDER) private readonly sender: IEmailSender,
    private readonly config: AppConfigService,
  ) {}

  shouldSend(payload: ChannelPayload): Promise<boolean> {
    return Promise.resolve(payload.urgent && isPlausibleAddress(payload.clientEmail));
  }

  async send(payload: ChannelPayload): Promise<void> {
    if (!isPlausibleAddress(payload.clientEmail)) {
      throw new PermanentDeliveryError(this.channel, 'no usable address');
    }

    await this.sender.send({
      to: payload.clientEmail,
      subject: payload.notification.title,
      text: this.compose(payload),
    });
  }

  /**
   * Plain text, and no application content beyond what the notification itself
   * already says.
   *
   * Email leaves the system's control the moment it is sent — it sits on a mail
   * provider's servers, gets forwarded, gets indexed. So it carries the prompt
   * and the link, never a credential, never a sensitive profile value, and
   * never the answer text itself.
   */
  private compose(payload: ChannelPayload): string {
    const link = payload.notification.linkPath
      ? `${this.config.webOrigin}${payload.notification.linkPath}`
      : this.config.webOrigin;

    return [
      payload.notification.body,
      '',
      `Open it here: ${link}`,
      '',
      'You are getting this because an application is waiting on your answer.',
    ].join('\n');
  }
}

/**
 * Deliberately shallow. A real address is one a mail server accepts; anything
 * stricter here rejects valid addresses (plus-tags, new TLDs, unicode locals)
 * and the Client never finds out why they stopped hearing from us.
 */
export function isPlausibleAddress(address: string): boolean {
  const trimmed = address.trim();
  const at = trimmed.indexOf('@');
  return (
    at > 0 &&
    at === trimmed.lastIndexOf('@') &&
    at < trimmed.length - 1 &&
    !/\s/.test(trimmed)
  );
}
