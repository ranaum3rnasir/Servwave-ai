/**
 * Sizing the viewport to the page for a whole-page phone photograph (mobile slice 74).
 *
 * The app's layout is `100dvh` with an inner scroller, so a full-page capture needs a viewport as
 * tall as the page. The height is part of the photograph: a baseline 11 px taller than its twin
 * fails on dimensions alone, whatever the pixels say.
 *
 * Why a reading must repeat: a reading of how far the page scrolls can be a few pixels off for a
 * moment (a collapsible card still easing open on a loaded machine), and a viewport that only ever
 * grows turns that moment into a permanent blank band at the bottom. One full run in nine failed
 * that way (the page measured 11 px taller than its baseline). So a reading counts only when
 * STABLE_READS equal readings come in a row, and the caller lets running animations finish first.
 *
 * Why the viewport is NOT taken back down afterwards ("shrink to fit"): measured, it does not work.
 * These pages are not a pure function of content: some sections are sized from the viewport, so a
 * probe at a shorter viewport settles on a different height (the job page came out 167 px shorter,
 * the estimate page 24 px shorter than its committed baseline). The height that is deterministic is
 * the one reached by growing from the phone's own height, which is what the baselines record.
 *
 * This file has no browser in it (the page is the `FitPage` seam), so it is unit-tested in
 * `src/__tests__/phone-visual-fit.test.ts`.
 */

export interface FitPage {
  size(): { width: number; height: number };
  resize(width: number, height: number): Promise<void>;
  /** One reading: how many px the page's primary scroller still scrolls (0 when it all fits). */
  extent(): Promise<number>;
  /** Let the page lay out after a resize (network quiet, fonts loaded, scrolled to the top). */
  rest(): Promise<void>;
  pause(ms: number): Promise<void>;
}

/** Equal readings in a row that make a reading believable. */
export const STABLE_READS = 3;
/** Readings tried before the page is called unsettled (about 5 s at READ_GAP_MS). */
export const MAX_READS = 40;
export const READ_GAP_MS = 120;
const MAX_ROUNDS = 4;

export interface FitOptions {
  /** The phone's own viewport height (where growing starts). */
  floor: number;
  /** The tallest page a photograph covers. */
  cap: number;
  /** Names the state and device in a failure. */
  label: string;
}

async function stableExtent(page: FitPage, label: string): Promise<number> {
  const seen: number[] = [];
  let run = 0;
  for (let i = 0; i < MAX_READS; i++) {
    const value = await page.extent();
    seen.push(value);
    run = i > 0 && seen[i - 1] === value ? run + 1 : 1;
    if (run >= STABLE_READS) return value;
    await page.pause(READ_GAP_MS);
  }
  throw new Error(
    `${label}: the page's scroll extent never settled (${MAX_READS} readings, last ${seen.slice(-6).join(', ')}): something on it is still moving, so its height cannot be photographed`,
  );
}

/** Grow the viewport by what still scrolls until nothing does. Returns the last stable extent. */
async function grow(page: FitPage, opts: FitOptions): Promise<number> {
  let extent = await stableExtent(page, opts.label);
  for (let round = 0; extent > 1 && round < MAX_ROUNDS; round++) {
    const size = page.size();
    const needed = size.height + extent;
    if (needed > opts.cap) {
      throw new Error(
        `${opts.label}: the page is ${needed}px tall, past the ${opts.cap}px cap: raise MAX_PAGE_HEIGHT in phone-visual.spec.ts, or the baseline would silently stop covering the page's end`,
      );
    }
    await page.resize(size.width, needed);
    await page.rest();
    extent = await stableExtent(page, opts.label);
  }
  return extent;
}

/**
 * Grow the viewport from the phone's own height by what still scrolls, until nothing does, and
 * return its height. Throws, naming the state, if the page outgrows the cap, never settles, or still
 * scrolls after the viewport grew to fit it.
 */
export async function fitViewportToPage(page: FitPage, opts: FitOptions): Promise<number> {
  const extent = await grow(page, opts);
  if (extent > 1) {
    throw new Error(`${opts.label}: the page still scrolls ${extent}px after the viewport grew to fit it: the photograph would miss its end`);
  }
  return page.size().height;
}
