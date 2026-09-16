import { redact, redactString } from './redact';

/**
 * The `beforeSend` scrubber PRD Phase 10 asks for.
 *
 * ── Why it does not import Sentry ───────────────────────────────────────────
 * The scrubbing is the part that matters and the part that can be tested; the
 * SDK is a transport. Typing against the shape rather than the package means
 * this file compiles and its tests run with no dependency installed, and it
 * cannot silently stop being exercised because someone removed the package.
 *
 * Wiring it is one line in main.ts, once @sentry/node is installed and
 * SENTRY_DSN is set:
 *
 *   Sentry.init({ dsn, beforeSend: scrubEvent, beforeBreadcrumb: scrubBreadcrumb });
 *
 * ── Why an error reporter needs this more than the logs do ──────────────────
 * Logs stay on infrastructure the operator controls. An error report is sent to
 * a third party, with request headers, local variables from every frame, and
 * whatever was attached as context — which is the single richest collection of
 * secrets the process ever assembles in one place.
 */
export interface SentryLikeEvent {
  message?: string;
  request?: {
    url?: string;
    headers?: Record<string, string>;
    cookies?: Record<string, string> | string;
    data?: unknown;
    query_string?: string;
  };
  extra?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  tags?: Record<string, string>;
  user?: Record<string, unknown>;
  breadcrumbs?: SentryLikeBreadcrumb[];
  exception?: {
    values?: {
      type?: string;
      value?: string;
      stacktrace?: { frames?: { vars?: Record<string, unknown>; filename?: string }[] };
    }[];
  };
}

export interface SentryLikeBreadcrumb {
  message?: string;
  data?: Record<string, unknown>;
}

export function scrubEvent(event: SentryLikeEvent): SentryLikeEvent {
  const scrubbed: SentryLikeEvent = { ...event };

  if (event.message) scrubbed.message = redactString(event.message);

  if (event.request) {
    scrubbed.request = {
      ...event.request,
      ...(event.request.url ? { url: redactString(event.request.url) } : {}),
      ...(event.request.query_string
        ? { query_string: redactString(event.request.query_string) }
        : {}),
      ...(event.request.headers
        ? { headers: redact(event.request.headers) as Record<string, string> }
        : {}),
      // Never sent, in any form. A cookie jar on this product contains the
      // refresh token, which is a live credential rather than a hint of one.
      ...(event.request.cookies !== undefined ? { cookies: {} } : {}),
      ...(event.request.data !== undefined ? { data: redact(event.request.data) } : {}),
    };
  }

  if (event.extra) scrubbed.extra = redact(event.extra) as Record<string, unknown>;
  if (event.contexts) scrubbed.contexts = redact(event.contexts) as Record<string, unknown>;
  if (event.tags) scrubbed.tags = redact(event.tags) as Record<string, string>;

  if (event.user) {
    // Identity is what makes a report actionable; everything else a Client
    // object carries is not worth sending to a third party.
    const { id, email, ...rest } = event.user as { id?: unknown; email?: unknown };
    void rest;
    scrubbed.user = {
      ...(id !== undefined ? { id } : {}),
      ...(email !== undefined ? { email } : {}),
    };
  }

  if (event.breadcrumbs) scrubbed.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb);

  if (event.exception?.values) {
    scrubbed.exception = {
      values: event.exception.values.map((value) => ({
        ...value,
        ...(value.value ? { value: redactString(value.value) } : {}),
        ...(value.stacktrace
          ? {
              stacktrace: {
                frames: value.stacktrace.frames?.map((frame) => ({
                  ...frame,
                  // Local variables are the richest seam of all: the decrypted
                  // password is a local in the frame that decrypted it.
                  ...(frame.vars ? { vars: redact(frame.vars) as Record<string, unknown> } : {}),
                })),
              },
            }
          : {}),
      })),
    };
  }

  return scrubbed;
}

export function scrubBreadcrumb(crumb: SentryLikeBreadcrumb): SentryLikeBreadcrumb {
  return {
    ...crumb,
    ...(crumb.message ? { message: redactString(crumb.message) } : {}),
    ...(crumb.data ? { data: redact(crumb.data) as Record<string, unknown> } : {}),
  };
}
