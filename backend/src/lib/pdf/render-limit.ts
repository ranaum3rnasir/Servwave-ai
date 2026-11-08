/**
 * Bounded concurrency and per-render accounting for PDF rendering (#2029 slice 4).
 *
 * MEASURED, not assumed. On the installed renderer with real fonts and twenty-four
 * full-resolution photos:
 *
 *   full-resolution, data URIs        1,039 MB peak RSS,  185 MB PDF
 *   downscaled, data URIs               477 MB peak RSS,    6 MB PDF
 *   downscaled, image dictionary        368 MB peak RSS,    6 MB PDF
 *
 * Downscaling on ingest is worth ~30x; the delivery mechanism ~1.2x. Once photos are sized
 * correctly the marginal cost is roughly 30 MB per additional concurrent render. This is an
 * image-size problem wearing an architecture problem's clothes, and #2029 slice 2 is what solved
 * it — so there is deliberately NO background worker and NO job queue here.
 *
 * What is here is a cap of two and a log line per render, so that rising usage is visible before
 * it becomes an outage. A third request WAITS; it is never refused. Revisit only if sustained
 * memory passes roughly 60% of the instance, or volume reaches the low hundreds of renders a day.
 */
import { logger } from '../logger';

/** Concurrent renders allowed. Two, at ~30 MB marginal each — headroom, not a queue. */
export const MAX_CONCURRENT_RENDERS = 2;

let active = 0;
const waiting: Array<() => void> = [];

async function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT_RENDERS) {
    active += 1;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
  active += 1;
}

function release(): void {
  active -= 1;
  const next = waiting.shift();
  if (next) next();
}

export interface RenderAccounting {
  /** How many images the document embedded. Logged so growth is visible in the ordinary logs. */
  imageCount: number;
  /** What was rendered, for the log line: 'estimate', 'invoice', 'statement'. */
  label: string;
}

/**
 * Run one render inside a slot. The slot is ALWAYS returned, including when the render throws —
 * one failure must not wedge the renderer for everyone behind it.
 */
export async function withRenderSlot<T>(
  render: () => Promise<T>,
  accounting?: RenderAccounting,
): Promise<T> {
  await acquire();
  const before = process.memoryUsage().rss;
  try {
    const result = await render();
    if (accounting) {
      const after = process.memoryUsage().rss;
      const peakMb = Math.round(Math.max(before, after) / (1024 * 1024));
      logger.info(
        `PDF render (${accounting.label}): ${accounting.imageCount} image(s), peak rss ~${peakMb}MB, ${active} concurrent`,
      );
    }
    return result;
  } finally {
    release();
  }
}
