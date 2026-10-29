import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@sentry/node', () => ({
  captureMessage: vi.fn(),
}));

import * as Sentry from '@sentry/node';
import { reportSecuritySignal } from '../security-signal';

describe('reportSecuritySignal', () => {
  beforeEach(() => vi.clearAllMocks());

  it('credential_spray → captureMessage with warning level, security tag, and context', () => {
    reportSecuritySignal('credential_spray', { breached: 'ip', route: '/api/auth/login' });
    expect(Sentry.captureMessage).toHaveBeenCalledWith('security.credential_spray', {
      level: 'warning',
      tags: { security_signal: 'credential_spray' },
      extra: { breached: 'ip', route: '/api/auth/login' },
    });
  });

  it('rate_limiter_failing_open → captureMessage with error level', () => {
    reportSecuritySignal('rate_limiter_failing_open', { limiter: 'general' });
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'security.rate_limiter_failing_open',
      expect.objectContaining({ level: 'error' }),
    );
  });

  it('never throws when Sentry throws (alerting must not break the caller)', () => {
    (Sentry.captureMessage as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('sentry down');
    });
    expect(() => reportSecuritySignal('credential_spray', {})).not.toThrow();
  });
});
