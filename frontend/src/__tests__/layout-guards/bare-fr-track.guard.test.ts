/* =============================================================================
   Bare `fr` grid-track guard (mobile slice 12, rubric VP-08) - a ratchet.

   A bare `1fr` column track is `minmax(auto, 1fr)`: its MINIMUM is the content's
   min-content width, not zero. One wide child (a table, a long unbroken string, a
   fixed-width control) then widens the track, the grid and the page past the
   viewport. Under the app shell's locked root that overflow is clipped silently,
   so on a 320 px phone the right-hand content simply disappears.

   The fix is `minmax(0,1fr)` (plus `min-w-0` on the grid item), which lets the
   track shrink to the space that is actually there.

   This generalises the line-item workspace grid guard (#2091), which only
   watched pages hosting a line-item editor, to every source file under
   `frontend/src`: Tailwind `grid-cols-[...]` arbitrary values, the
   `[grid-template-columns:...]` arbitrary property, inline `gridTemplateColumns`
   strings and `grid-template-columns` declarations in CSS.

   RATCHET, NOT ZERO TOLERANCE. Today's offenders are listed in
   `bare-fr-track-allowlist.json` (file -> class -> count). The list may only
   shrink:
   - a new bare track anywhere, or one more in an already-listed file, fails;
   - a listed entry that is no longer in the source fails until it is removed;
   - the list's total must equal ALLOW_LIST_CEILING, so growing the JSON fails
     unless the ceiling is raised in the same diff, where review sees it.
   When you fix an offender: delete its entry and lower the ceiling.
   ============================================================================= */
import { describe, it, expect } from 'vitest';
import allowList from './bare-fr-track-allowlist.json';
import {
  allowListSize,
  diffAgainstAllowList,
  findBareFrTracks,
  sourceFiles,
  tallyFiles,
  type Tally,
} from './scan';

/** The number of allow-listed bare tracks. It only ever goes DOWN. */
const ALLOW_LIST_CEILING = 0;

const tokens = (src: string) => findBareFrTracks(src, 'x.tsx').map((o) => o.token);

describe('bare fr grid-track guard (mobile slice 12, VP-08)', () => {
  const files = sourceFiles();
  const actual = tallyFiles(files, findBareFrTracks);
  const allowed = allowList as Tally;

  it('the pattern fires on bare and auto-minimum fr tracks', () => {
    expect(tokens('<div className="grid grid-cols-[1fr_320px]">')).toEqual(['grid-cols-[1fr_320px]']);
    expect(tokens('<div className="lg:grid-cols-[188px_1fr] gap-2">')).toEqual(['grid-cols-[188px_1fr]']);
    expect(tokens("cn('grid', 'grid-cols-[1fr_auto_1fr]')")).toEqual(['grid-cols-[1fr_auto_1fr]']);
    expect(tokens('grid-cols-[repeat(3,1fr)]')).toEqual(['grid-cols-[repeat(3,1fr)]']);
    expect(tokens('grid-cols-[minmax(auto,2fr)_80px]')).toEqual(['grid-cols-[minmax(auto,2fr)_80px]']);
    expect(tokens('grid-cols-[1.5fr_minmax(0,1fr)]')).toEqual(['grid-cols-[1.5fr_minmax(0,1fr)]']);
    expect(tokens('md:[grid-template-columns:1fr_200px]')).toEqual(['[grid-template-columns:1fr_200px]']);
    expect(tokens("style={{ gridTemplateColumns: '1fr 240px' }}")).toEqual(['gridTemplateColumns: 1fr 240px']);
    expect(tokens('style={{ gridTemplateColumns: `repeat(${n}, 1fr)` }}')).toEqual([
      'gridTemplateColumns: repeat(${}, 1fr)',
    ]);
    expect(tokens('.board {\n  grid-template-columns: 200px 1fr;\n}')).toEqual([
      'grid-template-columns: 200px 1fr',
    ]);
  });

  it('the pattern stays quiet on zero-minimum tracks and on non-fr grids', () => {
    expect(tokens('lg:grid-cols-[minmax(0,1fr)_320px]')).toEqual([]);
    expect(tokens('grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_auto]')).toEqual([]);
    expect(tokens('grid-cols-[minmax(240px,1fr)_80px]')).toEqual([]);
    expect(tokens('grid-cols-[repeat(3,minmax(0,1fr))]')).toEqual([]);
    expect(tokens('grid-cols-2 md:grid-cols-3 grid-cols-[auto_80px]')).toEqual([]);
    expect(tokens('xl:[grid-template-columns:repeat(var(--kpi-n),minmax(0,1fr))]')).toEqual([]);
    expect(tokens('style={{ gridTemplateColumns: `repeat(${n}, minmax(240px, 1fr))` }}')).toEqual([]);
    expect(tokens('.board { grid-template-columns: minmax(0, 1fr) 200px; }')).toEqual([]);
    // Prose about the bug is not the bug.
    expect(tokens('// a bare 1fr track is minmax(auto, 1fr)')).toEqual([]);
    expect(tokens('  // was grid-cols-[1fr_320px], which overflowed')).toEqual([]);
    expect(tokens('   * the old `grid-cols-[1fr_320px]` shape')).toEqual([]);
  });

  it('scanned the source tree', () => {
    // A guard over an empty file list is green for the wrong reason.
    expect(files.length).toBeGreaterThan(500);
  });

  it('no bare fr track outside the allow-list - use minmax(0,1fr)', () => {
    const { grown } = diffAgainstAllowList(actual, allowed);
    expect(
      grown,
      `Use minmax(0,1fr) (and min-w-0 on the grid item) instead of a bare fr track:\n${grown.join('\n')}`,
    ).toEqual([]);
  });

  it('no stale allow-list entry - the list only shrinks', () => {
    const { stale } = diffAgainstAllowList(actual, allowed);
    expect(
      stale,
      `These offenders are fixed. Remove them from bare-fr-track-allowlist.json and lower ALLOW_LIST_CEILING:\n${stale.join('\n')}`,
    ).toEqual([]);
  });

  it('the allow-list does not grow', () => {
    expect(
      allowListSize(allowed),
      'bare-fr-track-allowlist.json must hold exactly ALLOW_LIST_CEILING entries. Never raise the ceiling to admit new code; lower it when you fix one.',
    ).toBe(ALLOW_LIST_CEILING);
  });

  it('a deliberately added offender is reported', () => {
    const planted = [...files, ['pages/Planted.tsx', '<div className="grid grid-cols-[1fr_360px]" />'] as const];
    const { grown } = diffAgainstAllowList(tallyFiles(planted, findBareFrTracks), allowed);
    expect(grown).toEqual(['pages/Planted.tsx: grid-cols-[1fr_360px] x1 (allowed 0)']);
  });
});
