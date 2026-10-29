/**
 * Mobile slice 05 (PRD module 10, stories 109/110/119, rubric CMP-14): signature sizing is ONE
 * pure unit. Box size, pixel ratio and the stored strokes go in; the drawing buffer's size, the
 * drawing scale and the strokes to redraw come out. The page only hosts it.
 *
 * What it replaces (audit F20): the buffer was stuck at its 600x128 default on every phone, so the
 * ink landed at the wrong scale, and a resize/rotation silently wiped the signature.
 */
import { describe, it, expect } from 'vitest';
import {
  effectivePixelRatio,
  rescaleStrokes,
  sizeSignaturePad,
  type SignatureStrokes,
} from '@/lib/signature-sizing';

const stroke = (pts: Array<[number, number]>) => pts.map(([x, y], i) => ({ x, y, time: 1000 + i * 16, color: 'black' }));

/** A short diagonal plus a dot, drawn in a 302 x 160 box (an iPhone SE in portrait). */
const DRAWN_IN = { width: 302, height: 160 };
const STROKES: SignatureStrokes = [stroke([[20, 40], [60, 80], [100, 120]]), stroke([[150, 30]])];

/** The bounding box of every point, for "unstretched" checks. */
function bounds(strokes: SignatureStrokes) {
  const xs = strokes.flat().map((p) => p.x);
  const ys = strokes.flat().map((p) => p.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

describe('sizeSignaturePad - the buffer is the displayed box times the pixel ratio', () => {
  it.each([1, 2, 2.625, 3])('at pixel ratio %s', (ratio) => {
    const box = { width: 302, height: 160 };
    const out = sizeSignaturePad({ box, pixelRatio: ratio, stored: null });
    expect(out).not.toBeNull();
    expect(out!.buffer).toEqual({ width: Math.round(302 * ratio), height: Math.round(160 * ratio) });
    // Strokes are recorded in CSS pixels of the box, so the context must draw them at the SAME
    // ratio the buffer was grown by. Any other scale puts the ink somewhere the finger was not.
    expect(out!.scale).toBe(ratio);
    expect(out!.buffer.width / out!.scale).toBeCloseTo(box.width, 0);
    expect(out!.buffer.height / out!.scale).toBeCloseTo(box.height, 0);
  });

  it('never returns the old 600x128 default for a phone box', () => {
    const out = sizeSignaturePad({ box: { width: 302, height: 160 }, pixelRatio: 2, stored: null })!;
    expect(out.buffer).not.toEqual({ width: 600, height: 128 });
  });

  it('sizes nothing while the box has no area (hidden or not laid out yet)', () => {
    expect(sizeSignaturePad({ box: { width: 0, height: 160 }, pixelRatio: 2, stored: null })).toBeNull();
    expect(sizeSignaturePad({ box: { width: 302, height: 0 }, pixelRatio: 2, stored: null })).toBeNull();
  });

  it('treats a missing, zero or zoomed-out pixel ratio as 1', () => {
    expect(effectivePixelRatio(undefined)).toBe(1);
    expect(effectivePixelRatio(0)).toBe(1);
    expect(effectivePixelRatio(Number.NaN)).toBe(1);
    expect(effectivePixelRatio(0.8)).toBe(1);
    expect(effectivePixelRatio(2.625)).toBe(2.625);
  });

  it('redraws nothing when nothing is stored', () => {
    const out = sizeSignaturePad({ box: { width: 302, height: 160 }, pixelRatio: 3, stored: null })!;
    expect(out.strokes).toEqual([]);
  });
});

describe('sizeSignaturePad - strokes survive a resize, unstretched', () => {
  it('redraws the stored strokes unchanged when the box is the same size', () => {
    const out = sizeSignaturePad({ box: DRAWN_IN, pixelRatio: 3, stored: { strokes: STROKES, box: DRAWN_IN } })!;
    expect(out.strokes).toEqual(STROKES);
  });

  it('keeps the signature at its size when the box only gets wider (portrait -> landscape)', () => {
    const landscape = { width: 638, height: 160 };
    const out = sizeSignaturePad({ box: landscape, pixelRatio: 3, stored: { strokes: STROKES, box: DRAWN_IN } })!;
    expect(out.buffer).toEqual({ width: 638 * 3, height: 480 });
    // Width grew 2.1x, height did not: a per-axis scale would stretch it sideways.
    expect(out.strokes).toEqual(STROKES);
  });

  it('shrinks the signature uniformly so it still fits when the box gets narrower', () => {
    const drawnWide = { width: 638, height: 160 };
    const wide = [stroke([[40, 20], [600, 140]])];
    const out = sizeSignaturePad({ box: DRAWN_IN, pixelRatio: 2, stored: { strokes: wide, box: drawnWide } })!;
    const s = 302 / 638;
    const b = bounds(out.strokes);
    expect(b.maxX).toBeLessThanOrEqual(302);
    expect(b.maxY).toBeLessThanOrEqual(160);
    // Same factor on both axes, so the aspect ratio of the ink is the one the customer drew.
    expect(out.strokes[0]![0]).toMatchObject({ x: 40 * s, y: 20 * s });
    expect(out.strokes[0]![1]).toMatchObject({ x: 600 * s, y: 140 * s });
    const before = (600 - 40) / (140 - 20);
    expect((b.maxX - b.minX) / (b.maxY - b.minY)).toBeCloseTo(before, 6);
  });

  it('keeps every point attribute except the position (time drives the stroke width)', () => {
    const out = rescaleStrokes(STROKES, DRAWN_IN, { width: 151, height: 80 });
    expect(out[0]![1]).toEqual({ x: 30, y: 40, time: STROKES[0]![1]!.time, color: 'black' });
    // The input is never mutated: the stored copy must stay the source of truth.
    expect(STROKES[0]![1]).toMatchObject({ x: 60, y: 80 });
  });

  it('round-trips: narrow then back to the original box restores the original strokes', () => {
    const stored = { strokes: STROKES, box: DRAWN_IN };
    const narrow = sizeSignaturePad({ box: { width: 200, height: 160 }, pixelRatio: 3, stored })!;
    expect(narrow.strokes).not.toEqual(STROKES);
    // The host keeps the ORIGINAL stored copy, so coming back is exact, not a lossy double scale.
    const back = sizeSignaturePad({ box: DRAWN_IN, pixelRatio: 3, stored })!;
    expect(back.strokes).toEqual(STROKES);
  });
});
