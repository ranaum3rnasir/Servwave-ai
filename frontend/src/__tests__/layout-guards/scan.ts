/* =============================================================================
   Source scanner shared by the app-wide layout guards (mobile slice 12).

   - findBareFrTracks: grid column tracks whose minimum is the content's own
     width (a bare `1fr`, or `minmax(auto|min-content|max-content, Nfr)`). VP-08.
   - findWideFixedWidths: widths / min-widths above 320 px that apply at every
     screen size (no `sm:`/`md:`/... gate and no viewport-bound max-width cap).
     VP-09.

   Each finder returns one Offence per hit, keyed by a TOKEN (the class or
   declaration as written, without its variant prefix) rather than a line
   number, so the allow-lists survive unrelated edits to the same file.

   Lines that are comments (`//`, `/*`, ` * `, `{/*`) are skipped: this repo has a
   history of guards reddening on their own explanatory prose, and a comment
   that names the old shape is not the shape.
   ============================================================================= */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Offence {
  token: string;
  line: number;
}
export type Finder = (src: string, file: string) => Offence[];
/** file (relative to frontend/src, posix separators) -> token -> count */
export type Tally = Record<string, Record<string, number>>;

/** frontend/src */
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKIP_DIRS = new Set(['__tests__', '__mocks__', '__snapshots__', 'node_modules']);
/** Width at or below this fits the smallest supported phone. */
const PHONE_PX = 320;

// ---------------------------------------------------------------------------
// Files

export function sourceFiles(dir: string = SRC): Array<readonly [string, string]> {
  const out: Array<readonly [string, string]> = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) out.push(...sourceFiles(full));
    } else if (/\.(tsx?|css)$/.test(entry) && !/\.(test|stories)\.tsx?$|\.d\.ts$/.test(entry)) {
      out.push([relative(SRC, full).split(sep).join('/'), readFileSync(full, 'utf8')] as const);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shared helpers

function lineOf(src: string, index: number): number {
  return src.slice(0, index).split('\n').length;
}

function isCommentLine(src: string, index: number): boolean {
  const start = src.lastIndexOf('\n', index - 1) + 1;
  const head = src.slice(start, index).trimStart();
  return /^(\/\/|\/\*|\*|\{\s*\/\*)/.test(head);
}

/** Split on `sep` only at paren depth 0. */
function splitTopLevel(value: string, sepChar: RegExp): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of value) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (depth === 0 && sepChar.test(ch)) {
      if (current.trim()) parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

// ---------------------------------------------------------------------------
// VP-08: bare fr tracks

const FR = /^\d*\.?\d+fr$/;
const CONTENT_MINIMUM = new Set(['auto', 'min-content', 'max-content']);

function innerOf(track: string, fn: string): string | null {
  if (!track.startsWith(`${fn}(`) || !track.endsWith(')')) return null;
  return track.slice(fn.length + 1, -1);
}

/** True when a grid-template-columns value has a track whose minimum is its content. */
export function hasBareFrTrack(value: string): boolean {
  const withoutLineNames = value.replace(/\[[^\]]*\]/g, ' ');
  return splitTopLevel(withoutLineNames, /\s/).some((track) => {
    if (FR.test(track)) return true;
    const repeated = innerOf(track, 'repeat');
    if (repeated !== null) {
      const [, ...rest] = splitTopLevel(repeated, /,/);
      return hasBareFrTrack(rest.join(' '));
    }
    const minmax = innerOf(track, 'minmax');
    if (minmax !== null) {
      const [min = '', max = ''] = splitTopLevel(minmax, /,/);
      return CONTENT_MINIMUM.has(min) && FR.test(max);
    }
    return false;
  });
}

export const findBareFrTracks: Finder = (src, file) => {
  const out: Offence[] = [];
  const push = (index: number, token: string) => {
    if (!isCommentLine(src, index)) out.push({ token, line: lineOf(src, index) });
  };

  // CSS declarations, in .css files and in CSS-in-TS strings. The `[` lookbehind
  // leaves the Tailwind arbitrary-property form to its own pattern below.
  for (const m of src.matchAll(/(?<![\w[-])grid-template-columns\s*:\s*([^;}'"`\n]+)/g)) {
    const value = (m[1] ?? "").trim().replace(/\s+/g, ' ');
    if (hasBareFrTrack(value)) push(m.index, `grid-template-columns: ${value}`);
  }
  if (file.endsWith('.css')) return out;

  // Tailwind arbitrary value: grid-cols-[1fr_320px] (underscores are spaces).
  for (const m of src.matchAll(/(?<![\w-])grid-cols-\[([^\]\s'"`]+)\]/g)) {
    if (hasBareFrTrack((m[1] ?? '').replace(/_/g, ' '))) push(m.index, m[0]);
  }
  // Tailwind arbitrary property: [grid-template-columns:1fr_200px].
  for (const m of src.matchAll(/\[grid-template-columns:([^\]\s'"`]+)\]/g)) {
    if (hasBareFrTrack((m[1] ?? '').replace(/_/g, ' '))) push(m.index, m[0]);
  }
  // Inline style: gridTemplateColumns: '1fr 240px' or a template literal.
  for (const m of src.matchAll(/\bgridTemplateColumns\s*:\s*(['"`])((?:(?!\1)[^\n])*)\1/g)) {
    const written = (m[2] ?? '').replace(/\$\{[^}]*\}/g, '${}');
    if (hasBareFrTrack(written.replace(/\$\{\}/g, '1'))) push(m.index, `gridTemplateColumns: ${written}`);
  }
  return out;
};

// ---------------------------------------------------------------------------
// VP-09: fixed widths above 320 px

/** A min-width breakpoint or container size: the width does not apply on a phone. */
function isGated(variants: string): boolean {
  return variants
    .split(':')
    .filter(Boolean)
    .some((v) => /^(sm|md|lg|xl|2xl)$/.test(v) || v.startsWith('min-[') || v.startsWith('@'));
}

/** px for `440px` / `24rem` / `24em`; null for anything fluid (%, vw, calc, var...). */
function fixedPx(value: string): number | null {
  const m = /^(\d+(?:\.\d+)?)(px|rem|em)?$/.exec(value);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === 'rem' || m[2] === 'em' ? n * 16 : n;
}

/** The quoted string (class list) that contains `index`. */
function enclosingString(src: string, index: number): string {
  let start = index;
  while (start > 0 && !`'"\`\n`.includes(src[start - 1] ?? '')) start--;
  let end = index;
  while (end < src.length && !`'"\`\n`.includes(src[end] ?? '')) end++;
  return src.slice(start, end);
}

/** An unprefixed max-width that is bound to the container or viewport. max-width beats width. */
const VIEWPORT_CAP =
  /(?<![^\s])max-w-(?:full|screen|\[[^\]\s]*(?:vw|%|available-width)[^\]\s]*\])(?![\w-])/;

/** `hidden ... lg:flex`: not displayed below a min-width breakpoint, so its width never meets a phone. */
function hiddenOnPhones(classes: string): boolean {
  return (
    /(?<![^\s])hidden(?![\w-])/.test(classes) &&
    /(?<![^\s])(?:sm|md|lg|xl|2xl):(?:flex|block|grid|inline-flex|inline-block|inline|table|contents)(?![\w-])/.test(classes)
  );
}

export const findWideFixedWidths: Finder = (src, file) => {
  const out: Offence[] = [];
  const push = (index: number, token: string) => {
    if (!isCommentLine(src, index)) out.push({ token, line: lineOf(src, index) });
  };

  if (file.endsWith('.css')) {
    for (const m of src.matchAll(/(?<![\w(-])(min-width|width)\s*:\s*(\d+(?:\.\d+)?)(px|rem|em)(?![\w%])/g)) {
      const [, prop = '', n = '', unit = ''] = m;
      const px = fixedPx(n + unit);
      if (px !== null && px > PHONE_PX && !insideMinWidthMedia(src, m.index)) {
        push(m.index, `${prop}: ${n}${unit}`);
      }
    }
    return out;
  }

  // Tailwind w-/min-w- with an arbitrary length or a spacing-scale step.
  const CLASS = /(?<=^|[\s'"`{(,])((?:[^\s'"`:]+:)*)(min-w|w)-(\[[^\]\s'"`]+\]|\d+(?:\.\d+)?)(?![\w\-[\]./%])/g;
  for (const m of src.matchAll(CLASS)) {
    const [, variants = '', prop = '', raw = ''] = m;
    if (isGated(variants)) continue;
    const px = raw.startsWith('[') ? fixedPx(raw.slice(1, -1)) : Number(raw) * 4;
    if (px === null || px <= PHONE_PX) continue;
    const index = m.index + variants.length;
    const classes = enclosingString(src, index);
    if (hiddenOnPhones(classes)) continue;
    if (prop === 'w' && VIEWPORT_CAP.test(classes)) continue;
    push(index, `${prop}-${raw}`);
  }

  // Tailwind arbitrary property: [min-width:500px].
  const PROPERTY = /(?<=^|[\s'"`{(,])((?:[^\s'"`:[]+:)*)\[(min-width|width):([^\]\s'"`]+)\]/g;
  for (const m of src.matchAll(PROPERTY)) {
    const [, variants = '', prop = '', raw = ''] = m;
    const px = fixedPx(raw);
    if (isGated(variants) || px === null || px <= PHONE_PX) continue;
    push(m.index + variants.length, `[${prop}:${raw}]`);
  }

  // Inline style object keys: width: 440 / minWidth: '680px'. A JSX attribute
  // (width={600}) is an intrinsic svg/canvas size and does not match `:`.
  const STYLE = /(?<![\w$.-])(width|minWidth)\s*:\s*(?:(\d+(?:\.\d+)?)(?![\w.%])|(['"`])(\d+(?:\.\d+)?(?:px|rem|em)?)\3)/g;
  for (const m of src.matchAll(STYLE)) {
    const written = m[2] ?? m[4] ?? '';
    const px = fixedPx(written);
    if (px !== null && px > PHONE_PX) push(m.index, `${m[1]}: ${written}`);
  }
  return out;
};

/** True when `index` sits inside an `@media (... min-width ...)` block of a CSS file. */
function insideMinWidthMedia(css: string, index: number): boolean {
  const headers: string[] = [];
  let segmentStart = 0;
  for (let i = 0; i < index; i++) {
    const ch = css[i];
    if (ch === '{') {
      headers.push(css.slice(segmentStart, i).trim());
      segmentStart = i + 1;
    } else if (ch === '}') {
      headers.pop();
      segmentStart = i + 1;
    } else if (ch === ';') {
      segmentStart = i + 1;
    }
  }
  return headers.some((h) => h.startsWith('@media') && /min-width/.test(h));
}

// ---------------------------------------------------------------------------
// CMP-18: unprefixed multi-column form grids (mobile slice 20)

/**
 * A file that renders a text entry or choice control: where a multi-column grid is a FORM grid.
 * `<Select\b` does not match `<SelectTrigger` or `<SelectItem` (no word boundary inside a name).
 */
const FORM_CONTROL =
  /<(?:Input|input|PhoneInput|Textarea|textarea|AutoGrowTextarea|SelectField|Select|select|DateField|TimeField|AddressAutocomplete)\b/;

export function rendersFormControls(src: string): boolean {
  return FORM_CONTROL.test(src);
}

/**
 * `grid-cols-2` ... `grid-cols-12` that applies at every screen size (no `sm:`/`md:`/... gate) in
 * a .tsx file that renders form controls. Below `sm` such a row splits a phone's width between
 * two to six fields (a 37 px State box, a 49 px price), so form grids are `grid-cols-1
 * sm:grid-cols-N`. Arbitrary `grid-cols-[...]` tracks are left to the bare-fr guard: they are
 * mostly label/value pairs and line-item rows, not field grids.
 */
export const findUnprefixedFormGrids: Finder = (src, file) => {
  if (!file.endsWith('.tsx') || !rendersFormControls(src)) return [];
  const out: Offence[] = [];
  const CLASS = /(?<=^|[\s'"`{(,])((?:[^\s'"`:]+:)*)grid-cols-(\d+)(?![\w\-[\]./%])/g;
  for (const m of src.matchAll(CLASS)) {
    const [, variants = '', cols = ''] = m;
    const n = Number(cols);
    if (n < 2 || isGated(variants)) continue;
    const index = m.index + variants.length;
    if (!isCommentLine(src, index)) out.push({ token: `grid-cols-${cols}`, line: lineOf(src, index) });
  }
  return out;
};

// ---------------------------------------------------------------------------
// Tally and ratchet

export function tallyFiles(files: ReadonlyArray<readonly [string, string]>, finder: Finder): Tally {
  const tally: Tally = {};
  for (const [file, src] of files) {
    for (const { token } of finder(src, file)) {
      tally[file] ??= {};
      tally[file][token] = (tally[file][token] ?? 0) + 1;
    }
  }
  return tally;
}

/** `grown`: more hits than the list allows. `stale`: the list allows more than remain. */
export function diffAgainstAllowList(actual: Tally, allowed: Tally): { grown: string[]; stale: string[] } {
  const grown: string[] = [];
  const stale: string[] = [];
  const files = [...new Set([...Object.keys(actual), ...Object.keys(allowed)])].sort();
  for (const file of files) {
    const a = actual[file] ?? {};
    const l = allowed[file] ?? {};
    for (const token of [...new Set([...Object.keys(a), ...Object.keys(l)])].sort()) {
      const found = a[token] ?? 0;
      const listed = l[token] ?? 0;
      if (found > listed) grown.push(`${file}: ${token} x${found} (allowed ${listed})`);
      if (found < listed) stale.push(`${file}: ${token} x${listed} listed, ${found} found`);
    }
  }
  return { grown, stale };
}

export function allowListSize(allowed: Tally): number {
  return Object.values(allowed).reduce(
    (sum, tokens) => sum + Object.values(tokens).reduce((s, n) => s + n, 0),
    0,
  );
}
