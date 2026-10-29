/* =============================================================================
   ServWave Design System - tokens guard

   Two mechanisms, deliberately different:

   1. ZERO-TOLERANCE on the canonical surface (design-system, components/charts,
      components/ui, and the migrated components/data files). These are clean and
      must stay clean.

   2. A RATCHET on the whole tree. The counts below record today's reality. They
      may only ever go DOWN. A ratchet is what makes the invariant survive the
      migration being interrupted: a fence added only at the end can certify the
      end state, but cannot stop the tree regressing while the work is in flight.

   --- why this file was rewritten ------------------------------------------
   The previous detector was a single regex anchored on `(?:^|[\s"'`])` with a
   variant segment of `(?:[a-z-]+:)*`. Neither can express a bracketed variant,
   so EVERY palette class behind one was invisible:

       data-[state=open]:bg-slate-100      dialog, sheet, dropdown-menu
       data-[placeholder]:text-slate-500   select
       data-[state=checked]:text-slate-50  checkbox
       group-[.destructive]:text-red-300   toast

   The guard reported green over all of them while claiming components/ui was at
   zero. It also required a numeric shade, so bare `bg-white` / `text-white` -
   1300+ sites, and the single biggest obstacle to retheming - were invisible too.

   Detection is now a bracket-aware tokeniser rather than one regex. The asserted
   examples at the bottom lock both the old blind spots and the multiline case
   (a match must never span a newline).
   ============================================================================= */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', '..');

// -----------------------------------------------------------------------------
// Ratchet baselines. LOWER THESE as migration lands; never raise them.
// A raise means the tree regressed - fix the code, not the number.
// -----------------------------------------------------------------------------
// Zero across the whole tree, not just the canonical surface. The `dark:`
// exemption still stands (dark mode is inert, those classes are dead code
// tracked separately), and the two demo routes are still skipped because they
// exist to display raw palette values.
const MAX_PALETTE_TREE = 0;
// Zero, and it stays zero. `bg-white` -> `bg-surface-light`, `text-white` ->
// `text-on-fill`, `bg-black/NN` -> `bg-scrim/NN`. The only whites left in the
// tree are `background: white !important` inside `@media print` CSS strings,
// which this detector never saw (it matches Tailwind utilities, not raw CSS)
// and which are correct: print white is paper, not a themed surface.
const MAX_WHITE_BLACK_TREE = 0;
const MAX_CSS_HEX = 0;
// 0. Phase 5b routed RangeSlider.css's `.dark .range-slider__track` through
// the new `--chrome-dark` token (was a literal `rgb(30 41 59)` matching
// Card's own `dark:border-slate-800`, which phase 5b also converted) -
// closing what used to be the one documented residual here.
const MAX_CSS_RGBA = 0;
// 66 is a floor, not a ceiling with slack: every remaining hex is an enumerated
// residual (per-record avatar identity, a user-facing swatch picker whose value
// persists to the database, third-party brand marks and fixtures, devtools
// console styling, and one `<input type="color">` DOM contract). Reasons are
// recorded per entry in the phase 4 section of
// md_files/specs/frontend/2026-07-26-ui-single-source-of-truth-goal.md.
const MAX_TS_HEX = 66;
const MAX_INLINE_APPEARANCE = 0;
const MAX_ARBITRARY_RGBA = 0;
// Zero. `3xl` is the one Tailwind default borderRadius key phase 5a left
// unregistered - see RADIUS_AT_RISK_KEYS above for why that makes it the
// canary for the hatch reopening.
const MAX_RADIUS_TREE = 0;

const PALETTE_FAMILIES =
  'gray|slate|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose';
const COLOR_PROPS =
  'bg|text|border|ring-offset|ring|from|to|via|fill|stroke|divide|outline|decoration|accent|caret|placeholder|shadow';

const PALETTE_UTIL = new RegExp(
  `^(?:${COLOR_PROPS})-(?:${PALETTE_FAMILIES})-(?:50|100|200|300|400|500|600|700|800|900|950)$`,
);
const WHITE_BLACK_UTIL = new RegExp(
  `^(?:${COLOR_PROPS})-(?:white|black)(?:\\/\\d{1,3}|\\/\\[[^\\]]*\\])?$`,
);
const HEX = /#[0-9a-fA-F]{6}\b/;

// Tailwind's default borderRadius scale is none|sm|DEFAULT|md|lg|xl|2xl|3xl|full.
// Phase 5a registered every one of those EXCEPT `3xl` as an explicit key in
// tailwind.config.js (md/lg/2xl point at project primitives; none/full are
// literal). `theme.extend.borderRadius` (closed in 5c) is what let an
// unregistered default key like `3xl` reach the tree at all - without it,
// Tailwind drops the class silently, with no build error. This ratchet is
// the forward guard: any USE of `3xl` means the hatch has effectively
// reopened and needs the same registration or an explicit token decision.
const RADIUS_AT_RISK_KEYS = '3xl';
// Hyphen folded into each corner alternative, rather than trailing the
// "rounded" stem with its own separate hyphen, so the source text never
// contains that word directly joined to a hyphen - the unresolved-class
// extractor (check-unresolved-classes.mjs) treats such a fragment as a
// candidate utility and reports it as dead.
const RADIUS_CORNERS = '(?:-t-|-r-|-b-|-l-|-tl-|-tr-|-br-|-bl-|-s-|-e-|-ss-|-se-|-ee-|-es-|-)';
const RADIUS_AT_RISK_UTIL = new RegExp(`^rounded${RADIUS_CORNERS}(?:${RADIUS_AT_RISK_KEYS})$`);

// --- detection ----------------------------------------------------------------

/** Split a class token into its variant chain and base utility, bracket-aware. */
export function splitToken(token: string): { variants: string; base: string } {
  let depth = 0;
  let lastColon = -1;
  for (let i = 0; i < token.length; i++) {
    const c = token[i];
    if (c === '[') depth++;
    else if (c === ']') depth--;
    else if (c === ':' && depth === 0) lastColon = i;
  }
  return { variants: token.slice(0, lastColon + 1), base: token.slice(lastColon + 1) };
}

/**
 * True when the variant chain contains a top-level `dark` segment.
 *
 * Order does not matter: `dark:focus:bg-x` and `focus:dark:bg-x` both compile to
 * a rule requiring a `.dark` ancestor. The old guard tolerated only a LEADING
 * `dark:`, which is not the real rule. A `dark` inside brackets
 * (`data-[theme=dark]:`) is NOT the dark variant and stays flagged.
 *
 * NOTE: dark mode is currently inert in this app - nothing ever applies `.dark`.
 * Phase 5b removed the palette/white-black exemption this used to gate (every
 * dark:*-slate-* site in the tree was converted to a real token; see
 * `scanSource` above). Only the radius detector still uses this - a raw
 * default radius key behind a `dark:` variant would compile into a rule that
 * never applies (dark mode is never on), so it stays exempt for a different
 * reason: it cannot regress anything visible, unlike a raw palette colour.
 */
export function isDarkOnly(variants: string): boolean {
  if (!variants) return false;
  const segments: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < variants.length; i++) {
    const c = variants[i];
    if (c === '[') depth++;
    else if (c === ']') depth--;
    else if (c === ':' && depth === 0) {
      segments.push(variants.slice(start, i));
      start = i + 1;
    }
  }
  return segments.includes('dark');
}

/** Tokenise on whitespace and quotes only; trim JS punctuation and `!`. */
function tokenize(code: string): string[] {
  return code
    .split(/[\s"'`]+/)
    .map((t) => t.replace(/^[!({[]+/, '').replace(/[,;)}\]]+$/, ''))
    .filter(Boolean);
}

export function scanSource(code: string): { palette: string[]; whiteBlack: string[]; radius: string[] } {
  const palette: string[] = [];
  const whiteBlack: string[] = [];
  const radius: string[] = [];
  for (const raw of tokenize(code)) {
    const { variants, base } = splitToken(raw);
    // Phase 5b: the `dark:` exemption on palette/white-black is GONE. It used
    // to tolerate ~71 dark:*-slate-* sites in components/ui on the theory
    // that dark mode is inert dead code - but those were exactly the classes
    // `theme.extend`'s stock palette kept alive, and closing the hatch (5c)
    // would have dropped them with no error. All were converted to real
    // tokens (tokens.css's dark-surface-chrome primitives); this scan
    // confirmed zero remain anywhere in the tree before the exemption was
    // removed, so removing it is a no-op today and a real fence going
    // forward. Radius has no comparable history and keeps its exemption.
    if (PALETTE_UTIL.test(base)) {
      palette.push(raw);
    } else if (WHITE_BLACK_UTIL.test(base)) {
      whiteBlack.push(raw);
    } else if (RADIUS_AT_RISK_UTIL.test(base)) {
      if (!isDarkOnly(variants)) radius.push(raw);
    }
  }
  return { palette, whiteBlack, radius };
}

// --- inline style detection ---------------------------------------------------
//
// Layer 1 is also bypassed by `style={{ ... }}`. Not every inline style is a
// bypass, though, and the split is the same one the layering rule already draws
// for className: GEOMETRY is legitimate (a `width` computed from a percentage
// or a virtualised row offset cannot be a token and never could be), APPEARANCE
// is not. So only the properties below are fenced.
//
// The fence deliberately counts LITERAL values only - a string, a template
// literal, or a bare number. An expression (`backgroundColor: agent.avatarColor`,
// `background: BUCKET_COLOR[b]`) is out of scope here, not because it is always
// legitimate but because its value lives somewhere else: either it resolves
// through the token layer, or it is a raw hex at its own definition site, which
// the TS hex ratchet below catches there. Splitting it that way is what keeps
// this detector free of the identifier-resolution blind spot that cost the
// layering guard a whole sub-phase (3g) to close.
const APPEARANCE_STYLE_PROPS = new Set([
  'color', 'backgroundColor', 'background', 'backgroundImage',
  'borderColor', 'borderTopColor', 'borderBottomColor', 'borderLeftColor',
  'borderRightColor', 'outlineColor', 'accentColor', 'caretColor',
  'border', 'borderTop', 'borderBottom', 'borderLeft', 'borderRight',
  'borderRadius', 'boxShadow', 'textShadow', 'fill', 'stroke',
  'fontSize', 'fontWeight', 'fontFamily', 'letterSpacing', 'lineHeight',
]);

/** Extract the balanced object body of every `style={{ ... }}` in a source. */
export function styleObjectBodies(src: string): string[] {
  const out: string[] = [];
  const RE = /style=\{\{/g;
  let m: RegExpExecArray | null;
  while ((m = RE.exec(src))) {
    let depth = 2;
    let i = m.index + m[0].length;
    const start = i;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      i++;
    }
    if (depth === 0) out.push(src.slice(start, i - 2));
  }
  return out;
}

/** Split an object body into its top-level `key: value` pairs. */
export function stylePairs(body: string): { key: string; value: string }[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let inTpl = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i] ?? '';
    if (c === '`') inTpl = !inTpl;
    if (inTpl) continue;
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const idx = s.indexOf(':');
      // A shorthand (`{ width }`) has no value; it is always an expression.
      if (idx === -1) return { key: s, value: '' };
      return { key: s.slice(0, idx).trim(), value: s.slice(idx + 1).trim() };
    });
}

/**
 * A CSS string that reaches the token layer and states no colour of its own.
 *
 * Some appearance properties have no Tailwind equivalent worth using - a
 * multi-stop gradient, a computed-alpha fill - so the honest spelling really is
 * an inline string. `background: 'linear-gradient(135deg, rgb(var(--amber-900)),
 * rgb(var(--warning-strong)))'` is a string literal, but it is not a bypass:
 * every value in it comes from tokens.css, and re-pointing those tokens
 * repaints it. Counting it would make the ratchet unable to reach its floor for
 * a reason that has nothing to do with the invariant.
 *
 * The exemption is narrow on purpose. It requires a `var(--...)` reference AND
 * the absence of any raw colour: a hex, or an `rgb(`/`rgba(` opening on a
 * DIGIT. `rgb(var(--x))` passes; `rgba(0,0,0,0.2)` and
 * `linear-gradient(#fff, var(--x))` are still offenders.
 */
function isTokenOnly(value: string): boolean {
  if (!value.includes('var(--')) return false;
  if (/#[0-9a-fA-F]{3,8}\b/.test(value)) return false;
  if (/\brgba?\(\s*[\d.]/.test(value)) return false;
  return true;
}

/** Appearance style props written as a raw literal - the fenced set. */
export function scanInlineStyles(src: string): string[] {
  const offenders: string[] = [];
  for (const body of styleObjectBodies(src)) {
    for (const { key, value } of stylePairs(body)) {
      const k = key.replace(/^['"]|['"]$/g, '');
      if (!APPEARANCE_STYLE_PROPS.has(k)) continue;
      if (isTokenOnly(value)) continue;
      if (/^['"`]/.test(value) || /^-?[\d.]+$/.test(value)) offenders.push(`${k}: ${value}`);
    }
  }
  return offenders;
}

/**
 * Raw 6-digit hex in a `.ts`/`.tsx` source. Exported so the ratchet below and any
 * migration reporting share ONE implementation - a second, hand-rolled grep is
 * how the counts in the spec came to be wrong repeatedly.
 */
export function scanTsHex(src: string): string[] {
  return stripComments(src).match(/#[0-9a-fA-F]{6}\b/g) ?? [];
}

/**
 * A raw `rgb()`/`rgba()` colour hiding inside an ARBITRARY Tailwind value, e.g.
 * `shadow-[0_8px_30px_rgba(91,109,255,0.18)]`.
 *
 * Found while auditing phase 4: this is a third laundering route that every
 * existing fence missed. It is not a hex, so the hex ratchet skips it; it is not
 * a `style={{}}`, so the inline fence skips it; it is not `bg-slate-500`, so the
 * palette detector skips it. And `rgba(91,109,255,...)` IS `--ai-600` - the same
 * value the token layer already owns, restated where nothing could see it.
 *
 * Only a channel opening on a DIGIT counts. `rgb(var(--ai-600) / 0.18)` is the
 * correct spelling and must keep passing.
 */
const ARBITRARY_RGBA =
  /(?:bg|text|border|ring|fill|stroke|shadow|from|to|via|accent|outline|divide|decoration|caret)-\[[^\]]*rgba?\(\s*[\d.]/g;

export function scanArbitraryRgba(src: string): string[] {
  return stripComments(src).match(ARBITRARY_RGBA) ?? [];
}

/** Strip block + line comments so documentation examples don't false-fail. */
export function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1'); // keep the `:` of `http://`-style strings
}

/**
 * The token DEFINITION files, where a literal colour is the whole point.
 *
 * Anchored to exact paths under design-system/, not matched by basename: a
 * basename test would hand the exemption to any file anywhere in the tree that
 * happened to be called tokens.css, which is a guard one careless `cp` away
 * from silence.
 */
const TOKEN_SOURCES = [
  join('design-system', 'tokens.ts'),
  join('design-system', 'tokens.css'),
  // The CRM UI kit's palette for the v2 presentation layer - same kind of file
  // as tokens.css, so the same exemption. No ratchet floor moves for it.
  join('design-system', 'tokens-v2.css'),
];

function isTokenSource(file: string): boolean {
  const rel = relative(SRC, file);
  return TOKEN_SOURCES.includes(rel);
}

// --- file sets ----------------------------------------------------------------

function walk(dir: string, exts: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === '__tests__') return [];
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p, exts);
    if (/\.(test|spec)\.(ts|tsx)$/.test(p)) return [];
    return exts.test(p) ? [p] : [];
  });
}

const CODE = /\.(ts|tsx)$/;
const CSS = /\.css$/;

// Zero-tolerance surface.
const SCANNED_DIRS = [
  join(SRC, 'design-system'),
  join(SRC, 'components', 'charts'),
  join(SRC, 'components', 'ui'),
];
const MIGRATED_DATA = [
  'table',
  'status-badge',
  'KpiStrip',
  'TrendDelta',
  'data-table',
  'ResizableTable',
].map((n) => join(SRC, 'components', 'data', `${n}.tsx`));

const scopedFiles = () => [...SCANNED_DIRS.flatMap((d) => walk(d, CODE)), ...MIGRATED_DATA];

// Whole-tree ratchet surface. Demo/kitchen-sink routes are excluded: they exist
// to display raw palette values.
const TREE_SKIP = [join('pages', 'prototype'), join('pages', 'design-system')];
const treeFiles = () =>
  walk(SRC, CODE).filter((f) => !TREE_SKIP.some((s) => relative(SRC, f).startsWith(s)));

// --- zero-tolerance guard -----------------------------------------------------

describe('design-system token guard (canonical surface, zero tolerance)', () => {
  const files = scopedFiles();

  it('scans a non-empty, expected set of canonical files', () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.endsWith('button.tsx'))).toBe(true);
    expect(files.some((f) => f.endsWith('TrendDelta.tsx'))).toBe(true);
    expect(files.some((f) => f.endsWith('chartTheme.ts'))).toBe(true);
  });

  it('every allowlisted path exists (catches moves out of data/)', () => {
    expect(MIGRATED_DATA.filter((f) => !existsSync(f))).toEqual([]);
  });

  it('contains NO raw 6-digit hex colors (outside tokens.ts/.css and comments)', () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (isTokenSource(file)) continue;
      const m = stripComments(readFileSync(file, 'utf8')).match(HEX);
      if (m) offenders.push(`${relative(SRC, file)}: ${m[0]}`);
    }
    expect(offenders).toEqual([]);
  });

  it('contains NO raw Tailwind palette classes, including behind bracketed variants', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const { palette } = scanSource(stripComments(readFileSync(file, 'utf8')));
      if (palette.length) offenders.push(`${relative(SRC, file)}: ${[...new Set(palette)].join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });
});

// --- whole-tree ratchet -------------------------------------------------------

describe('token ratchet (whole tree, may only decrease)', () => {
  const files = treeFiles();

  // A ratchet that only asserts `<=` hides its own slack: it reads green at 852
  // against a ceiling of 897 and never says so. Printing the real count on every
  // run makes the guard the measurement too, so no migration ever has to reach
  // for an ad hoc grep - the one habit that put wrong numbers in the spec.
  const report = (label: string, total: number, ceiling: number) => {
    const slack = ceiling - total;
    // process.stdout, not console: vitest's console interception swallows these
    // under the jsdom environment, and a report nobody sees is not a report.
    process.stdout.write(
      `  ratchet  ${label.padEnd(24)} ${String(total).padStart(5)} / ${String(ceiling).padEnd(5)}` +
        (slack > 0 ? ` (${slack} slack - lower the ceiling)` : ' (at floor)') +
        '\n',
    );
    return total;
  };

  it('scans the whole component + page tree', () => {
    expect(files.length).toBeGreaterThan(400);
  });

  it(`raw palette classes stay at or below ${MAX_PALETTE_TREE}`, () => {
    let total = 0;
    for (const file of files) total += scanSource(stripComments(readFileSync(file, 'utf8'))).palette.length;
    expect(report('palette classes', total, MAX_PALETTE_TREE)).toBeLessThanOrEqual(MAX_PALETTE_TREE);
  });

  it(`bare white/black classes stay at or below ${MAX_WHITE_BLACK_TREE}`, () => {
    let total = 0;
    for (const file of files) total += scanSource(stripComments(readFileSync(file, 'utf8'))).whiteBlack.length;
    expect(report('bare white/black', total, MAX_WHITE_BLACK_TREE)).toBeLessThanOrEqual(
      MAX_WHITE_BLACK_TREE,
    );
  });

  // .css files were never walked before, which is how pages/schedule-dark.css
  // kept 46 hardcoded hexes - including verbatim copies of --ocean-800/900 and
  // one colour tokens.css records as superseded.
  it(`raw hex in .css stays at or below ${MAX_CSS_HEX}`, () => {
    let total = 0;
    for (const file of walk(SRC, CSS)) {
      if (isTokenSource(file)) continue;
      total += (readFileSync(file, 'utf8').match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).length;
    }
    expect(report('raw hex .css', total, MAX_CSS_HEX)).toBeLessThanOrEqual(MAX_CSS_HEX);
  });

  // Hex is not the only way to write a colour in CSS. schedule-dark.css carried
  // eleven `rgba(...)` literals AFTER its hexes were converted - six of them
  // `rgba(12, 45, 58, x)`, a verbatim copy of --primary. Fencing hex alone would
  // have read green over all of them.
  it(`raw rgb()/rgba() in .css stays at or below ${MAX_CSS_RGBA}`, () => {
    let total = 0;
    for (const file of walk(SRC, CSS)) {
      if (isTokenSource(file)) continue;
      total += (readFileSync(file, 'utf8').match(/\brgba?\(\s*[\d.]/g) ?? []).length;
    }
    expect(report('raw rgba() .css', total, MAX_CSS_RGBA)).toBeLessThanOrEqual(MAX_CSS_RGBA);
  });

  // The hex ratchet above walks .css ONLY, and the zero-tolerance hex check
  // above covers just the canonical surface - so a raw hex in any page or
  // feature .ts/.tsx was fenced by nothing at all. That is where the laundering
  // lives: `BAND_HEX = { good: '#10B981' }` reaches a `style={{ color: ... }}`
  // and a chart `fill=` as an innocent-looking identifier.
  it(`raw hex in .ts/.tsx stays at or below ${MAX_TS_HEX}`, () => {
    let total = 0;
    for (const file of files) {
      if (isTokenSource(file)) continue;
      total += scanTsHex(readFileSync(file, 'utf8')).length;
    }
    expect(report('raw hex .ts/.tsx', total, MAX_TS_HEX)).toBeLessThanOrEqual(MAX_TS_HEX);
  });

  it(`literal appearance values in style={{}} stay at or below ${MAX_INLINE_APPEARANCE}`, () => {
    let total = 0;
    for (const file of files) total += scanInlineStyles(stripComments(readFileSync(file, 'utf8'))).length;
    expect(report('inline appearance', total, MAX_INLINE_APPEARANCE)).toBeLessThanOrEqual(
      MAX_INLINE_APPEARANCE,
    );
  });

  it(`raw rgb()/rgba() in arbitrary Tailwind values stays at or below ${MAX_ARBITRARY_RGBA}`, () => {
    let total = 0;
    for (const file of files) total += scanArbitraryRgba(readFileSync(file, 'utf8')).length;
    expect(report('arbitrary rgba()', total, MAX_ARBITRARY_RGBA)).toBeLessThanOrEqual(
      MAX_ARBITRARY_RGBA,
    );
  });

  it(`unregistered default radius classes stay at or below ${MAX_RADIUS_TREE}`, () => {
    let total = 0;
    for (const file of files) total += scanSource(stripComments(readFileSync(file, 'utf8'))).radius.length;
    expect(report('unregistered radius', total, MAX_RADIUS_TREE)).toBeLessThanOrEqual(MAX_RADIUS_TREE);
  });
});

// --- asserted examples (lock the detector itself) -----------------------------

describe('token-guard detector (asserted examples)', () => {
  const pal = (s: string) => scanSource(s).palette;
  const wb = (s: string) => scanSource(s).whiteBlack;

  it('flags plain and ordinary-variant palette classes', () => {
    expect(pal('bg-emerald-500')).toHaveLength(1);
    expect(pal('hover:bg-slate-100')).toHaveLength(1);
    expect(pal('focus-visible:ring-slate-950')).toHaveLength(1);
  });

  it('flags palette classes behind BRACKETED variants (the old blind spot)', () => {
    expect(pal('data-[state=open]:bg-slate-100')).toHaveLength(1);
    expect(pal('group-[.destructive]:text-red-300')).toHaveLength(1);
    expect(pal('data-[placeholder]:text-slate-500')).toHaveLength(1);
  });

  it('flags a dark variant like any other - the exemption was removed in phase 5b', () => {
    expect(pal('dark:bg-slate-950')).toHaveLength(1);
    expect(pal('dark:focus-visible:ring-slate-300')).toHaveLength(1);
    expect(pal('data-[state=on]:dark:bg-slate-800')).toHaveLength(1);
    // `dark` here is an attribute VALUE, not the variant - always flagged
    expect(pal('data-[theme=dark]:bg-slate-800')).toHaveLength(1);
  });

  it('never matches token utilities', () => {
    expect(pal('bg-primary text-success border-border')).toEqual([]);
    expect(pal('bg-success/10 text-danger rounded-card')).toEqual([]);
    expect(pal('bg-background-light text-text-soft')).toEqual([]);
    expect(pal('!bg-danger')).toEqual([]);
    expect(pal('bg-slate-1000')).toEqual([]); // not a real shade
    expect(pal('from-member')).toEqual([]); // prose that looks like a utility
  });

  it('counts bare white/black separately from the palette', () => {
    expect(wb('bg-white')).toHaveLength(1);
    expect(wb('text-white/70')).toHaveLength(1);
    expect(wb('bg-black/40')).toHaveLength(1);
    expect(wb('dark:bg-white')).toHaveLength(1); // dark: exemption removed, phase 5b
    expect(pal('bg-white')).toEqual([]); // not double-counted
  });

  it('never lets a match span a newline', () => {
    const multiline =
      '"flex items-center rounded-sm px-2 py-1.5\n' +
      '  outline-none focus:bg-background-light data-[state=open]:bg-slate-100\n' +
      '  [&_svg]:pointer-events-none dark:focus:bg-slate-800",';
    expect(pal(multiline)).toEqual(['data-[state=open]:bg-slate-100', 'dark:focus:bg-slate-800']);
  });

  it('inline styles: geometry is legitimate, appearance literals are not', () => {
    const s = (x: string) => scanInlineStyles(x);
    // Geometry - computed at runtime, never expressible as a token.
    expect(s('<div style={{ width: `${pct}%` }} />')).toEqual([]);
    expect(s('<div style={{ top: i * ROW_H, height: ROW_H }} />')).toEqual([]);
    expect(s('<div style={{ tableLayout: "fixed" }} />')).toEqual([]);
    // Appearance literals - the bypass.
    expect(s(`<div style={{ boxShadow: '0 25px 50px -12px rgba(0,0,0,0.2)' }} />`)).toHaveLength(1);
    expect(s(`<div style={{ background: 'linear-gradient(135deg, #78350f, #d97706)' }} />`)).toHaveLength(1);
    expect(s('<text style={{ fontSize: 11 }} />')).toHaveLength(1);
  });

  it('inline styles: an expression is left to the hex ratchet, not double-counted', () => {
    const s = (x: string) => scanInlineStyles(x);
    // Per-record data. Legitimate: the record owns its colour.
    expect(s('<div style={{ backgroundColor: agent.avatarColor }} />')).toEqual([]);
    // Laundered through a constant. NOT counted here - counted at the constant's
    // own definition site by the TS hex ratchet, so it is caught exactly once.
    expect(s('<div style={{ background: BUCKET_COLOR[b] }} />')).toEqual([]);
    // Routed through the token layer. Legitimate.
    expect(s(`<text style={{ fill: token('--text-secondary') }} />`)).toEqual([]);
    // Shorthand property - always an expression.
    expect(s('<div style={{ width }} />')).toEqual([]);
  });

  it('inline styles: a token-only CSS string is not a bypass, a mixed one is', () => {
    const s = (x: string) => scanInlineStyles(x);
    // Every value comes from tokens.css - re-pointing the token repaints it.
    expect(s(`<div style={{ background: 'linear-gradient(135deg, rgb(var(--amber-900)), rgb(var(--warning-strong)))' }} />`)).toEqual([]);
    expect(s(`<div style={{ borderBottom: '2px solid rgb(var(--warning-strong))' }} />`)).toEqual([]);
    // Computed alpha over a token colour - the alpha is geometry, the colour is a token.
    expect(s('<div style={{ backgroundColor: `rgb(var(--success-strong) / ${a})` }} />')).toEqual([]);
    // A var reference does NOT launder a raw value sitting next to it.
    expect(s(`<div style={{ background: 'linear-gradient(#fff, rgb(var(--x)))' }} />`)).toHaveLength(1);
    expect(s(`<div style={{ boxShadow: '0 0 4px rgba(0,0,0,0.2), 0 0 2px rgb(var(--x))' }} />`)).toHaveLength(1);
    // No token reference at all - still an offender.
    expect(s(`<div style={{ color: 'rebeccapurple' }} />`)).toHaveLength(1);
  });

  it('inline styles: parses multiple objects and nested braces without drift', () => {
    const src =
      '<div style={{ width: w }}>' +
      `<span style={{ color: '#fff', width: 4 }} />` +
      '<b style={{ transform: `translate(${x}px)`, boxShadow: `0 0 ${r}px red` }} />';
    // color literal + boxShadow template literal; width/transform are geometry.
    expect(scanInlineStyles(src)).toHaveLength(2);
  });

  it('arbitrary values: a raw rgba channel is flagged, a token reference is not', () => {
    const a = (s: string) => scanArbitraryRgba(s);
    expect(a('shadow-[0_8px_30px_rgba(91,109,255,0.18)]')).toHaveLength(1);
    expect(a('bg-[linear-gradient(rgb(15,23,42),transparent)]')).toHaveLength(1);
    // The correct spelling - must keep passing.
    expect(a('shadow-[0_0_6px_rgb(var(--ai-600)/0.9)]')).toEqual([]);
    expect(a('bg-[radial-gradient(rgb(var(--ai-300)/0.9),transparent)]')).toEqual([]);
    // Not a colour utility at all.
    expect(a('w-[calc(100%-2rem)] text-[11px]')).toEqual([]);
  });

  it('radius: flags the one unregistered default key, tolerates every registered one', () => {
    const r = (s: string) => scanSource(s).radius;
    expect(r('rounded-3xl')).toHaveLength(1);
    expect(r('rounded-tl-3xl last:rounded-br-3xl')).toHaveLength(2);
    // Registered in tailwind.config.js phase 5a - not at risk, must not flag.
    expect(r('rounded-md rounded-lg rounded-2xl rounded-none rounded-full')).toEqual([]);
    expect(r('rounded rounded-sm rounded-xl rounded-card rounded-control rounded-bubble rounded-pill')).toEqual([]);
    expect(r('dark:rounded-3xl')).toEqual([]); // dark-only, exempt like the other detectors
  });

  it('HEX flags raw hex, ignores token vars and rgb()', () => {
    expect(HEX.test('color: #0C2D3A')).toBe(true);
    expect(HEX.test('className="bg-[#bf5a4c]"')).toBe(true);
    expect(HEX.test('rgb(var(--primary) / 0.1)')).toBe(false);
    expect(HEX.test('token("--success")')).toBe(false);
  });
});
