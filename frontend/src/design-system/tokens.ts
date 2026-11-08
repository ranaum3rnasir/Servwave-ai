/* =============================================================================
   ServWave Design System — tokens.ts
   Typed, dependency-free, SSR-safe accessor for JS/charts. ONE place where
   non-CSS consumers (Recharts, canvas, inline SVG) read the SAME tokens defined
   in tokens.css. Never inline a hex in a chart — read it from here.
   ============================================================================= */

/**
 * Static fallback map (hex) used when the live CSS var cannot be resolved —
 * jsdom/test runs, SSR, or before tokens.css has applied. Keeps `token()` from
 * ever returning an empty string. Values mirror tokens.css.
 */
const FALLBACKS: Record<string, string> = {
  // semantic
  '--primary': '#0C2D3A',
  '--primary-dark': '#071F2B',
  '--primary-light': '#123F50',
  '--primary-subtle': '#E8EEF0',
  '--success': '#2F7D5D',
  '--warning': '#B45309',
  '--danger': '#BF5A4C',
  '--ai': '#5B6DFF',
  '--info': '#3B82F6',
  '--notify': '#F43F5E',
  '--event': '#5A5A2E', // Calendar Entry board accent — slice 03/06 (calendar-entries spec §3), AA-corrected (5.48:1 on the real 10% composite)
  '--background-light': '#EEF1F3',
  '--surface-light': '#FFFFFF',
  '--border-color': '#E4E8EC',
  '--border-soft': '#EEF1F3',
  '--text-primary': '#10202B',
  '--text-secondary': '#667985',
  '--text-soft': '#8A9AA5',
  // status scale - four roles per family. These were added to tokens.css but
  // never mirrored here, so every token('--success-strong')-style read fell
  // through to '#000000' under jsdom/SSR. Contrast proof lives in tokens.css.
  '--success-surface': '#EEF8F2',
  '--success-border': '#BFDACB',
  '--success-text': '#2F7D5D',
  '--success-strong': '#2F7D5D',
  '--warning-surface': '#FBF1E5',
  '--warning-border': '#E7B666',
  '--warning-text': '#B35309',
  '--warning-strong': '#B45309',
  '--danger-surface': '#F7ECEA',
  '--danger-border': '#E8C7C1',
  '--danger-text': '#AC5144',
  '--danger-strong': '#BB584A',
  '--info-surface': '#EBF2FE',
  '--info-border': '#CEE0FD',
  '--info-text': '#316CCC',
  '--info-strong': '#3473DA',
  '--ai-surface': '#F3F0FF',
  '--ai-border': '#D8D0FF',
  '--ai-text': '#5160E2',
  '--ai-strong': '#5668F2',
  '--neutral-surface': '#EEF1F3',
  '--neutral-border': '#E4E8EC',
  '--neutral-text': '#5E707B',
  '--neutral-strong': '#667985',
  '--text-on-fill': '#FFFFFF',
  '--scrim': '#000000',
  '--table-header': '#F3F5F7',
  '--card-header': '#F3F5F7',
  // primitives
  '--ocean-900': '#071F2B',
  '--ocean-800': '#0C2D3A',
  '--ocean-700': '#123F50',
  '--green-700': '#2F7D5D',
  '--sage-50': '#EEF8F2',
  '--sage-200': '#BFDACB',
  '--sage-500': '#6BAA8F',
  '--sage-700': '#2F7D5D',
  '--amber-700': '#B45309',
  '--terracotta': '#BF5A4C',
  '--indigo-600': '#5B6DFF',
  '--olive-700': '#5A5A2E', // Calendar Entry board accent — slice 03/06, AA-corrected (see tokens.css)
  '--ai-50': '#F3F0FF',
  '--ai-200': '#D8D0FF',
  '--ai-500': '#8B7CF8',
  '--ai-600': '#5B6DFF',
  '--ai-300': '#97A3FF',
  '--ai-gradient-to': '#7B5BFF',
  '--danger-on-dark': '#FFB3A6',
  '--warning-on-dark': '#FCD34D',
  '--ai-night-top': '#0D1330',
  '--ai-night-bottom': '#090E20',
  '--amber-900': '#78350F',
  // The v2 status hues (tokens-v2.css). Five of the twelve scheduler event colours an org can pick
  // (scheduleEventPalette.ts) are these, and the card-colour rule resolves every pick through
  // token() - without these, a jsdom/SSR read of an org's "Green" derived its card from black.
  '--status-green': '#0D9668',
  '--status-blue': '#2563C9',
  '--status-amber': '#C07C14',
  '--status-purple': '#7048C4',
  '--status-slate': '#5B6B73',
  // channel brand (third-party, not themed)
  '--channel-whatsapp': '#25D366',
  '--channel-whatsapp-dark': '#1EBE5D',
  '--channel-whatsapp-bubble': '#D9FDD3',
  '--channel-whatsapp-canvas': '#EFEAE2',
  // tints
  '--green-bg': '#EEF8F2',
  '--amber-bg': '#FBF1E5',
  '--red-bg': '#F7ECEA',
  '--indigo-bg': '#F3F0FF',
  '--green-mid': '#6EA886',
  '--green-light': '#B9D9C8',
  '--amber-light': '#E7B666',
};

/** True when we have a DOM to read computed styles from. */
function canReadDom(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof document !== 'undefined' &&
    typeof getComputedStyle === 'function' &&
    !!document.documentElement
  );
}

/**
 * Resolve a design token to a CSS color string.
 *
 * Reads the live CSS custom property from :root. Channel-format values
 * (`12 45 58`) are wrapped as `rgb(12 45 58)`. Already-complete values
 * (hex / rgb() / named) are returned as-is. Falls back to the static hex map
 * (then `#000000`) when the DOM is unavailable or the var is unset — so the
 * return is never an empty string.
 *
 * @param name CSS custom property name, e.g. '--primary' or '--success'.
 */
export function token(name: string): string {
  let raw = '';
  if (canReadDom()) {
    raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }
  if (!raw) {
    return FALLBACKS[name] ?? '#000000';
  }
  // Channel format: "R G B" (optionally "R G B / A") → wrap in rgb().
  if (/^[\d.]+\s+[\d.]+\s+[\d.]+/.test(raw)) {
    return `rgb(${raw})`;
  }
  return raw;
}

/**
 * Categorical chart palette (spec order): green, teal/ocean, indigo, amber, slate.
 * Use for series that have no inherent semantic color.
 */
export const chartPalette: string[] = [
  '#2F7D5D', // green  — sage-700
  '#0C2D3A', // teal/ocean — ocean-800
  '#5B6DFF', // indigo — ai-600
  '#B45309', // amber  — amber-700
  '#667985', // slate  — text-secondary
];

/**
 * Severity ramp (green → terracotta) for AR aging and other "worse as it goes"
 * scales. Spec order, current → most severe.
 */
export const severityRamp: string[] = [
  '#2F7D5D', // healthy / current
  '#6B8F5E',
  '#C99A3C',
  '#C17A43',
  '#BF5A4C',
  '#8F3E34', // most severe
];
