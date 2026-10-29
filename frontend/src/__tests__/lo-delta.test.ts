// loDelta — PROCESSED-edit delta hint (spec §12 rec 7). Pure function, no React.
//
// Contract under test:
//   • Net-by-location: editedTotal − currentTotal per location. Positive ⇒ consume, negative ⇒ return.
//   • The M5 line-ops rows all reduce to that net: add ⇒ consume, remove ⇒ return, qty up ⇒ consume
//     the delta, qty down ⇒ return the delta, location change ⇒ return old + consume new.
//   • A location whose net collapses to zero is omitted; an all-zero delta yields a null hint.
//   • Unplaced lines (from_location_id null) never move stock and are skipped.
//   • Unknown location id → neutral fallback label (never a raw UUID).
//   • Sentence shape: "Saving returns X to A and consumes Y from B." (returns / consumes / mixed / no-op).
import { describe, it, expect } from 'vitest';
import {
  computeLoProcessedDelta,
  describeLoProcessedDelta,
  loProcessedDeltaHint,
  type LoDeltaLine,
} from '@/components/inventory/lo/loDelta';

const MAIN = 'loc-main';
const VAN = 'loc-van';
const NAMES: Record<string, string> = { [MAIN]: 'Main Warehouse', [VAN]: 'Van 12' };
const resolve = (id: string): string | undefined => NAMES[id];
const line = (qty: number, loc: string | null): LoDeltaLine => ({ qty, from_location_id: loc });

const hint = (current: LoDeltaLine[], edited: LoDeltaLine[]) =>
  loProcessedDeltaHint(current, edited, resolve);

describe('computeLoProcessedDelta — the M5 line-ops rows reduce to net-by-location', () => {
  it('add line ⇒ consume its qty from its location', () => {
    const d = computeLoProcessedDelta([], [line(3, VAN)], resolve);
    expect(d.returns).toEqual([]);
    expect(d.consumes).toEqual([{ locationId: VAN, locationName: 'Van 12', qty: 3 }]);
  });

  it('remove line ⇒ return its qty to its location', () => {
    const d = computeLoProcessedDelta([line(2, MAIN)], [], resolve);
    expect(d.consumes).toEqual([]);
    expect(d.returns).toEqual([{ locationId: MAIN, locationName: 'Main Warehouse', qty: 2 }]);
  });

  it('qty down at the same location ⇒ return the delta', () => {
    const d = computeLoProcessedDelta([line(5, MAIN)], [line(3, MAIN)], resolve);
    expect(d.returns).toEqual([{ locationId: MAIN, locationName: 'Main Warehouse', qty: 2 }]);
    expect(d.consumes).toEqual([]);
  });

  it('qty up at the same location ⇒ consume the delta', () => {
    const d = computeLoProcessedDelta([line(3, MAIN)], [line(5, MAIN)], resolve);
    expect(d.consumes).toEqual([{ locationId: MAIN, locationName: 'Main Warehouse', qty: 2 }]);
    expect(d.returns).toEqual([]);
  });

  it('location change ⇒ return the old location and consume the new (mixed)', () => {
    const d = computeLoProcessedDelta([line(3, MAIN)], [line(3, VAN)], resolve);
    expect(d.returns).toEqual([{ locationId: MAIN, locationName: 'Main Warehouse', qty: 3 }]);
    expect(d.consumes).toEqual([{ locationId: VAN, locationName: 'Van 12', qty: 3 }]);
  });

  it('nets opposing moves at one location to zero and omits it', () => {
    // 5 at Main → split into 3 + 2 at Main: editedTotal 5 === currentTotal 5 ⇒ nothing moves.
    const d = computeLoProcessedDelta([line(5, MAIN)], [line(3, MAIN), line(2, MAIN)], resolve);
    expect(d.returns).toEqual([]);
    expect(d.consumes).toEqual([]);
  });

  it('nets a return and a bigger consume at one location to a single consume', () => {
    // Main: current 5, edited 3 (−2) plus a new 4 (+4) ⇒ net +2 ⇒ consume 2, one row.
    const d = computeLoProcessedDelta([line(5, MAIN)], [line(3, MAIN), line(4, MAIN)], resolve);
    expect(d.returns).toEqual([]);
    expect(d.consumes).toEqual([{ locationId: MAIN, locationName: 'Main Warehouse', qty: 2 }]);
  });

  it('rounds fractional nets to 2 dp', () => {
    const d = computeLoProcessedDelta([line(2.5, MAIN)], [line(1, MAIN)], resolve);
    expect(d.returns).toEqual([{ locationId: MAIN, locationName: 'Main Warehouse', qty: 1.5 }]);
  });

  it('skips unplaced lines (from_location_id null)', () => {
    const d = computeLoProcessedDelta([], [line(3, null)], resolve);
    expect(d.returns).toEqual([]);
    expect(d.consumes).toEqual([]);
  });

  it('falls back to a neutral label for an unknown location id', () => {
    const d = computeLoProcessedDelta([], [line(1, 'loc-ghost')], resolve);
    expect(d.consumes[0].locationName).toBe('another location');
  });
});

describe('describeLoProcessedDelta / loProcessedDeltaHint — the sentence', () => {
  it('no-op ⇒ null', () => {
    expect(hint([line(2, MAIN)], [line(2, MAIN)])).toBeNull();
    expect(describeLoProcessedDelta({ returns: [], consumes: [] })).toBeNull();
  });

  it('returns only', () => {
    expect(hint([line(5, MAIN)], [line(3, MAIN)])).toBe('Saving returns 2 to Main Warehouse.');
  });

  it('consumes only', () => {
    expect(hint([], [line(3, VAN)])).toBe('Saving consumes 3 from Van 12.');
  });

  it('mixed — returns to one, consumes from another', () => {
    expect(hint([line(3, MAIN)], [line(3, VAN)])).toBe(
      'Saving returns 3 to Main Warehouse and consumes 3 from Van 12.',
    );
  });

  it('several locations on one side are comma-joined in a stable order', () => {
    const delta = describeLoProcessedDelta({
      returns: [
        { locationId: VAN, locationName: 'Van 12', qty: 5 },
        { locationId: MAIN, locationName: 'Main Warehouse', qty: 2 },
      ],
      consumes: [],
    });
    expect(delta).toBe('Saving returns 5 to Van 12, 2 to Main Warehouse.');
  });
});
