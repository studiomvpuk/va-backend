/**
 * The seam between "compose an email" and "put it on the wire".
 *
 * EmailChannel decides what a notification says. This decides how it leaves the
 * building. They change for entirely different reasons — copy changes with the
 * product, transport changes with the vendor — so they are separate interfaces
 * and the channel is testable without SMTP.
 */
export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface IEmailSender {
  readonly name: string;
  send(email: OutboundEmail): Promise<void>;
}

export const EMAIL_SENDER = Symbol('EMAIL_SENDER');
