import type { CookieOptions, Response, Request } from 'express';
import type { AppConfigService } from '../../core/config/app-config.service';

/**
 * The refresh cookie.
 *
 * Scoped to the refresh path specifically, so it is not attached to any other
 * request — a long-lived credential should travel as rarely as possible.
 * httpOnly keeps it out of reach of JavaScript, which is the mitigation that
 * matters: an XSS that can read tokens gets only a 15-minute access token, not
 * a week of access.
 */
export const REFRESH_COOKIE = 'jaa_refresh';
export const REFRESH_COOKIE_PATH = '/v1/auth/refresh';

export function refreshCookieOptions(
  config: AppConfigService,
  expiresAt?: Date,
): CookieOptions {
  const sameSite = config.get('COOKIE_SAMESITE');
  return {
    httpOnly: true,
    // SameSite=None is meaningless without Secure, and browsers reject it.
    secure: config.isProduction || sameSite === 'none',
    sameSite,
    path: REFRESH_COOKIE_PATH,
    domain: config.get('COOKIE_DOMAIN'),
    ...(expiresAt ? { expires: expiresAt } : {}),
  };
}

export function setRefreshCookie(
  res: Response,
  config: AppConfigService,
  token: string,
  expiresAt: Date,
): void {
  res.cookie(REFRESH_COOKIE, token, refreshCookieOptions(config, expiresAt));
}

export function clearRefreshCookie(res: Response, config: AppConfigService): void {
  // Options must match those used to set it, or the browser keeps the cookie.
  res.clearCookie(REFRESH_COOKIE, refreshCookieOptions(config));
}

export function readRefreshCookie(req: Request): string | undefined {
  // cookie-parser's own typings declare `cookies` as `any`, which would spread
  // untyped values through the auth path. Go via unknown so the narrowed shape
  // is the one that applies.
  const cookies = (req as unknown as { cookies?: Record<string, unknown> }).cookies;
  const value = cookies?.[REFRESH_COOKIE];
  return typeof value === 'string' ? value : undefined;
}
