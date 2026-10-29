/**
 * Signature pad sizing (mobile PRD module 10, slice 05; rubric CMP-14).
 *
 * ONE pure unit: the displayed box, the device pixel ratio and the stored strokes go in; the
 * drawing buffer's size, the scale to draw at and the strokes to redraw come out. The component
 * that hosts the pad (components/signature/SignaturePad.tsx) only applies the result.
 *
 * - The buffer is the box times the pixel ratio, so the signature is sharp on a 2x/2.625x/3x phone.
 * - The drawing library records points in CSS pixels of the box, so the context draws at exactly
 *   that ratio. Any other scale puts the ink somewhere the finger was not.
 * - Resizing a canvas wipes it. The strokes are kept and redrawn, scaled by ONE factor on both
 *   axes (never stretched), and only ever shrunk to fit: a box that gets wider (portrait to
 *   landscape) keeps the signature at the size it was drawn.
 */

export interface PadBox {
  width: number;
  height: number;
}

/** One recorded point, as the drawing library stores it (CSS px of the box it was drawn in). */
export interface SignaturePoint {
  x: number;
  y: number;
  time: number;
  color?: string;
}

/** The library's point groups: one array per stroke. */
export type SignatureStrokes = SignaturePoint[][];

/** What the host keeps between resizes: the strokes and the box they were recorded in. */
export interface StoredSignature {
  strokes: SignatureStrokes;
  box: PadBox;
}

export interface SignatureSizing {
  /** The canvas width/height attributes (device pixels). */
  buffer: { width: number; height: number };
  /** The context transform: draw CSS-pixel strokes at this scale on both axes. */
  scale: number;
  /** The strokes to redraw into the resized buffer, in CSS px of the new box. */
  strokes: SignatureStrokes;
}

/**
 * The pixel ratio to size the buffer by. Browsers zoomed out report less than 1; a buffer smaller
 * than the box would blur the ink and only partly clear, so it never goes under 1.
 */
export function effectivePixelRatio(ratio: number | undefined): number {
  return typeof ratio === 'number' && Number.isFinite(ratio) && ratio > 1 ? ratio : 1;
}

/**
 * Scale strokes recorded in `from` into `to` by one factor, shrinking only. Returns new objects;
 * the input is the host's source of truth and is never mutated.
 */
export function rescaleStrokes(strokes: SignatureStrokes, from: PadBox, to: PadBox): SignatureStrokes {
  const factor = Math.min(1, to.width / from.width, to.height / from.height);
  if (!Number.isFinite(factor) || factor === 1) return strokes.map((group) => group.map((p) => ({ ...p })));
  return strokes.map((group) => group.map((p) => ({ ...p, x: p.x * factor, y: p.y * factor })));
}

/**
 * Size the pad for a box. Null while the box has no area (not laid out yet, or hidden): sizing a
 * buffer to nothing would wipe the signature for no reason.
 */
export function sizeSignaturePad(input: {
  box: PadBox;
  pixelRatio: number | undefined;
  stored: StoredSignature | null;
}): SignatureSizing | null {
  const { box, stored } = input;
  if (!(box.width > 0) || !(box.height > 0)) return null;
  const scale = effectivePixelRatio(input.pixelRatio);
  return {
    buffer: { width: Math.round(box.width * scale), height: Math.round(box.height * scale) },
    scale,
    strokes: stored && stored.strokes.length > 0 ? rescaleStrokes(stored.strokes, stored.box, box) : [],
  };
}
