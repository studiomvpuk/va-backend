import { Injectable, Logger } from '@nestjs/common';
import type { IEmailSender, OutboundEmail } from './email-sender';

/**
 * Development and CI. Logs the subject and recipient, never the body.
 *
 * The body of a knowledge-gap notification quotes the application's question
 * and the answer that was used, which is the Client's own material. It does not
 * belong in a log file just because the environment is a laptop — the Phase 10
 * redaction pass should not have to come back and find this.
 */
@Injectable()
export class ConsoleEmailSender implements IEmailSender {
  readonly name = 'console';
  private readonly logger = new Logger(ConsoleEmailSender.name);

  send(email: OutboundEmail): Promise<void> {
    this.logger.log(`email → ${redactAddress(email.to)}: ${email.subject}`);
    return Promise.resolve();
  }
}

/** a***@example.com — enough to tell which account, not enough to harvest. */
export function redactAddress(address: string): string {
  const at = address.lastIndexOf('@');
  if (at <= 0) return '***';
  return `${address[0]}***${address.slice(at)}`;
}
