/* =============================================================================
   ServWave Design System — contrast.ts
   WCAG 2.x contrast-ratio primitives for the design-system's own guard tests.

   Added while fixing the `--event` token (calendar-entries spec §9 risk 4): the token was
   hand-computed against WHITE ("~4.7:1 on white as `text-event` - approximate") when the card
   actually composites it at low alpha over the board canvas, and the guard that was supposed to
   catch a token collapsing into another one compared CLASS-STRING identity ('bg-event/5' !==
   'bg-info/5'), which is true regardless of what the two classes resolve to on screen. Neither
   check ever touched an actual pixel. This module is the fix for BOTH: a real contrast/­distance
   computation, so a future token change that quietly fails AA or collapses two accents into the
   same rendered colour goes red instead of green.

   No dependency on the DOM or a browser - pure sRGB → WCAG relative-luminance math, so it runs
   the same under jsdom, Node, or a real browser. Not a design-token accessor (see tokens.ts's
   `token()` for that) - callers resolve a token to a hex string themselves (typically via
   `token()` or a FALLBACKS literal) and pass hex in here.
   ============================================================================= */

export type Hex = `#${string}`;

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`contrast: expected a 6-digit hex color, got "${hex}"`);
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex2(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
}

/** WCAG relative luminance of one sRGB channel triple, each 0-255. */
function relativeLuminance([r, g, b]: [number, number, number]): number {
  const chan = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const [rl, gl, bl] = [r, g, b].map(chan) as [number, number, number];
  return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
}

/**
 * WCAG contrast ratio between two sRGB hex colors. Ranges 1:1 (identical) to 21:1
 * (black vs white). AA text on a normal-size fill needs >= 4.5.
 */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(hexToRgb(a));
  const lb = relativeLuminance(hexToRgb(b));
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Alpha-composite `fg` at `alpha` (0..1) over an OPAQUE `bg` — i.e. what a browser actually
 * paints for a Tailwind `bg-event/10`-style class over its own background. Both colors sRGB hex;
 * the mix is done per-channel in sRGB space (not linear light), matching how `rgb(... / a)` +
 * standard alpha compositing renders in a browser.
 */
export function compositeOver(fg: string, alpha: number, bg: string): Hex {
  const [fr, fgr, fb] = hexToRgb(fg);
  const [br, bgr, bb] = hexToRgb(bg);
  const mix = (f: number, b: number) => f * alpha + b * (1 - alpha);
  return `#${toHex2(mix(fr, br))}${toHex2(mix(fgr, bgr))}${toHex2(mix(fb, bb))}` as Hex;
}

/**
 * Euclidean distance between two sRGB colors, each channel 0-255 — range 0 (identical) to
 * sqrt(255^2 * 3) ≈ 441.7 (black vs white). A rough perceptual-difference PROXY, not a real
 * colour-difference metric (no CIE space, no hue weighting) — good enough to catch "these two
 * fills render as effectively the same grey", not to rank fine gradations.
 */
export function rgbDistance(a: string, b: string): number {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  return Math.sqrt((ar - br) ** 2 + (ag - bg) ** 2 + (ab - bb) ** 2);
}

/** Mix each sRGB channel toward `target` (0 = black, 255 = white) by `amount` (0..1). */
function mixChannels([r, g, b]: [number, number, number], target: number, amount: number): Hex {
  const mix = (c: number) => c + (target - c) * amount;
  return `#${toHex2(mix(r))}${toHex2(mix(g))}${toHex2(mix(b))}`.toUpperCase() as Hex;
}

/** How far toward white the chip's fill sits: a light tint that still reads as the color. */
const CHIP_TINT = 0.84;
/** AA for normal-size text - the chip's 11px label is never "large". */
const CHIP_TEXT_MIN_CONTRAST = 4.5;

/**
 * The colors of a chip drawn FROM a stored color - the task category chip (design review mockup:
 * a tinted fill, dark text in the same hue, a dot in the color itself).
 *
 *  - `fill`: the color mixed most of the way to white;
 *  - `text`: the color darkened in 5% steps until it clears WCAG AA on that fill. Across the
 *    10-color Tags palette this lands on a deep shade of each hue.
 *
 * The inputs are data (`#RRGGBB` rows), not theme tokens, so the outputs are computed here rather
 * than looked up. A value that is not a 6-digit hex yields `null`; the caller falls back.
 */
export function tintedChipColors(color: string): { fill: Hex; text: Hex } | null {
  let rgb: [number, number, number];
  try {
    rgb = hexToRgb(color);
  } catch {
    return null;
  }
  const fill = mixChannels(rgb, 255, CHIP_TINT);
  for (let darken = 0.3; darken <= 1; darken += 0.05) {
    const text = mixChannels(rgb, 0, darken);
    if (contrastRatio(text, fill) >= CHIP_TEXT_MIN_CONTRAST) return { fill, text };
  }
  return { fill, text: mixChannels(rgb, 0, 1) };
}
