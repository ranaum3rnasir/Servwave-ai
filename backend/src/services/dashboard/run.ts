import { logger } from '../../lib/logger';

/**
 * Runs the dashboard's tile loaders so that no one tile can fail the page (scenario pass 2: the home page every person
 * lands on answered 500 when a single read ran long on the hosted database).
 *
 * - A loader that throws, or outlives its time budget, comes back as `TILE_ERROR` in its place and the rest of the answer
 *   is intact. The log names the tile and the kind of error, never its text (a database error can quote customer data).
 * - Only a few loaders run at once. The hosted database pool is tiny, so a burst of parallel loaders does not run in
 *   parallel at all: it queues, and every other request of the service queues behind it.
 * - The whole answer has a budget too: a tile whose turn comes after it has run out is marked without starting.
 *
 * A budget cannot cancel the query a loader already sent; it only stops the answer waiting for it.
 */

/** What a tile's entry holds when its loader failed or timed out: the page draws a plain error line with a retry. */
export const TILE_ERROR = Object.freeze({ error: true });

export interface RunOptions {
  /** How long one loader may take before its tile is marked. */
  loaderBudgetMs: number;
  /** How long the whole answer may take; tiles not finished by then are marked. */
  totalBudgetMs: number;
  /** How many loaders may be in flight at once. */
  concurrency: number;
}

export const DEFAULT_RUN_OPTIONS: RunOptions = { loaderBudgetMs: 8_000, totalBudgetMs: 20_000, concurrency: 4 };

class BudgetExceeded extends Error {
  constructor() {
    super('tile budget exceeded');
    this.name = 'BudgetExceeded';
  }
}

function withinBudget<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new BudgetExceeded()), Math.max(ms, 0));
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export async function runLoaders<C>(
  ids: readonly string[],
  loaders: Record<string, (ctx: C) => Promise<unknown>>,
  ctx: C,
  options: Partial<RunOptions> = {},
): Promise<Record<string, unknown>> {
  const { loaderBudgetMs, totalBudgetMs, concurrency } = { ...DEFAULT_RUN_OPTIONS, ...options };
  const startedAt = Date.now();
  const data: Record<string, unknown> = {};
  const queue = ids.filter((id) => loaders[id] !== undefined);

  const failed = (id: string, err: unknown) => {
    // Kind and tile id only: no message, no stack, nothing a customer's record could ride in on.
    logger.error('Dashboard tile failed', { tile: id, kind: err instanceof Error ? err.name : 'unknown', code: (err as { code?: unknown })?.code });
    data[id] = TILE_ERROR;
  };

  const worker = async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      const remaining = totalBudgetMs - (Date.now() - startedAt);
      if (remaining <= 0) {
        failed(id, new BudgetExceeded());
        continue;
      }
      try {
        // A loader with nothing to say answers null, not undefined: JSON drops an undefined key, and a tile with no
        // entry reads on the page as an answer still on its way.
        data[id] = (await withinBudget(loaders[id]!(ctx), Math.min(loaderBudgetMs, remaining))) ?? null;
      } catch (err) {
        failed(id, err);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, worker));
  return data;
}
