/**
 * Mobile slice 74: the portrait capture sizes the viewport to the page, and that size is part of
 * the photograph (a baseline that is 11 px taller than its committed twin fails on dimensions
 * alone). One full run in nine went red that way under heavy machine load: a transient reading of
 * how far the page scrolls was 11 px too big, the viewport only ever grew, so the overshoot became
 * a permanent blank band at the bottom.
 *
 * `fitViewportToPage` (e2e/mobile/fit-page.ts) is the pure sizing logic. Here it runs against a
 * simulated page whose reading can be made to misreport, and the final viewport must equal the
 * page's real height every time.
 */
import { describe, expect, it } from 'vitest';

import { fitViewportToPage, type FitPage } from '../../e2e/mobile/fit-page';

const WIDTH = 320;
const FLOOR = 568;
const CAP = 6000;

/**
 * A page of `natural(height)` px that scrolls whatever does not fit. `misread(readNo, height)` adds
 * a transient to what one reading REPORTS (the page itself is unchanged).
 */
function simulate(opts: {
  natural: (viewportHeight: number) => number;
  misread?: (readNo: number, viewportHeight: number) => number;
}) {
  const state = { height: FLOOR, reads: 0 };
  const page: FitPage = {
    size: () => ({ width: WIDTH, height: state.height }),
    resize: async (_w, h) => {
      state.height = h;
    },
    extent: async () => {
      state.reads += 1;
      const real = Math.max(0, opts.natural(state.height) - state.height);
      return real + (opts.misread?.(state.reads, state.height) ?? 0);
    },
    rest: async () => {},
    pause: async () => {},
  };
  return { state, page };
}

const fit = (page: FitPage) => fitViewportToPage(page, { floor: FLOOR, cap: CAP, label: 'job-detail on iphone-se' });

describe('fitViewportToPage', () => {
  it('sizes the viewport to a steady page exactly', async () => {
    const { state, page } = simulate({ natural: () => 4281 });
    await fit(page);
    expect(state.height).toBe(4281);
  });

  it('leaves a page that already fits at the phone height', async () => {
    const { state, page } = simulate({ natural: () => 500 });
    await fit(page);
    expect(state.height).toBe(FLOOR);
  });

  it('does not lock in an 11 px overshoot that is only there for the first readings', async () => {
    // The failure of the full run under load: the first reading said 3724, the page is 3713.
    const { state, page } = simulate({ natural: () => 4281, misread: (n) => (n <= 2 ? 11 : 0) });
    await fit(page);
    expect(state.height).toBe(4281);
  });

  it('does not lock in an overshoot that appears on a single reading after the viewport grew', async () => {
    const { state, page } = simulate({ natural: () => 4281, misread: (n, h) => (h > FLOOR && n % 5 === 1 ? 11 : 0) });
    await fit(page);
    expect(state.height).toBe(4281);
  });

  it('converges on a page whose height depends on the viewport', async () => {
    // A section sized from the viewport: 10% of it on top of 3000 px of content.
    const { state, page } = simulate({ natural: (h) => 3000 + Math.round(h * 0.1) });
    await fit(page);
    const extent = Math.max(0, 3000 + Math.round(state.height * 0.1) - state.height);
    expect(extent).toBeLessThanOrEqual(1);
  });

  it('fails, naming the page, when a reading never settles', async () => {
    const { page } = simulate({ natural: () => 4281, misread: (n) => (n % 2) * 11 });
    await expect(fit(page)).rejects.toThrow(/job-detail on iphone-se.*never settled/s);
  });

  it('fails, naming the height needed, when the page outgrows the cap', async () => {
    const { page } = simulate({ natural: () => 7000 });
    await expect(fit(page)).rejects.toThrow(/job-detail on iphone-se.*7000px tall.*6000px cap/s);
  });
});
