/* =============================================================================
   Fixed-width guard (mobile slice 12, rubric VP-09) - a ratchet.

   The smallest phone the app supports is 320 px wide. An element given a fixed
   width or min-width above 320 px at EVERY screen size cannot fit on it; under
   the app shell's locked root the excess is clipped silently, so a drawer's
   close button, a panel's right column or a table's last action just vanishes.

   Pass shapes:
   - `w-full max-w-[440px]` (fills a phone, caps on a desktop);
   - `w-[440px] max-w-[calc(100vw-2rem)]` (max-width beats width; the cap must
     be unprefixed and bound to the viewport or container: full, screen, vw, %);
   - `hidden w-96 lg:flex` (not displayed on a phone at all);
   - `sm:w-[440px]`, `md:min-w-[680px]` (the width applies only from a
     min-width breakpoint up, including `min-[...]:` and `@container` sizes);
   - widths that are not fixed: %, vw, calc(), min(), var().

   Watched: Tailwind `w-` / `min-w-` with an arbitrary px/rem/em value or a
   spacing-scale step above 80 (320 px); the `[width:...]` / `[min-width:...]`
   arbitrary properties; inline style `width` / `minWidth` object keys; and CSS
   `width` / `min-width` declarations outside a `@media (min-width...)` block.
   NOT watched: JSX `width={...}` attributes (svg/canvas/img intrinsic sizes)
   and media-query strings such as `(max-width: 767px)`.

   RATCHET, NOT ZERO TOLERANCE. Today's offenders are listed in
   `fixed-width-allowlist.json` (file -> class -> count). The list may only
   shrink:
   - a new fixed width anywhere, or one more in an already-listed file, fails;
   - a listed entry that is no longer in the source fails until it is removed;
   - the list's total must equal ALLOW_LIST_CEILING, so growing the JSON fails
     unless the ceiling is raised in the same diff, where review sees it.
   When you fix an offender: delete its entry and lower the ceiling.
   ============================================================================= */
import { describe, it, expect } from 'vitest';
import allowList from './fixed-width-allowlist.json';
import {
  allowListSize,
  diffAgainstAllowList,
  findWideFixedWidths,
  sourceFiles,
  tallyFiles,
  type Tally,
} from './scan';

/** The number of allow-listed fixed widths. It only ever goes DOWN. */
const ALLOW_LIST_CEILING = 7;

const tokens = (src: string, file = 'x.tsx') => findWideFixedWidths(src, file).map((o) => o.token);

describe('fixed-width guard (mobile slice 12, VP-09)', () => {
  const files = sourceFiles();
  const actual = tallyFiles(files, findWideFixedWidths);
  const allowed = allowList as Tally;

  it('the pattern fires on unprefixed fixed widths above 320 px', () => {
    expect(tokens('<SheetContent className="w-[440px] sm:max-w-[440px]">')).toEqual(['w-[440px]']);
    expect(tokens('<div className="min-w-[680px] overflow-hidden">')).toEqual(['min-w-[680px]']);
    expect(tokens("cn('absolute right-10 w-96', open && 'block')")).toEqual(['w-96']);
    expect(tokens('<div className="min-w-95">')).toEqual(['min-w-95']);
    expect(tokens('<div className="w-[24rem]">')).toEqual(['w-[24rem]']);
    expect(tokens('<div className="w-[321px]">')).toEqual(['w-[321px]']);
    // A small-screens-only variant still applies on a phone.
    expect(tokens('<div className="max-sm:w-[400px]">')).toEqual(['w-[400px]']);
    expect(tokens('<div className="hover:min-w-[500px]">')).toEqual(['min-w-[500px]']);
    expect(tokens('<div className="[min-width:500px]">')).toEqual(['[min-width:500px]']);
    expect(tokens('<div style={{ width: 440 }}>')).toEqual(['width: 440']);
    expect(tokens("<div style={{ minWidth: '680px' }}>")).toEqual(['minWidth: 680px']);
    expect(tokens('.panel {\n  width: 400px;\n}', 'x.css')).toEqual(['width: 400px']);
    expect(tokens('.panel { min-width: 22rem; }', 'x.css')).toEqual(['min-width: 22rem']);
  });

  it('the pattern stays quiet on capped, breakpoint-gated, small and fluid widths', () => {
    expect(tokens('<div className="w-full max-w-[440px]">')).toEqual([]);
    // max-width beats width, so a viewport-bound cap in the same class string fits.
    expect(tokens('<div className="w-[440px] max-w-full">')).toEqual([]);
    expect(tokens('<div className="w-[420px] max-w-[calc(100vw-2rem)]">')).toEqual([]);
    expect(tokens('<div className="w-96 max-w-[90%]">')).toEqual([]);
    // ...but not min-width (min-width beats max-width), and not a fixed cap.
    expect(tokens('<div className="min-w-[680px] max-w-full">')).toEqual(['min-w-[680px]']);
    expect(tokens('<div className="w-[440px] max-w-md">')).toEqual(['w-[440px]']);
    expect(tokens('<div className="w-[440px] sm:max-w-full">')).toEqual(['w-[440px]']);
    // Not displayed on a phone at all: hidden below a breakpoint, shown from it up.
    expect(tokens("open ? 'hidden w-96 flex-none lg:flex' : 'flex-1'")).toEqual([]);
    expect(tokens('<aside className="hidden min-w-[400px] md:block">')).toEqual([]);
    // ...but hidden only from a breakpoint up is visible on a phone.
    expect(tokens('<aside className="w-96 sm:hidden">')).toEqual(['w-96']);
    expect(tokens('<aside className="hidden w-96">')).toEqual(['w-96']);
    expect(tokens('<div className="sm:w-[440px] md:min-w-[680px] lg:w-96 2xl:w-[30rem]">')).toEqual([]);
    expect(tokens('<div className="min-[400px]:w-[440px] @md:w-[500px]">')).toEqual([]);
    expect(tokens('<div className="w-80 w-[320px] min-w-[240px] w-[20rem]">')).toEqual([]);
    expect(tokens('<div className="w-[94vw] w-[calc(100%-2.5rem)] w-[min(26.25rem,100vw)] w-[var(--x)]">')).toEqual([]);
    expect(tokens('<div className="max-w-[680px] max-h-[500px] h-[400px] size-[400px]">')).toEqual([]);
    expect(tokens('<div className="before:w-[3px] w-[--radix-popover-trigger-width]">')).toEqual([]);
    expect(tokens('<canvas width={600} height={128} />')).toEqual([]);
    expect(tokens("const isNarrow = useMediaQuery('(max-width: 1023.98px)');")).toEqual([]);
    expect(tokens("window.matchMedia('(min-width: 1280px)')")).toEqual([]);
    expect(tokens('<div style={{ width: 160, maxWidth: 900 }}>')).toEqual([]);
    expect(tokens('.row { width: 400%; }', 'x.css')).toEqual([]);
    expect(tokens('@media (min-width: 640px) {\n  .panel { width: 400px; }\n}', 'x.css')).toEqual([]);
    // A max-width media block is phones too: that one is NOT gated.
    expect(tokens('@media (max-width: 760px) {\n  .panel { width: 400px; }\n}', 'x.css')).toEqual([
      'width: 400px',
    ]);
    // Prose is not a class.
    expect(tokens('  // the drawer used to be w-[440px] at every width')).toEqual([]);
  });

  it('scanned the source tree', () => {
    expect(files.length).toBeGreaterThan(500);
  });

  it('no fixed width above 320 px outside the allow-list', () => {
    const { grown } = diffAgainstAllowList(actual, allowed);
    expect(
      grown,
      `Use w-full max-w-[...], or gate the width behind sm:/md:, so it fits a 320 px phone:\n${grown.join('\n')}`,
    ).toEqual([]);
  });

  it('no stale allow-list entry - the list only shrinks', () => {
    const { stale } = diffAgainstAllowList(actual, allowed);
    expect(
      stale,
      `These offenders are fixed. Remove them from fixed-width-allowlist.json and lower ALLOW_LIST_CEILING:\n${stale.join('\n')}`,
    ).toEqual([]);
  });

  it('the allow-list does not grow', () => {
    expect(
      allowListSize(allowed),
      'fixed-width-allowlist.json must hold exactly ALLOW_LIST_CEILING entries. Never raise the ceiling to admit new code; lower it when you fix one.',
    ).toBe(ALLOW_LIST_CEILING);
  });

  it('a deliberately added offender is reported', () => {
    const planted = [...files, ['pages/Planted.tsx', '<aside className="w-[400px]" />'] as const];
    const { grown } = diffAgainstAllowList(tallyFiles(planted, findWideFixedWidths), allowed);
    expect(grown).toEqual(['pages/Planted.tsx: w-[400px] x1 (allowed 0)']);
  });
});
