import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AxiosError } from 'axios';
import { handle402, __resetHandle402Throttle } from './handle402';

function err(
  status: number,
  opts: { method?: string; feature?: string; required_plan?: string } = {},
): AxiosError {
  return {
    config: opts.method === undefined ? {} : { method: opts.method },
    response: {
      status,
      data: { feature: opts.feature, required_plan: opts.required_plan },
    },
  } as unknown as AxiosError;
}

describe('handle402', () => {
  beforeEach(() => __resetHandle402Throttle());

  it('non-402 error → returns false, no toast', () => {
    const notify = vi.fn();
    expect(handle402(err(403), notify, () => 1000)).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  // The whole point of the fix: a background read hitting a gated module is a
  // widget that should not have mounted, not something to interrupt the user over.
  it('402 on a GET → handled silently, no toast', () => {
    const notify = vi.fn();
    expect(
      handle402(err(402, { method: 'get', feature: 'inventory', required_plan: 'SCALE' }), notify, () => 1000),
    ).toBe(true);
    expect(notify).not.toHaveBeenCalled();
  });

  it('402 with no method on the config → treated as a read, no toast', () => {
    const notify = vi.fn();
    expect(handle402(err(402, { feature: 'inventory' }), notify, () => 1000)).toBe(true);
    expect(notify).not.toHaveBeenCalled();
  });

  it('402 on a POST → destructive toast naming the feature and required plan', () => {
    const notify = vi.fn();
    expect(
      handle402(err(402, { method: 'post', feature: 'inventory', required_plan: 'SCALE' }), notify, () => 1000),
    ).toBe(true);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: 'destructive',
        title: 'Not included in your plan',
        description: 'Inventory is available on the Scale plan.',
      }),
    );
  });

  it.each(['POST', 'patch', 'PUT', 'delete'])('402 on %s → toasts', (method) => {
    const notify = vi.fn();
    handle402(err(402, { method, feature: 'leads', required_plan: 'PRO' }), notify, () => 1000);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('unknown feature key → generic copy, never a dangling sentence', () => {
    const notify = vi.fn();
    handle402(err(402, { method: 'post', feature: 'not_a_real_key' }), notify, () => 1000);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'This feature is not included in your plan.' }),
    );
  });

  it('falls back to the catalog when the body omits required_plan', () => {
    const notify = vi.fn();
    handle402(err(402, { method: 'post', feature: 'inventory' }), notify, () => 1000);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'Inventory is available on the Scale plan.' }),
    );
  });

  it('de-dupes the same feature within the window', () => {
    const notify = vi.fn();
    handle402(err(402, { method: 'post', feature: 'inventory' }), notify, () => 1000);
    handle402(err(402, { method: 'post', feature: 'inventory' }), notify, () => 2000);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('shows again for the same feature after the window elapses', () => {
    const notify = vi.fn();
    handle402(err(402, { method: 'post', feature: 'inventory' }), notify, () => 1000);
    handle402(err(402, { method: 'post', feature: 'inventory' }), notify, () => 5000);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  // De-dupe is keyed per feature: two different gated modules failing in the same
  // window are two different messages, and suppressing one would misinform.
  it('does not de-dupe across different features', () => {
    const notify = vi.fn();
    handle402(err(402, { method: 'post', feature: 'inventory' }), notify, () => 1000);
    handle402(err(402, { method: 'post', feature: 'leads' }), notify, () => 1100);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  // The regression this module exists to prevent: a 402 anywhere used to run
  // `window.location.href = '/upgrade'`, tearing down whatever page the user was on.
  it('never navigates', () => {
    const before = window.location.href;
    const notify = vi.fn();
    handle402(err(402, { method: 'get', feature: 'inventory' }), notify, () => 1000);
    handle402(err(402, { method: 'post', feature: 'inventory' }), notify, () => 2000);
    expect(window.location.href).toBe(before);
  });
});
