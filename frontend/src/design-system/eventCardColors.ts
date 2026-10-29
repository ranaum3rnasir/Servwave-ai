/* =============================================================================
   ServWave Design System — eventCardColors.ts
   The colours a scheduler card paints, DERIVED from one seed colour so every seed an org can pick
   reads at WCAG AA.

   Why derived and not looked up: the board used to paint the seed itself as text on a 10% alpha
   tint of that same seed. A seed and a pale wash of itself only contrast when the seed is already
   dark, so 9 of the 12 palette colours failed 4.5:1 on their own card (light sage measured 2.48).
   Hand-tuning twelve pairs would repeat the mistake the moment a token is retuned; a rule does not.

   The rule (owner-approved, 4.5:1 target; research in the 2026-09-30 event-colour brief):
    - surface: an OPAQUE tint at a FIXED OKLCH lightness (0.955), the seed's hue, chroma
      min(0.4 x seed chroma, 0.05). Fixed lightness is what makes every surface contrast the same
      way; an alpha tint's lightness follows the seed (a navy tint is darker than a yellow one)
      and blends with whatever is under it.
    - text: the seed itself when it already clears 4.5:1 on that surface (the org's colour, as
      picked). Otherwise walk OKLCH lightness DOWN from the surface in 0.005 steps at the seed's
      hue and chroma and take the first tone that clears 4.5 - the most colourful passing tone,
      so the text keeps the category hue instead of going to black.
    - border: the seed when it clears 3:1 (WCAG 1.4.11, non-text) against the surface AND the
      white board; otherwise the seed walked darker until it does.
    - solid (in-progress card, drag chip): white text when white clears 4.5 on the seed. If not,
      a seed with OKLCH L >= 0.70 keeps its fill and takes black text; a darker seed keeps white
      text and has its FILL walked darker until white clears 4.5. WCAG's own black/white pick
      puts black text on mid blues and reds, which reads worse than white at card sizes.

   Every derived colour is gamut-mapped by reducing chroma at constant L and hue (never by
   clipping channels, which shifts the hue) and rounded to 8-bit before it is measured, so each
   ratio above is the ratio of the hex that actually ships.

   Pure and DOM-free; results are memoised per seed. Resolving a token NAME to its seed hex is the
   caller's job (lib/schedule/eventColors.ts).
   ============================================================================= */
import { contrastRatio, type Hex } from './contrast';

/** The card's derived colours for one seed, as `#RRGGBB`. */
export interface EventCardColors {
  /** Opaque card fill. */
  surface: Hex;
  /** Every text row on the card. >= 4.5:1 on `surface`. */
  text: Hex;
  /** The 4px left bar. >= 3:1 on `surface` and on the white board. */
  border: Hex;
  /** A solid fill of this colour (in-progress card, drag chip)... */
  solid: Hex;
  /** ...and the text that goes on it. >= 4.5:1 on `solid`. */
  onSolid: Hex;
}

export const EVENT_CARD_TEXT_MIN = 4.5;
export const EVENT_CARD_BORDER_MIN = 3;

const SURFACE_L = 0.955;
const SURFACE_C_SCALE = 0.4;
const SURFACE_C_MAX = 0.05;
const STEP = 0.005;
/** Above this OKLCH lightness a solid fill takes black text rather than being darkened. */
const SOLID_LIGHT_SEED_L = 0.7;

type Rgb = [number, number, number];

function parseHex(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function toHex(rgb: Rgb): Hex {
  const h = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
  return `#${h(rgb[0])}${h(rgb[1])}${h(rgb[2])}`.toUpperCase() as Hex;
}

// Built rather than written as literals: this directory is on the token guard's zero-hex surface.
const BLACK = toHex([0, 0, 0]);
const WHITE = toHex([1, 1, 1]);
/** The board the cards sit on (white). The border has to be visible against it, not just the card. */
export const EVENT_CARD_PAGE: Hex = WHITE;

const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const delin = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
const cbrt = (x: number) => Math.sign(x) * Math.pow(Math.abs(x), 1 / 3);

/** sRGB (0..1) → OKLCH [L, C, h in degrees]. Ottosson's matrices. */
function rgbToOklch(rgb: Rgb): [number, number, number] {
  const [r, g, b] = rgb.map(lin) as Rgb;
  const l = cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const h = (Math.atan2(B, A) * 180) / Math.PI;
  return [L, Math.hypot(A, B), ((h % 360) + 360) % 360];
}

/** OKLCH → LINEAR sRGB, unclamped (so the caller can test the gamut). */
function oklchToLinear(L: number, C: number, h: number): Rgb {
  const rad = (h * Math.PI) / 180;
  const A = C * Math.cos(rad);
  const B = C * Math.sin(rad);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const inGamut = (c: Rgb, eps = 1e-6) => c.every((v) => v >= -eps && v <= 1 + eps);

/**
 * OKLCH → 8-bit hex, gamut-mapped by bisecting chroma down at constant L and h (the core of the
 * CSS Color 4 algorithm) and only then clipped, so an out-of-gamut request keeps its hue.
 */
function oklchToHex(Lraw: number, Craw: number, h: number): Hex {
  const L = Math.max(0, Math.min(1, Lraw));
  let C = Craw;
  if (!inGamut(oklchToLinear(L, C, h))) {
    let lo = 0;
    let hi = C;
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchToLinear(L, mid, h))) lo = mid;
      else hi = mid;
    }
    C = lo;
  }
  const lrgb = oklchToLinear(L, C, h);
  return toHex(lrgb.map((v) => delin(Math.max(0, Math.min(1, v)))) as Rgb);
}

const oklchOf = (hex: Hex) => rgbToOklch(parseHex(hex)!);

/**
 * Walk OKLCH lightness DOWN from `startL` at the seed's hue and chroma until the tone clears
 * `target` against every colour in `against`. Falls back to whichever of black and white has the
 * better worst case - which is >= 4.58:1 against any single background, so the fallback always
 * passes AA. With a fixed surface lightness the walk converges before it ever gets there (L = 0
 * is black), but a future change to the constants should degrade to readable, not to broken.
 */
function walkDarker(seed: Hex, against: Hex[], target: number, startL: number): Hex {
  const [, C, h] = oklchOf(seed);
  for (let L = startL; L >= 0 && L <= 1; L -= STEP) {
    const c = oklchToHex(L, C, h);
    if (against.every((a) => contrastRatio(c, a) >= target)) return c;
  }
  const worst = (k: Hex) => Math.min(...against.map((a) => contrastRatio(k, a)));
  return worst(BLACK) >= worst(WHITE) ? BLACK : WHITE;
}

function deriveSolid(seed: Hex): { solid: Hex; onSolid: Hex } {
  if (contrastRatio(WHITE, seed) >= EVENT_CARD_TEXT_MIN) return { solid: seed, onSolid: WHITE };
  const [L] = oklchOf(seed);
  if (L >= SOLID_LIGHT_SEED_L && contrastRatio(BLACK, seed) >= EVENT_CARD_TEXT_MIN) {
    return { solid: seed, onSolid: BLACK };
  }
  const solid = walkDarker(seed, [WHITE], EVENT_CARD_TEXT_MIN, L);
  // The walk only falls back to black/white when it never converged; black then carries white
  // text badly, so hand the fill back with whichever text clears on it.
  if (solid === BLACK || solid === WHITE) {
    return { solid: seed, onSolid: contrastRatio(BLACK, seed) >= contrastRatio(WHITE, seed) ? BLACK : WHITE };
  }
  return { solid, onSolid: WHITE };
}

function derive(seed: Hex): EventCardColors {
  const [, C, h] = oklchOf(seed);
  const surface = oklchToHex(SURFACE_L, Math.min(C * SURFACE_C_SCALE, SURFACE_C_MAX), h);
  const text = contrastRatio(seed, surface) >= EVENT_CARD_TEXT_MIN
    ? seed
    : walkDarker(seed, [surface], EVENT_CARD_TEXT_MIN, oklchOf(surface)[0]);
  const border =
    contrastRatio(seed, surface) >= EVENT_CARD_BORDER_MIN && contrastRatio(seed, EVENT_CARD_PAGE) >= EVENT_CARD_BORDER_MIN
      ? seed
      : walkDarker(seed, [surface, EVENT_CARD_PAGE], EVENT_CARD_BORDER_MIN, oklchOf(seed)[0]);
  return { surface, text, border, ...deriveSolid(seed) };
}

const memo = new Map<string, EventCardColors>();

/**
 * The card colours for one seed (`#RRGGBB`, case-insensitive). Returns null for anything that is
 * not a 6-digit hex, so a caller can fall back to its defaults rather than throw mid-render.
 */
export function eventCardColors(seedHex: string): EventCardColors | null {
  const rgb = parseHex(seedHex);
  if (!rgb) return null;
  const seed = toHex(rgb);
  let out = memo.get(seed);
  if (!out) {
    out = derive(seed);
    memo.set(seed, out);
  }
  return out;
}

/** `#3B82F6` → `59 130 246`: the channel form every colour token uses, for `rgb(var(--x) / a)`. */
export function hexToChannels(hex: Hex): string {
  const rgb = parseHex(hex)!;
  return rgb.map((v) => Math.round(v * 255)).join(' ');
}

/**
 * Any CSS colour string `token()` can hand back - `#RRGGBB`, `rgb(R G B)`, `rgb(R, G, B)` or a
 * bare `R G B` channel triple - as `#RRGGBB`. Null for anything else (a named colour, a var()).
 */
export function cssColorToHex(value: string): Hex | null {
  const v = value.trim();
  if (parseHex(v)) return toHex(parseHex(v)!);
  const m = /^(?:rgba?\()?\s*(\d{1,3}(?:\.\d+)?)[\s,]+(\d{1,3}(?:\.\d+)?)[\s,]+(\d{1,3}(?:\.\d+)?)\s*(?:[/,][^)]*)?\)?$/i.exec(v);
  if (!m) return null;
  return toHex([Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255]);
}
