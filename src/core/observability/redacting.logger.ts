import { ConsoleLogger, Injectable, type LogLevel } from '@nestjs/common';
import { redact, redactString } from './redact';

/**
 * The formatter that PRD §7.3 requires: "Logging redaction is enforced by a
 * formatter, not by developers remembering."
 *
 * It is installed as the application-wide logger, so it is not something a call
 * site opts into. Every `this.logger.log(...)` in the codebase, every framework
 * message, and every unhandled exception Nest reports goes through it. There is
 * no second logger to reach for, and `console.log` is banned by lint.
 */
@Injectable()
export class RedactingLogger extends ConsoleLogger {
  log(message: unknown, ...rest: unknown[]): void {
    super.log(redact(message), ...this.clean(rest));
  }

  error(message: unknown, ...rest: unknown[]): void {
    super.error(redact(message), ...this.clean(rest));
  }

  warn(message: unknown, ...rest: unknown[]): void {
    super.warn(redact(message), ...this.clean(rest));
  }

  debug(message: unknown, ...rest: unknown[]): void {
    super.debug(redact(message), ...this.clean(rest));
  }

  verbose(message: unknown, ...rest: unknown[]): void {
    super.verbose(redact(message), ...this.clean(rest));
  }

  fatal(message: unknown, ...rest: unknown[]): void {
    super.fatal(redact(message), ...this.clean(rest));
  }

  /**
   * Nest passes the context as a trailing string, and error() passes a stack
   * as the first of the rest. Both are redacted the same way — a stack trace is
   * one of the likelier places for a secret to surface, because a thrown value
   * gets stringified into it.
   */
  private clean(rest: unknown[]): unknown[] {
    return rest.map((item) => (typeof item === 'string' ? redactString(item) : redact(item)));
  }
}

/** The levels a production process should emit. `debug` and `verbose` are noise there. */
export const PRODUCTION_LOG_LEVELS: LogLevel[] = ['log', 'warn', 'error', 'fatal'];
