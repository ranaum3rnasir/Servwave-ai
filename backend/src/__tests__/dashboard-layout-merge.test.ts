/* =============================================================================
   Roles & Permissions, PRD 9, slice S09.4 - what saving a dashboard layout keeps and drops.

   Seam: `mergeSavedLayout` and `availableLayout` (lib/dashboard/layout). A person saves the whole layout they were
   sent; the layout they were sent held only the tiles they can have, so a tile they lost access to (their switches
   changed) must survive the save in its old place, and an id the catalog does not know must not be stored.
   ========================================================================== */
import { describe, it, expect } from 'vitest';
import { availableLayout, layoutWithLostTiles, mergeSavedLayout, UnavailableTileError, withNewDefaultTiles, type LayoutEntry } from '../lib/dashboard/layout';
import { TILE_CATALOG } from '../lib/dashboard/tileCatalog';

const [A, B, C, D] = TILE_CATALOG.slice(0, 4).map((t) => t.id) as [string, string, string, string];
const shown = (id: string, extra: Partial<LayoutEntry> = {}): LayoutEntry => ({ id, visible: true, ...extra });
const ids = (layout: LayoutEntry[]) => layout.map((e) => e.id);
const can = (...allowed: string[]) => (id: string) => allowed.includes(id);

describe('mergeSavedLayout', () => {
  it('stores the order, visibility, size and range the person sent', () => {
    const sent = [shown(C, { size: 'full', range: '7d' }), { id: A, visible: false, size: 'kpi' as const }, shown(B)];
    expect(mergeSavedLayout(null, sent, can(A, B, C))).toEqual(sent);
  });

  it('drops an id the catalog does not know, and a repeated id', () => {
    const merged = mergeSavedLayout(null, [shown(A), shown('tile.that.never.existed'), shown(A, { size: 'full' }), shown(B)], can(A, B));
    expect(merged).toEqual([shown(A), shown(B)]);
  });

  it('drops a tile the person cannot have when it was not stored before and is sent hidden (nothing is turned on)', () => {
    expect(mergeSavedLayout(null, [shown(A), { id: B, visible: false }], can(A))).toEqual([shown(A)]);
    expect(mergeSavedLayout([shown(A)], [{ id: B, visible: false }, shown(A)], can(A))).toEqual([shown(A)]);
  });

  it('refuses a save that turns a tile the person cannot have from not stored into shown', () => {
    expect(() => mergeSavedLayout(null, [shown(A), shown(B)], can(A))).toThrow(UnavailableTileError);
    expect(() => mergeSavedLayout([shown(A)], [shown(B), shown(A)], can(A))).toThrow(UnavailableTileError);
  });

  it('refuses a save that turns a tile the person cannot have from hidden into shown, and names the tile', () => {
    const stored = [shown(A), { id: B, visible: false }];
    const refusal = (() => { try { mergeSavedLayout(stored, [shown(A), shown(B)], can(A)); } catch (e) { return e; } })();
    expect(refusal).toBeInstanceOf(UnavailableTileError);
    expect((refusal as UnavailableTileError).tileIds).toEqual([B]);
  });

  it('does not refuse a lost tile that is sent as it is stored, hidden or shown, or sent hidden over a shown one', () => {
    const stored = [shown(A), { id: B, visible: false }, shown(C)];
    expect(mergeSavedLayout(stored, [shown(A), { id: B, visible: false }, shown(C)], can(A))).toEqual(stored);
    expect(mergeSavedLayout([shown(A), shown(B)], [shown(A), shown(B)], can(A))).toEqual([shown(A), shown(B)]);
    expect(mergeSavedLayout([shown(A), shown(B)], [shown(A), { id: B, visible: false }], can(A))).toEqual([shown(A), shown(B)]);
  });

  it('never refuses an id the catalog does not know', () => {
    expect(mergeSavedLayout(null, [shown(A), shown('tile.that.never.existed')], can(A))).toEqual([shown(A)]);
  });

  it('keeps a tile the person lost in its old place when they reorder the others (they never saw it, so it is not sent)', () => {
    const stored = [shown(A), shown(B, { size: 'half', range: 'month' }), shown(C), shown(D)];
    expect(ids(mergeSavedLayout(stored, [shown(D), shown(C), shown(A)], can(A, C, D)))).toEqual([D, C, A, B]);
    // ... and back in the same place after the tile it followed, with its own stored size and range.
    expect(mergeSavedLayout(stored, [shown(D), shown(C), shown(A)], can(A, C, D))[3]).toEqual(shown(B, { size: 'half', range: 'month' }));
  });

  it('keeps the stored state of a lost tile whatever the client sends for it', () => {
    const stored = [shown(A), shown(B, { size: 'half', range: 'month' }), shown(C)];
    const merged = mergeSavedLayout(stored, [shown(A), { id: B, visible: false, size: 'full', range: '7d' }, shown(C)], can(A, C));
    expect(merged).toEqual(stored);
    // A hidden lost tile stays hidden with its own size, however it comes back.
    const hidden = [shown(A), { id: B, visible: false, size: 'kpi' as const }, shown(C)];
    expect(mergeSavedLayout(hidden, [shown(C), { id: B, visible: false, size: 'full' }, shown(A)], can(A, C))).toEqual([shown(C), shown(A), { id: B, visible: false, size: 'kpi' }]);
  });

  it('keeps several lost tiles together behind the tile they followed, and one that led the list at the front', () => {
    const stored = [shown(A), shown(B), shown(C), shown(D)];
    expect(ids(mergeSavedLayout(stored, [shown(D)], can(D)))).toEqual([A, B, C, D]);
    expect(ids(mergeSavedLayout(stored, [shown(D), shown(C)], can(C, D)))).toEqual([A, B, D, C]);
  });

  it('puts a lost tile at the end when the tile it followed is no longer in the layout', () => {
    // A is theirs and was dropped from what they sent, so it is kept hidden in its place (a removal); B (lost) follows it.
    expect(mergeSavedLayout([shown(A), shown(B)], [shown(C)], can(A, C))).toEqual([{ id: A, visible: false }, shown(B), shown(C)]);
    // Behind a tile the catalog has since retired, B has nothing to follow and leads the list.
    expect(ids(mergeSavedLayout([shown('tile.retired'), shown(B)], [shown(C)], can(C)))).toEqual([B, C]);
  });

  it('keeps a tile the person can have but left out of a save, hidden and in its place, with its size and range (a removal)', () => {
    const stored = [shown(A), shown(B, { size: 'half', range: 'month' }), shown(C)];
    expect(mergeSavedLayout(stored, [shown(C), shown(A)], can(A, B, C))).toEqual([
      shown(C), shown(A), { id: B, visible: false, size: 'half', range: 'month' },
    ]);
    // Nothing left out, nothing hidden by the merge; a tile that was never stored is not invented.
    expect(mergeSavedLayout(stored, [shown(C), shown(B), shown(A), shown(D)], can(A, B, C, D))).toEqual([shown(C), shown(B), shown(A), shown(D)]);
    expect(mergeSavedLayout(null, [shown(A)], can(A, B))).toEqual([shown(A)]);
  });

  it('forgets a stored id the catalog has since retired', () => {
    expect(ids(mergeSavedLayout([shown('tile.retired'), shown(A)], [shown(A)], can(A)))).toEqual([A]);
  });
});

describe('layoutWithLostTiles', () => {
  it('sends a stored tile the person cannot have back in its place, flagged not available, with its stored state', () => {
    const stored = [shown(C), shown(B, { size: 'half', range: 'month' }), { id: A, visible: false }];
    expect(layoutWithLostTiles(stored, can(C, A))).toEqual([shown(C), { ...shown(B, { size: 'half', range: 'month' }), available: false }, { id: A, visible: false }]);
  });

  it('leaves the flag off every tile the person has, and leaves out an id the catalog does not know', () => {
    const merged = layoutWithLostTiles([shown('tile.retired'), shown(A)], can(A));
    expect(merged).toEqual([shown(A)]);
    expect(merged[0]).not.toHaveProperty('available');
  });
});

describe('availableLayout', () => {
  it('leaves out the tiles the person cannot have and any id the catalog does not know, keeping the order', () => {
    const stored = [shown(C), shown(B), shown('tile.retired'), shown(A, { size: 'third' })];
    expect(availableLayout(stored, can(A, C))).toEqual([shown(C), shown(A, { size: 'third' })]);
  });
});

describe('withNewDefaultTiles', () => {
  it('adds the default tiles the saved layout lacks at the end, shown, in the default\'s order', () => {
    expect(withNewDefaultTiles([shown(D), shown(A)], [shown(A), shown(B), shown(C)])).toEqual([shown(D), shown(A), shown(B), shown(C)]);
  });

  it('adds nothing for a tile the saved layout holds in any state: hidden, resized, or lost', () => {
    const saved = [{ id: A, visible: false }, shown(B, { size: 'full' }), { ...shown(C), available: false as const }];
    expect(withNewDefaultTiles(saved, [shown(A), shown(B), shown(C)])).toEqual(saved);
  });

  it('leaves an empty default alone', () => {
    expect(withNewDefaultTiles([shown(A)], [])).toEqual([shown(A)]);
  });
});
