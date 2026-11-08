/**
 * #2029 slice 4 — bounded concurrency and per-render memory logging.
 *
 * Measured on the installed renderer with real fonts and twenty-four full-resolution photos:
 * full-resolution data URIs peaked at 1,039 MB RSS for a 185 MB PDF; downscaled through the image
 * dictionary, 368 MB for 6 MB. Once photos are sized correctly the marginal cost is roughly 30 MB
 * per additional concurrent render.
 *
 * So: no queue and no worker. A cap of two, and a log line per render, exist so that rising usage
 * is VISIBLE before it becomes an outage — not because a queue is expected. A third request waits
 * its turn; it is never refused.
 */
import { describe, it, expect, vi } from 'vitest';
import { withRenderSlot, MAX_CONCURRENT_RENDERS } from '../render-limit';
import { logger } from '../../logger';

/** A render that parks until the test releases it. */
function pending() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  return { gate, release };
}

describe('the render limiter', () => {
  it('caps concurrent renders at two', async () => {
    let running = 0;
    let peak = 0;
    const a = pending();
    const b = pending();
    const c = pending();

    const run = (gate: Promise<void>) =>
      withRenderSlot(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await gate;
        running -= 1;
        return Buffer.alloc(0);
      });

    const all = [run(a.gate), run(b.gate), run(c.gate)];
    // Let the first two claim their slots.
    await Promise.resolve();
    await Promise.resolve();

    expect(peak).toBe(MAX_CONCURRENT_RENDERS);

    a.release(); b.release(); c.release();
    await Promise.all(all);
    expect(peak).toBe(MAX_CONCURRENT_RENDERS);
    expect(running).toBe(0);
  });

  it('lets a queued render complete rather than refusing it', async () => {
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => withRenderSlot(async () => n)),
    );

    expect(results).toEqual([1, 2, 3, 4, 5]);
  });

  it('frees its slot when a render throws, so one failure does not wedge the renderer', async () => {
    await expect(withRenderSlot(async () => { throw new Error('boom'); })).rejects.toThrow('boom');

    // The slot is back: this resolves rather than hanging.
    await expect(withRenderSlot(async () => 'ok')).resolves.toBe('ok');
  });

  it('logs the peak memory and the image count for each render', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined as never);

    await withRenderSlot(async () => Buffer.alloc(0), { imageCount: 7, label: 'estimate' });

    const line = info.mock.calls.map((c) => String(c[0])).find((l) => l.includes('estimate'));
    expect(line).toMatch(/7 image/);
    expect(line).toMatch(/rss/i);
    info.mockRestore();
  });

  it('logs nothing extra for a render with no images to account for', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined as never);

    await withRenderSlot(async () => Buffer.alloc(0));

    expect(info).not.toHaveBeenCalled();
    info.mockRestore();
  });
});
