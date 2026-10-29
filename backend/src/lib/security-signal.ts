import * as Sentry from '@sentry/node';
import { logger } from './logger';

export type SecuritySignalKind = 'credential_spray' | 'rate_limiter_failing_open';

// 'warning' = notable-but-expected (a spike is the alert); 'error' = we are
// running unprotected (Redis down). Literal types satisfy Sentry's SeverityLevel.
const LEVEL: Record<SecuritySignalKind, 'warning' | 'error'> = {
  credential_spray: 'warning',
  rate_limiter_failing_open: 'error',
};

/**
 * Emit a security signal to Sentry as a tagged message — NOT an exception. These
 * are expected-but-notable events, so they must not inflate the error rate; a
 * Sentry alert rule counts occurrences and emails on a spike (threshold lives in
 * Sentry, tunable without a deploy). Sentry self-disables without SENTRY_DSN, so
 * this is a no-op in test/local. Swallows its own errors: alerting must NEVER
 * break the request path (e.g. the 429 response).
 */
export function reportSecuritySignal(
  kind: SecuritySignalKind,
  context: Record<string, unknown> = {},
): void {
  try {
    Sentry.captureMessage(`security.${kind}`, {
      level: LEVEL[kind],
      tags: { security_signal: kind },
      extra: context,
    });
  } catch (err) {
    logger.warn('reportSecuritySignal failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
