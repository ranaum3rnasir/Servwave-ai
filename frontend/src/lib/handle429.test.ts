import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AxiosError } from 'axios';
import { handle429, __resetHandle429Throttle } from './handle429';

function err(
  status: number,
  opts: { retryAfterHeader?: string; retryAfterBody?: number } = {},
): AxiosError {
  return {
    response: {
      status,
      headers: opts.retryAfterHeader != null ? { 'retry-after': opts.retryAfterHeader } : {},
      data: opts.retryAfterBody != null ? { retryAfter: opts.retryAfterBody } : {},
    },
  } as unknown as AxiosError;
}

describe('handle429', () => {
  beforeEach(() => __resetHandle429Throttle());

  it('non-429 error → returns false, no toast', () => {
    const notify = vi.fn();
    expect(handle429(err(500), notify, () => 1000)).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it('429 with Retry-After header → destructive toast mentioning ~Ns, returns true', () => {
    const notify = vi.fn();
    expect(handle429(err(429, { retryAfterHeader: '42' }), notify, () => 1000)).toBe(true);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: 'destructive',
        description: expect.stringContaining('~42s'),
      }),
    );
  });

  it('429 falls back to body.retryAfter when the header is absent', () => {
    const notify = vi.fn();
    handle429(err(429, { retryAfterBody: 12 }), notify, () => 1000);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ description: expect.stringContaining('~12s') }),
    );
  });

  it('429 with no wait info → generic wait message', () => {
    const notify = vi.fn();
    handle429(err(429), notify, () => 1000);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ description: expect.stringContaining('wait a moment') }),
    );
  });

  it('de-dupes: a second 429 within the window shows no new toast', () => {
    const notify = vi.fn();
    handle429(err(429, { retryAfterHeader: '5' }), notify, () => 1000);
    handle429(err(429, { retryAfterHeader: '5' }), notify, () => 2000); // +1s < 3s window
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('shows again after the de-dupe window elapses', () => {
    const notify = vi.fn();
    handle429(err(429, { retryAfterHeader: '5' }), notify, () => 1000);
    handle429(err(429, { retryAfterHeader: '5' }), notify, () => 5000); // +4s > 3s window
    expect(notify).toHaveBeenCalledTimes(2);
  });
});
