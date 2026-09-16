import type { NotificationView } from '../notification.types';

/**
 * Somewhere a notification can be sent that is NOT the in-app list.
 *
 * The in-app row is deliberately not a channel. It is the durable record —
 * written first, inside the caller's transaction, and if it fails the whole
 * operation fails. Channels are what happens afterwards, and every one of them
 * is allowed to fail without taking anything else down with it.
 */
export interface ChannelPayload {
  notification: NotificationView;
  urgent: boolean;
  /** Where the Client's copy of this notification lives. */
  clientEmail: string;
}

export interface INotificationChannel {
  readonly channel: string;

  /**
   * Whether this channel should carry THIS notification for THIS Client.
   *
   * Two separate questions collapsed into one on purpose: "has the Client
   * configured it" and "does this notification clear the bar for it". A channel
   * that answers false is not an error and is not retried — it simply is not
   * used, which is what makes "email only for urgent things" a property of the
   * channel rather than a condition every call site has to remember.
   */
  shouldSend(payload: ChannelPayload): Promise<boolean>;

  send(payload: ChannelPayload): Promise<void>;
}

/**
 * Multi-provider token: every channel registers against it, and the dispatcher
 * injects the array. Adding WhatsApp in Phase 10 is one more provider entry and
 * no change to the dispatcher, the service, or any caller.
 */
export const NOTIFICATION_CHANNELS = Symbol('NOTIFICATION_CHANNELS');

/**
 * A failure that will still be a failure on the third attempt.
 *
 * Retrying a malformed address or a rejected recipient burns time and, on a
 * metered provider, money. Anything not thrown as this is assumed transient —
 * failing toward one wasted retry is cheaper than failing toward a notification
 * silently dropped because a timeout was misclassified as permanent.
 */
export class PermanentDeliveryError extends Error {
  constructor(
    readonly channel: string,
    message: string,
  ) {
    super(`${channel}: ${message}`);
    this.name = 'PermanentDeliveryError';
  }
}
