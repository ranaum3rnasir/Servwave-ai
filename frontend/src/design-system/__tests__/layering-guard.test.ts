/* =============================================================================
   ServWave Design System - layering guard

   The rule this enforces: a semantic component's APPEARANCE is decided inside
   the component, never at the call site.

   This is a different question from the one tokens-guard asks. tokens-guard
   asks *which class* a site names (`bg-amber-50` is bad, `bg-warning-surface`
   is fine). This guard asks whether the call site names a colour AT ALL. A
   perfect token passed into `<Badge className="bg-warning-surface">` is still
   40 sources of truth across 40 call sites, and it is invisible to the token
   ratchet precisely because it is already tokenised.

   --- what counts as a violation -------------------------------------------
   An appearance class used as a DIRECT `className` attribute on a component
   exported from components/ui, components/data, components/layout or
   design-system.

   Two exclusions, both load-bearing:

   1. `className` on nested JSX passed THROUGH a prop is not a violation. In
        <Modal footer={<div className="bg-white" />}>
      the `bg-white` belongs to an ordinary div the call site authored; it is
      not a Modal appearance override. A scanner that walks the opening tag
      naively attributes it to Modal and reports 1015 violations where there
      are 453. Ask for a `>` at brace-depth 0, then re-scan the tag body for
      `className=` at brace-depth 0 only.

   2. Primitives composing other primitives are exempt. `Modal` passing
      classes to `DialogContent` IS the appearance decision being made in one
      place - that is the goal, not a breach of it. Only call sites outside
      the four shared directories are counted.

   --- hard vs soft ----------------------------------------------------------
   HARD (phase 3 drives to zero): background, text colour, border colour,
   radius, shadow, ring, fill/stroke.
   SOFT (allowed, tracked separately so the decision stays visible rather than
   buried): type size, weight, tracking, leading, structural border width.
   Folding soft into hard would grow phase 3 by 55% for the least
   meaning-carrying classes. Revisit once the hard ratchet reads zero.

   Appearance-carrying PROPS are counted too. A `tint="bg-success/10"` prop is
   the same violation wearing a different hat, and `KpiStrip.tsx` documented
   its own as an escape hatch rather than fixing it.
   ============================================================================= */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', '..');

// -----------------------------------------------------------------------------
// Ratchet baselines. LOWER THESE as phase 3 lands; never raise them.
// A raise means a call site took back an appearance decision - fix the code.
// -----------------------------------------------------------------------------
const MAX_APPEARANCE_CLASSNAME = 23;
// 155 -> 163, 2026-08-04 staff-avatar feature: TechnicianGridView.tsx, MemberWeekBoard.tsx,
// UnassignedBuckets.tsx and TodaySchedule.tsx each replaced a hand-rolled avatar <div>/<span>
// (invisible to this scanner - not a governed component) with the shared Avatar/AvatarFallback
// primitive, and the new AvatarUploadControl.tsx does the same. That is the fix these files
// needed (see the sibling no-stock-avatar-guard.test.ts), not a regression here: no call site
// took back a decision the primitive already owned, because none of these five sites routed
// through the primitive before. Their pre-existing per-site type-size and weight choices are
// simply visible to this guard for the first time now that they compose a real component.
const MAX_SOFT_CLASSNAME = 163;
const MAX_APPEARANCE_PROP = 0;

/** Props whose value IS an appearance decision handed to the component. */
const APPEARANCE_PROPS = ['tint', 'accent', 'color', 'bgClass', 'textClass', 'iconClass', 'colorClass'];

/** The four directories whose exports are the single source of appearance. */
const SHARED_DIRS = ['components/ui', 'components/data', 'components/layout', 'design-system'];

// Demo routes exist to display raw values; same exclusion tokens-guard uses.
const TREE_SKIP = [join('pages', 'prototype'), join('pages', 'design-system')];

// --- classification -----------------------------------------------------------

const PALETTE_FAMILIES =
  'gray|slate|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black';

/** Utilities that position or size a box. Never an appearance decision. */
const LAYOUT =
  /^(w-|min-w-|max-w-|h-|min-h-|max-h-|size-|m[trblxye]?-|-m[trblxy]?-|p[trblxy]?-|space-[xy]-|gap-|flex|grid|col-|row-|order-|basis-|grow|shrink|items-|justify-|self-|content-|place-|inline|block|hidden|visible|absolute|relative|fixed|sticky|static|top-|right-|bottom-|left-|inset-|z-|overflow-|whitespace-|break-|truncate|aspect-|columns-|float-|clear-|object-|cursor-|pointer-events-|select-|resize|transition|duration-|delay-|ease-|animate-|sr-only|list-|table-|origin-|scale-|rotate-|translate-|transform)/;

export type Severity = 'hard' | 'soft' | 'layout';

export function classify(cls: string): Severity {
  // Text alignment and wrapping are layout despite the `text-` prefix.
  if (/^text-(left|right|center|justify|start|end|wrap|nowrap|balance|pretty|clip|ellipsis)$/.test(cls)) {
    return 'layout';
  }
  if (LAYOUT.test(cls)) return 'layout';

  // HARD - the appearance decisions this phase moves into the primitive.
  if (/^(bg-|from-|via-|to-)/.test(cls)) return 'hard';
  if (/^(ring-|outline-)/.test(cls)) return 'hard';
  if (/^shadow/.test(cls)) return 'hard';
  if (/^rounded/.test(cls)) return 'hard';
  if (/^(fill-|stroke-|divide-|placeholder-|decoration-)/.test(cls)) return 'hard';
  // Structural border width/style is soft; a border COLOUR is hard.
  if (/^border(-[trblxy])?-(0|2|4|8)$/.test(cls) || /^border(-[trblxy])?$/.test(cls)) return 'soft';
  if (/^border-(solid|dashed|dotted|double|none|collapse|separate|spacing)/.test(cls)) return 'soft';
  if (/^border-\[/.test(cls)) return 'soft'; // arbitrary width, e.g. border-b-[3px]
  if (/^border(-[trblxy])?-\[/.test(cls)) return 'soft';
  if (/^border/.test(cls)) return 'hard';
  if (/^text-(xs|sm|base|lg|xl|\d?xl)$/.test(cls)) return 'soft';
  if (/^text-\[/.test(cls)) return 'soft'; // arbitrary size, e.g. text-[13px]
  if (/^text-/.test(cls)) return 'hard'; // every remaining text-* is a colour
  if (/^(opacity-|backdrop-|blur|mix-blend|bg-blend)/.test(cls)) return 'soft';

  // SOFT - typography.
  if (/^(font-|tracking-|leading-|uppercase|lowercase|capitalize|normal-case|italic|not-italic|underline|line-through|no-underline|antialiased|subpixel-antialiased|tabular-nums|slashed-zero|ordinal)/.test(cls)) {
    return 'soft';
  }

  return 'layout';
}

/** Strip one leading variant chain (`hover:`, `data-[x]:`, `sm:focus:`). */
function stripVariants(token: string): string {
  let depth = 0;
  let lastColon = -1;
  for (let i = 0; i < token.length; i++) {
    const c = token[i];
    if (c === '[') depth++;
    else if (c === ']') depth--;
    else if (c === ':' && depth === 0) lastColon = i;
  }
  return token.slice(lastColon + 1);
}

// --- JSX scanning -------------------------------------------------------------

/**
 * Body of a JSX opening tag: everything up to the first `>` that sits at
 * brace-depth 0. Bounded, so an unbalanced brace cannot swallow the file.
 */
export function tagBody(src: string, from: number): string {
  const cap = Math.min(src.length, from + 8000);
  let depth = 0;
  let i = from;
  for (; i < cap; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) break;
  }
  return src.slice(from, i);
}

/**
 * className values that are DIRECT attributes of this tag - brace-depth 0 only.
 *
 * Note the two `break`s on an unterminated literal. Without them an index that
 * fails to advance restarts the scan from 0 and pushes forever; that bug ate
 * 4 GB of heap before it was found.
 */
export function directClassNames(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '{') { depth++; continue; }
    if (c === '}') { depth--; continue; }
    if (depth !== 0) continue;
    if (!body.startsWith('className=', i)) continue;

    const j = i + 'className='.length;
    if (body[j] === '"') {
      const end = body.indexOf('"', j + 1);
      if (end < 0) break;
      out.push(body.slice(j + 1, end));
      i = end;
    } else if (body[j] === '{') {
      let d = 0;
      let k = j;
      let acc = '';
      for (; k < body.length; k++) {
        const ch = body[k];
        if (ch === '{') { d++; if (d === 1) continue; }
        else if (ch === '}') { d--; if (d === 0) break; }
        acc += ch;
      }
      if (k >= body.length) break;
      out.push(acc);
      i = k;
    }
  }
  return out;
}

/** Split a className expression into bare class tokens. */
export function classTokens(expr: string): string[] {
  return expr
    .split(/[\s'"`,()[\]{}?:+]+/)
    .filter((t) => /^[a-z-]/.test(t) && !t.includes('.'))
    .map(stripVariants)
    // A trailing `-` is the stub left by a template interpolation
    // (`text-${tone}`), not a class. Counting it double-counts the real class.
    .filter((t) => Boolean(t) && !t.endsWith('-'));
}

// --- file sets ----------------------------------------------------------------

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === '__tests__' || name === 'node_modules') return [];
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    if (/\.(test|spec)\.tsx?$/.test(p)) return [];
    return /\.tsx$/.test(p) ? [p] : [];
  });
}

// SHARED_DIRS are '/'-joined, but relative() yields '\' on Windows, so an
// unnormalised startsWith matched nothing there: the guard governed zero
// components, its ratchets passed vacuously, and only its own `governed.size >
// 50` sanity assertion failed. It was inert on every Windows dev run.
const isShared = (rel: string) =>
  SHARED_DIRS.some((d) => rel.split(sep).join('/').startsWith(d + '/'));

const allFiles = () =>
  walk(SRC).filter((f) => !TREE_SKIP.some((s) => relative(SRC, f).startsWith(s)));

/**
 * name -> the shared-directory file that exports it. `Calendar`, `Badge`,
 * `Sheet` and `Table` all collide with a same-named lucide-react icon; this
 * map is what lets scanFile tell the shared component apart from the icon.
 */
export function governedDefinitions(files: string[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const f of files) {
    const rel = relative(SRC, f);
    if (!isShared(rel)) continue;
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/export\s+(?:const|function)\s+([A-Z][A-Za-z0-9]*)/g)) {
      found.set(m[1]!, f);
    }
    for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
      for (const part of m[1]!.split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop()!.trim();
        if (/^[A-Z][A-Za-z0-9]*$/.test(name)) found.set(name, f);
      }
    }
  }
  return found;
}

/**
 * Every component exported from a shared directory that accepts a className.
 * Discovered, not listed: a new primitive is governed the day it lands.
 */
export function semanticComponents(files: string[]): Set<string> {
  const found = governedDefinitions(files);
  const governed = new Set<string>();
  for (const [name, file] of found) {
    if (/className/.test(readFileSync(file, 'utf8'))) governed.add(name);
  }
  return governed;
}

function stripExt(p: string): string {
  return p.replace(/\.(tsx|ts)$/, '');
}

function sameModule(a: string, b: string): boolean {
  const A = stripExt(a);
  const B = stripExt(b);
  return A === B || A === `${B}/index` || B === `${A}/index`;
}

/**
 * Local JSX identifier -> resolved absolute file it was imported from, or
 * `null` for a bare package specifier (`lucide-react`, `@radix-ui/...`) that
 * cannot be a local shared component. A name with no import statement found
 * at all is simply absent from the map - callers must treat "absent" as
 * "unverifiable" and keep counting, UNLESS localDeclarations shows the file
 * defines that name itself, in which case it is safe to exonerate (a name
 * cannot be both imported and locally declared in the same module).
 */
export function importSources(src: string, fromFile: string): Map<string, string | null> {
  const map = new Map<string, string | null>();
  const resolveSpec = (spec: string): string | null => {
    if (spec.startsWith('@/')) return resolve(SRC, spec.slice(2));
    if (spec.startsWith('.')) return resolve(dirname(fromFile), spec);
    return null;
  };
  const IMPORT_RE =
    /import\s+(?:type\s+)?(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s+['"]([^'"]+)['"]/g;
  for (const m of src.matchAll(IMPORT_RE)) {
    const [, defaultName, named, spec] = m;
    if (!defaultName && !named) continue;
    const target = resolveSpec(spec!);
    if (defaultName) map.set(defaultName, target);
    if (named) {
      for (const part of named.split(',')) {
        const bits = part.trim().split(/\s+as\s+/);
        const local = (bits[1] ?? bits[0])?.trim();
        if (local && /^[A-Z]/.test(local)) map.set(local, target);
      }
    }
  }
  return map;
}

/**
 * Names bound by a same-file `function NAME`, `const NAME` or `class NAME`
 * declaration - not an import. TypeScript forbids also importing an
 * identifier that is declared locally (duplicate-binding error), so when a
 * governed name has no import in this file but does have a local
 * declaration, JSX using that name resolves to the local declaration, never
 * the shared primitive. `FiltersPopover.tsx` is the motivating case: its own
 * unrelated `function Chip({ active, tint, onClick, children })` has no
 * import statement at all, so before this exclusion the scanner had no way
 * to tell it apart from the governed `components/ui/chip.tsx` primitive.
 */
export function localDeclarations(src: string): Set<string> {
  const found = new Set<string>();
  for (const m of src.matchAll(/\b(?:function|const|class)\s+([A-Z][A-Za-z0-9]*)\b/g)) {
    found.add(m[1]!);
  }
  return found;
}

/**
 * name -> value, for a local `const NAME = '...'` whose right-hand side is
 * ONLY string/template literals (optionally `+`-joined) - never a function
 * call. That narrowness is load-bearing: `const x = cva(...)` or
 * `const x = cn(...)` never matches, so a cva/cn *result* stored in a
 * variable is never mistaken for a plain string here. It doesn't need to be
 * - a `cn('a', 'b')` call already reads its literal arguments correctly
 * through the ordinary expression scan (parens are token delimiters);
 * this function exists only for the case that scan is blind to: a bare
 * identifier whose value is nothing but a string, e.g.
 * `const TAB_TRIGGER_CLASS = 'rounded-none ...'; <Tab className={TAB_TRIGGER_CLASS}>`.
 */
export function localStringConstants(src: string): Map<string, string> {
  const map = new Map<string, string>();
  const LITERAL = /'[^']*'|"[^"]*"|`[^`$]*`/;
  // Wrapped in its own (?:...) wherever interpolated below - the bare
  // alternation inside LITERAL.source would otherwise span the whole
  // enclosing pattern instead of just this one literal.
  const LIT = `(?:${LITERAL.source})`;
  const DECL_RE = new RegExp(
    `const\\s+([A-Za-z_$][\\w$]*)\\s*(?::[^=]+)?=\\s*(${LIT}(?:\\s*\\+\\s*${LIT})*)\\s*;`,
    'g'
  );
  for (const m of src.matchAll(DECL_RE)) {
    const name = m[1]!;
    const parts = m[2]!.match(new RegExp(LITERAL.source, 'g')) ?? [];
    map.set(name, parts.map((p) => p.slice(1, -1)).join(''));
  }
  return map;
}

export interface Violation {
  file: string;
  line: number;
  component: string;
  detail: string;
  severity: 'hard' | 'soft';
}

export function scanFile(
  rel: string,
  src: string,
  governed: Set<string>,
  governedFiles: Map<string, string> = new Map(),
  fromFile: string = resolve(SRC, rel)
): Violation[] {
  const out: Violation[] = [];
  const imports = importSources(src, fromFile);
  const localConsts = localStringConstants(src);
  const localNames = localDeclarations(src);
  const tagRe = /<([A-Z][A-Za-z0-9.]*)[\s/>]/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(src))) {
    const component = m[1]!.split('.')[0]!;
    if (!governed.has(component)) continue;

    // Import-aware exclusion: a governed name that also exists as a
    // same-named icon (`Calendar`, `Badge`, `Sheet`, `Table` all collide
    // with a lucide-react export) is only a real violation if this file's
    // import of it resolves to the shared component's own defining file.
    const definedIn = governedFiles.get(component);
    if (definedIn) {
      if (imports.has(component)) {
        const importedFrom = imports.get(component);
        if (importedFrom == null || !sameModule(importedFrom, definedIn)) continue;
      } else if (localNames.has(component)) {
        // No import for this name, but the file declares it itself
        // (function/const/class) - a local helper that happens to share the
        // governed name, not the shared primitive. See localDeclarations.
        continue;
      }
    }

    const body = tagBody(src, tagRe.lastIndex - 1);
    const line = src.slice(0, m.index).split('\n').length;

    for (const expr of directClassNames(body)) {
      const trimmed = expr.trim();
      const resolved = /^[A-Za-z_$][\w$]*$/.test(trimmed) && localConsts.has(trimmed)
        ? localConsts.get(trimmed)!
        : expr;
      for (const cls of classTokens(resolved)) {
        const severity = classify(cls);
        if (severity === 'layout') continue;
        out.push({ file: rel, line, component, detail: cls, severity });
      }
    }

    let depth = 0;
    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      if (c === '{') { depth++; continue; }
      if (c === '}') { depth--; continue; }
      if (depth !== 0) continue;
      for (const p of APPEARANCE_PROPS) {
        if (body.startsWith(p + '=', i) && !/[A-Za-z0-9]/.test(body[i - 1] ?? ' ')) {
          out.push({ file: rel, line, component, detail: `prop ${p}`, severity: 'hard' });
        }
      }
    }
  }
  return out;
}

function scanTree() {
  const files = allFiles();
  const governed = semanticComponents(files);
  const governedFiles = governedDefinitions(files);
  const className: Violation[] = [];
  const props: Violation[] = [];
  for (const f of files) {
    const rel = relative(SRC, f);
    if (isShared(rel)) continue; // primitives composing primitives are the goal
    for (const v of scanFile(rel, readFileSync(f, 'utf8'), governed, governedFiles, f)) {
      (v.detail.startsWith('prop ') ? props : className).push(v);
    }
  }
  return {
    governed,
    hard: className.filter((v) => v.severity === 'hard'),
    soft: className.filter((v) => v.severity === 'soft'),
    props,
  };
}

// --- the ratchets -------------------------------------------------------------

describe('layering guard (appearance belongs to the component, not the call site)', () => {
  const result = scanTree();

  it('governs a real, non-empty set of shared components', () => {
    expect(result.governed.size).toBeGreaterThan(50);
    for (const name of ['Button', 'Badge', 'Card', 'Modal', 'KpiTile', 'EmptyState']) {
      expect(result.governed.has(name)).toBe(true);
    }
  });

  it(`hard appearance classes at call sites stay at or below ${MAX_APPEARANCE_CLASSNAME}`, () => {
    const total = result.hard.length;
    if (total > MAX_APPEARANCE_CLASSNAME) {
      const worst = result.hard
        .slice(0, 20)
        .map((v) => `${v.file}:${v.line} <${v.component}> ${v.detail}`)
        .join('\n');
      throw new Error(`${total} hard violations (max ${MAX_APPEARANCE_CLASSNAME}). First 20:\n${worst}`);
    }
    expect(total).toBeLessThanOrEqual(MAX_APPEARANCE_CLASSNAME);
  });

  it(`soft appearance classes at call sites stay at or below ${MAX_SOFT_CLASSNAME}`, () => {
    expect(result.soft.length).toBeLessThanOrEqual(MAX_SOFT_CLASSNAME);
  });

  it(`appearance-carrying props stay at or below ${MAX_APPEARANCE_PROP}`, () => {
    const total = result.props.length;
    if (total > MAX_APPEARANCE_PROP) {
      const worst = result.props.map((v) => `${v.file}:${v.line} <${v.component}> ${v.detail}`).join('\n');
      throw new Error(`${total} appearance props (max ${MAX_APPEARANCE_PROP}):\n${worst}`);
    }
    expect(total).toBeLessThanOrEqual(MAX_APPEARANCE_PROP);
  });
});

// --- asserted examples (lock the detector itself) -----------------------------

describe('layering detector', () => {
  it('classifies colour, radius, shadow and ring as hard', () => {
    for (const c of ['bg-white', 'bg-amber-50', 'text-warning', 'text-red-700', 'border-border', 'rounded-lg', 'shadow-xl', 'ring-primary', 'fill-success']) {
      expect(classify(c)).toBe('hard');
    }
  });

  it('classifies type size, weight and structural border as soft', () => {
    for (const c of ['text-sm', 'text-[13px]', 'font-semibold', 'tracking-wide', 'leading-tight', 'border', 'border-t', 'border-b-[3px]', 'border-0']) {
      expect(classify(c)).toBe('soft');
    }
  });

  it('classifies box and position utilities as layout', () => {
    for (const c of ['w-full', 'h-7', 'mt-2', 'px-3', 'flex-1', 'col-span-2', 'gap-2', 'absolute', 'z-50', 'truncate', 'text-center', 'overflow-y-auto']) {
      expect(classify(c)).toBe('layout');
    }
  });

  it('sees through variant chains, including bracketed ones', () => {
    expect(classify(stripVariants('hover:bg-primary'))).toBe('hard');
    expect(classify(stripVariants('data-[state=active]:border-primary'))).toBe('hard');
    expect(classify(stripVariants('sm:focus:rounded-full'))).toBe('hard');
    expect(classify(stripVariants('md:w-1/2'))).toBe('layout');
  });

  it('reads a direct className but NOT one nested inside a prop value', () => {
    const body = tagBody('<Modal className="bg-white" footer={<div className="bg-amber-50" />}>x</Modal>', 6);
    expect(directClassNames(body)).toEqual(['bg-white']);
  });

  it('reads a cn() call and a template literal', () => {
    expect(directClassNames(' className={cn("bg-white", open && "shadow-xl")}')).toEqual([
      'cn("bg-white", open && "shadow-xl")',
    ]);
    expect(classTokens('cn("bg-white", open && "shadow-xl")')).toContain('shadow-xl');
  });

  it('terminates on an unterminated literal instead of looping forever', () => {
    expect(directClassNames(' className="bg-white')).toEqual([]);
    expect(directClassNames(' className={cn("x"')).toEqual([]);
  });

  it('bounds the tag body so an unbalanced brace cannot swallow the file', () => {
    expect(tagBody('<Card {{{' + 'x'.repeat(20000), 5).length).toBeLessThanOrEqual(8000);
  });

  it('flags an appearance prop and ignores an ordinary one', () => {
    const governed = new Set(['KpiTile']);
    const hits = scanFile('x.tsx', '<KpiTile tint="bg-success/10" label="Paid" />', governed);
    expect(hits.map((h) => h.detail)).toEqual(['prop tint']);
  });

  it('ignores components that are not exported from a shared directory', () => {
    expect(scanFile('x.tsx', '<LocalThing className="bg-white" />', new Set(['Button']))).toEqual([]);
  });

  it('does not mistake a same-named icon import for the shared component', () => {
    const governed = new Set(['Calendar']);
    const calendarFile = join(SRC, 'components', 'ui', 'calendar.tsx');
    const governedFiles = new Map([['Calendar', calendarFile]]);
    const fromFile = join(SRC, 'pages', 'Foo.tsx');

    const iconSrc = `import { Calendar } from 'lucide-react';\n<Calendar className="text-cyan-600" />`;
    expect(scanFile('pages/Foo.tsx', iconSrc, governed, governedFiles, fromFile)).toEqual([]);

    const realSrc = `import { Calendar } from '@/components/ui/calendar';\n<Calendar className="bg-white" />`;
    const hits = scanFile('pages/Foo.tsx', realSrc, governed, governedFiles, fromFile);
    expect(hits.map((h) => h.detail)).toEqual(['bg-white']);
  });

  it('keeps counting a governed name it cannot verify by import', () => {
    // No import statement for Card at all (e.g. re-exported through a
    // barrel) - unverifiable, so fail safe and keep it as a violation.
    const governed = new Set(['Card']);
    const cardFile = join(SRC, 'components', 'ui', 'card.tsx');
    const governedFiles = new Map([['Card', cardFile]]);
    const fromFile = join(SRC, 'pages', 'Foo.tsx');
    const hits = scanFile('pages/Foo.tsx', '<Card className="bg-white" />', governed, governedFiles, fromFile);
    expect(hits.map((h) => h.detail)).toEqual(['bg-white']);
  });

  it('exonerates a same-file local declaration that shadows a governed name', () => {
    // Mirrors FiltersPopover.tsx: its own local `function Chip(...)` has no
    // import statement at all, so it must not be mistaken for the shared
    // components/ui/chip.tsx primitive - neither its className nor its
    // appearance props (tint) should count.
    const governed = new Set(['Chip']);
    const chipFile = join(SRC, 'components', 'ui', 'chip.tsx');
    const governedFiles = new Map([['Chip', chipFile]]);
    const fromFile = join(SRC, 'components', 'inventory', 'FiltersPopover.tsx');
    const src = `
      <Chip active={active} tint="bg-success/10" onClick={toggle}>In stock</Chip>

      function Chip({ active, tint, onClick, children }) {
        return <button className={tint}>{children}</button>;
      }
    `;
    expect(scanFile('components/inventory/FiltersPopover.tsx', src, governed, governedFiles, fromFile)).toEqual([]);
  });

  it('still counts a same-named LOCAL const/class declaration the same way', () => {
    const governed = new Set(['Badge']);
    const badgeFile = join(SRC, 'components', 'ui', 'badge.tsx');
    const governedFiles = new Map([['Badge', badgeFile]]);
    const fromFile = join(SRC, 'pages', 'Foo.tsx');
    const src = `
      <Badge className="bg-white">x</Badge>
      const Badge = ({ children }) => <span>{children}</span>;
    `;
    expect(scanFile('pages/Foo.tsx', src, governed, governedFiles, fromFile)).toEqual([]);
  });

  it('resolves a bare identifier to the local string constant it names', () => {
    const src = `const TAB_TRIGGER_CLASS = 'rounded-none border-b-[3px] border-primary';\n<TabsTrigger className={TAB_TRIGGER_CLASS} />`;
    const hits = scanFile('pages/Foo.tsx', src, new Set(['TabsTrigger']));
    expect(hits.map((h) => h.detail)).toEqual(['rounded-none', 'border-primary']);
  });

  it('resolves a `+`-joined local string constant', () => {
    const src = `const CLS = 'text-danger ' + \`bg-danger/10\`;\n<Button className={CLS} />`;
    const hits = scanFile('pages/Foo.tsx', src, new Set(['Button']));
    expect(hits.map((h) => h.detail).sort()).toEqual(['bg-danger/10', 'text-danger']);
  });

  it('does not resolve a cva()/cn() result stored in a variable', () => {
    // Not a string literal RHS, so localStringConstants never matches it -
    // this stays exactly as unverifiable as it was before this feature,
    // never a new false positive.
    const src = `const cls = cva('bg-white');\n<Button className={cls} />`;
    expect(scanFile('pages/Foo.tsx', src, new Set(['Button']))).toEqual([]);
  });
});
