/**
 * The shared auth-provider error mapping (password reset spec §4.2; reused by §5.2 and §7).
 * Expected copy is the spec's literal wording, not recomputed from the module.
 */
import { describe, it, expect, vi } from 'vitest';
import { mapPasswordUpdateError } from '../auth-provider-errors';
import { logger } from '../logger';

const providerError = (fields: Record<string, unknown>) =>
  Object.assign(new Error(String(fields.message ?? 'provider detail')), fields);

describe('mapPasswordUpdateError', () => {
  it('a breached-password rejection becomes 422 weak_password with the ServWave copy', () => {
    const mapped = mapPasswordUpdateError(
      providerError({ name: 'AuthWeakPasswordError', status: 422, code: 'weak_password', reasons: ['pwned'] }),
      'test',
    );

    expect(mapped).toEqual({
      status: 422,
      body: {
        error: "This password has appeared in a known data breach, so it isn't safe to use. Choose a different one.",
        code: 'weak_password',
      },
    });
  });

  it('any other provider error becomes the generic 400', () => {
    for (const err of [providerError({ status: 500 }), providerError({ status: 400, code: 'reauthentication_needed' }), 'boom', null]) {
      expect(mapPasswordUpdateError(err, 'test')).toEqual({
        status: 400,
        body: { error: "We couldn't update your password. Try again or contact ServWave support." },
      });
    }
  });

  it("the provider's same-password refusal becomes ServWave's same-password message", () => {
    expect(mapPasswordUpdateError(providerError({ status: 422, code: 'same_password' }), 'test')).toEqual({
      status: 400,
      body: { error: "Choose a password you haven't used here.", code: 'same_password' },
    });
  });

  it('logs the provider detail server-side and never puts it in the body', () => {
    const detail = 'Password is known to be weak and easy to guess, please choose a different one.';
    const mapped = mapPasswordUpdateError(providerError({ message: detail, status: 422, code: 'weak_password' }), 'test', { userId: 'u1' });

    expect(JSON.stringify(mapped)).not.toContain(detail);
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.stringContaining('test'),
      expect.objectContaining({ userId: 'u1', providerMessage: detail, providerCode: 'weak_password', providerStatus: 422 }),
    );
  });
});
