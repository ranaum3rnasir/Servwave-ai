import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AxiosError } from 'axios';
import { handle500, __resetHandle500Throttle } from './handle500';

function err(status: number): AxiosError {
  return { response: { status } } as unknown as AxiosError;
}

describe('handle500', () => {
  beforeEach(() => __resetHandle500Throttle());

  it('non-500 error → returns false, no toast', () => {
    const notify = vi.fn();
    expect(handle500(err(429), notify, () => 1000)).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it('500 → destructive toast, returns true', () => {
    const notify = vi.fn();
    expect(handle500(err(500), notify, () => 1000)).toBe(true);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: 'destructive',
        title: expect.stringContaining('went wrong'),
      }),
    );
  });

  it('de-dupes: a second 500 within the window shows no new toast', () => {
    const notify = vi.fn();
    handle500(err(500), notify, () => 1000);
    handle500(err(500), notify, () => 2000); // +1s < 3s window
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('shows again after the de-dupe window elapses', () => {
    const notify = vi.fn();
    handle500(err(500), notify, () => 1000);
    handle500(err(500), notify, () => 5000); // +4s > 3s window
    expect(notify).toHaveBeenCalledTimes(2);
  });
});
