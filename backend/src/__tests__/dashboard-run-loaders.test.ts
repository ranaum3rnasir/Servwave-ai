/* =============================================================================
   The home page must not fail because one tile did (scenario pass 2): the dashboard's loader runner.

   Seam: `runLoaders`, the one function the dashboard builder hands its tiles' loaders to. A loader that throws or
   takes too long comes back as an explicit error marker, the rest of the answer is intact, and only a few loaders
   run at once (the hosted database pool is tiny, so a burst of parallel loaders only queues).
   ========================================================================== */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { logger } from '../lib/logger';
import { runLoaders, TILE_ERROR } from '../services/dashboard/run';

type Loader = (ctx: object) => Promise<unknown>;

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('runLoaders', () => {
  it('answers each tile with its loader\'s value, keyed by tile id, and leaves out a tile that has no loader', async () => {
    const loaders: Record<string, Loader> = { a: async () => 1, b: async () => ({ n: 2 }) };
    const data = await runLoaders(['a', 'b', 'placeholder'], loaders, {});
    expect(data).toEqual({ a: 1, b: { n: 2 } });
  });

  it('answers null for a loader with nothing to say, so the tile still has an entry', async () => {
    const data = await runLoaders(['a'], { a: async () => undefined }, {});
    expect(data).toEqual({ a: null });
    expect(JSON.parse(JSON.stringify(data))).toHaveProperty('a', null);
  });

  it('turns a loader that throws into an error marker, keeps the other tiles, and logs the tile id but not the error text', async () => {
    const loaders: Record<string, Loader> = {
      ok: async () => 'fine',
      bad: async () => {
        throw new Error('select * from customers where phone = 555-0100');
      },
    };
    const data = await runLoaders(['ok', 'bad'], loaders, {});
    expect(data).toEqual({ ok: 'fine', bad: TILE_ERROR });
    expect(TILE_ERROR).toEqual({ error: true });
    expect(logger.error).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify((logger.error as ReturnType<typeof vi.fn>).mock.calls);
    expect(logged).toContain('bad');
    expect(logged).not.toContain('555-0100');
  });

  it('gives up on a loader that outlives its budget, so one slow query cannot hold the whole answer', async () => {
    vi.useFakeTimers();
    const loaders: Record<string, Loader> = { fast: async () => 'done', stuck: () => new Promise(() => undefined) };
    const pending = runLoaders(['fast', 'stuck'], loaders, {}, { loaderBudgetMs: 1000, totalBudgetMs: 60_000 });
    await vi.advanceTimersByTimeAsync(1500);
    expect(await pending).toEqual({ fast: 'done', stuck: TILE_ERROR });
  });

  it('runs no more than the allowed number of loaders at once', async () => {
    let running = 0;
    let peak = 0;
    const loader: Loader = async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running -= 1;
      return true;
    };
    const ids = Array.from({ length: 9 }, (_, i) => `t${i}`);
    const data = await runLoaders(ids, Object.fromEntries(ids.map((id) => [id, loader])), {}, { concurrency: 3 });
    expect(Object.keys(data)).toHaveLength(9);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it('marks a tile whose turn came after the whole answer ran out of time, without starting its loader', async () => {
    vi.useFakeTimers();
    const late = vi.fn(async () => 'never');
    const loaders: Record<string, Loader> = { slow: () => new Promise((r) => setTimeout(() => r('slow'), 900)), late };
    const pending = runLoaders(['slow', 'late'], loaders, {}, { concurrency: 1, loaderBudgetMs: 5000, totalBudgetMs: 500 });
    await vi.advanceTimersByTimeAsync(2000);
    const data = await pending;
    expect(data.late).toEqual(TILE_ERROR);
    expect(late).not.toHaveBeenCalled();
  });
});
