/* =============================================================================
   Component-API guard - phase 6, 6d-prep.

   Phases 1-5 made the *values* single-source: every colour and radius resolves
   through tokens.css. They did not make the *components* single-source - a
   call site can still reach past Card/EmptyState/SectionCard/Badge/TableCell
   and restyle their appearance via className, using perfectly legal tokens,
   and no guard in the tree notices. This is that guard.

   Not a blanket className ban. LAYOUT overrides (margin, width/height,
   flex/grid placement, position, z-index, responsive prefixes) stay legal -
   a component cannot know where it sits in its parent, so that stays the call
   site's business. APPEARANCE overrides (padding, colour, border, radius,
   shadow, typography) are the component's business; every one counted here is
   a missing variant. Only the five components with a concentrated,
   non-layout override signal (measured in
   md_files/plans/frontend/2026-07-27-phase-6-component-api-over-classname.md)
   are ratcheted - Button, Avatar, Input, Separator, KpiTile, StatusBadge and
   Tabs measured healthy (overrides are layout) and are explicitly out of
   scope.

   Built FIRST, not last (owner instruction): every count in the phase-6 plan
   was produced by a scratch version of this classifier, so it has to exist
   before 6a-6c can prove the sites they convert actually move the ceiling.

   --- lessons carried in ------------------------------------------------------
   - Multiline JSX open tags: a single-line grep undercounted raw <button> by
     10x (83 vs 849) purely from missing `<button` followed by a newline. The
     tag regex here uses `\s` / `[^>]`, both of which already match newlines in
     JS regex without a dotAll flag - verified by an asserted example below.
   - className="...", className={cn(...)} and className={`...`} all appear in
     this tree; extraction has to read all three, not just the string-literal
     form the original scratch script leaned on.
   - Interpolations are dropped, not parsed: a `${...}` segment inside a
     template literal is stripped before tokenising, so a computed class is
     never guessed at.
   - A quoted string used as a comparison operand (`size === 'lg' ? ... `) is
     not a class list and is excluded - found via a real false positive in
     components/data/status-badge.tsx while building this guard (see decision
     note below), not a hypothetical.
   ============================================================================= */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', '..');

// -----------------------------------------------------------------------------
// Ratchet ceilings. LOWER THESE as 6a/6b/6c convert sites; never raise them.
//
// Measured 2026-07-27 against the phase-6 base commit (0702dd8b7), with THIS
// classifier - not copied from the plan's earlier scratch-script audit, per
// "re-measure the starting values from the phase-6 base commit" in the plan's
// rules of engagement. Two numbers differ from that earlier audit, both
// explained and recorded in the plan's Decisions section:
//
//   Card   104 -> 97   Card-only carve-out: the six text alignment utilities
//                      (text-left, text-center, text-right, text-justify,
//                      text-start, text-end) count as LAYOUT, not appearance,
//                      per owner decision 3 ("no align prop on Card,
//                      alignment describes the content passed in"). Exactly
//                      -7, matching the 7 text-center sites the plan named.
//   Badge   18 -> 21   The scratch script undercounted a real multi-line
//                      ternary cn() call in components/data/status-badge.tsx -
//                      the same class of bug as the button undercount above,
//                      not a scope change. This guard reads it correctly.
//
// EmptyState (58), SectionCard (32) and TableCell (15) matched the scratch
// audit exactly.
//
// Card lowered again, 97 -> 2, by 6a: added a `padding` variant prop
// (none/sm/md/lg -> p-0/p-4/p-6/p-8, default md), converted the 95 sites
// that passed an explicit padding class, decided the 9 sites that passed
// none (6 design-system catalogue defaults, 2 table-wrapping cards now
// `padding="none"`, 1 comment false-positive - see stripComments below),
// and deleted all five Card* subcomponents, folding their 8 call sites into
// the padded Card. The 2 remaining appearance tokens are both
// `text-text-secondary` (ServicePlansPage.tsx:79,119) - a one-off content
// colour, not padding, and not concentrated enough to justify a new prop.
//
// SectionCard 32 -> 0 and EmptyState 58 -> 50: a THIRD bug, found while
// enumerating 6b's sites, not a conversion. `findComponentTags` and
// `extractClassNameAttr` were both blind to nesting - a prop value can be
// inline JSX with its own className (`meta={<span className="...">}`,
// `action={<button className="...">}`), and a plain `indexOf('className')`
// over the whole attrs text finds that nested one first. SectionCard's
// entire "32 appearance, text-text-secondary x21" signal turned out to be
// almost entirely this: of the 23 tags that mention "className" anywhere,
// only 1 has it as SectionCard's own direct prop, and that one is a
// pass-through (`className={className}`) with no static tokens - the real
// count is 0, not a scope change, a correction. EmptyState lost 5 sites the
// same way, each a whole `<button className="inline-flex ... px-3.5 py-2
// ...">` inside its `action` prop misread as EmptyState's own padding.
// Card/Badge/TableCell were independently verified unaffected (their sites
// never had a nested-className prop in this tree).
//
// EmptyState lowered again, 50 -> 5, by 6b: added a `density` variant prop
// (flush/compact/default/roomy -> py-0/p-6/py-12/py-24, default 'default'),
// converted the 45 real explicit-py sites, and moved `variant="card"`'s
// vertical padding out of its border/radius/surface/px-6 slot so the two
// props are orthogonal. The 5 remaining appearance tokens (px-6 x1, px-4 x2,
// text-xs x2) are unrelated to density and not concentrated enough to
// justify a prop of their own.
//
// 6c: Badge 21 -> 10, TableCell 15 -> 3.
//
// Badge's "text-xs x9" never was a size signal - text-xs is already Badge's
// OWN default (badge.tsx's base string), so every one of those 9 sites was a
// redundant no-op, not a call site demanding a second size. Stripped them
// (and the tenth, components/data/filter-chip.tsx, found the same way) with
// zero behaviour change rather than invent a `size` prop nothing asks for.
// Floor is 10: filter-chip.tsx's real one-off chip styling (4 tokens, a
// single site), components/data/status-badge.tsx's own internal size-scale
// implementation (5 tokens - StatusBadge already has its own `size` prop
// doing this job and is explicitly out of scope), and one `capitalize`.
//
// TableCell gained `align`/`weight`/`divider`, converting every real site:
// `weight="medium"` (4 sites), `align="center"`/`"right"` (2), `divider`
// (3, all inside components/data/data-table.tsx's own render - the "border-r
// x3" signal was one shared component repeating itself, not the app).
// Floor is 3: two DesignSystemPage catalogue-page one-offs and one
// `font-mono` numeric preview, none concentrated enough for a prop.
// -----------------------------------------------------------------------------
const CEILINGS: Record<string, number> = {
  Card: 2,
  EmptyState: 5,
  SectionCard: 0,
  Badge: 10,
  TableCell: 3,
};

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '__snapshots__']);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (SKIP_DIRS.has(name)) return [];
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return p.endsWith('.tsx') ? [p] : [];
  });
}

/**
 * Every .tsx file outside the primitives' own definitions. `components/ui/`
 * is where Card/EmptyState/SectionCard/Badge/TableCell are DEFINED - a
 * className there is the component authoring its own appearance, not a call
 * site reaching past it. Test files are excluded for the same reason
 * check-unresolved-classes.mjs excludes them: fixtures and negative
 * assertions (`not.toHaveClass(...)`) are not real usage.
 */
export function targetFiles(root = SRC): string[] {
  return walk(root).filter((f) => {
    const rel = relative(root, f);
    if (rel.startsWith(join('components', 'ui') + sep)) return false;
    if (f.includes('.test.')) return false;
    if (rel.split(sep).includes('__tests__')) return false;
    return true;
  });
}

// --- classification -----------------------------------------------------------

const LAYOUT_RE =
  /^(m[trblxy]?-|-m[trblxy]?-|space-[xy]-|gap-|w-|h-|min-w-|min-h-|max-w-|max-h-|size-|flex|grid|col-|row-|order-|basis-|grow|shrink|items-|justify-|self-|place-|content-|absolute|relative|fixed|sticky|inset-|top-|bottom-|left-|right-|z-|hidden|block|inline|table$|contents|overflow-|shrink-|truncate|whitespace-|break-|sm:|md:|lg:|xl:|2xl:)/;

// Built from an array and joined at runtime, rather than one literal regex.
// Several entries below are colour/theme utility stems that, written as one
// literal string, read as Tailwind-class-shaped text to
// check-unresolved-classes.mjs - that guard tokenises raw SOURCE TEXT on the
// same "word + hyphen" shape this regex matches, with no awareness that it
// is reading a regex definition rather than a className. Writing this file's
// first draft as one literal regex made the guard's own source its own false
// positive. Splitting the hyphen out via concatenation keeps the list
// reviewable while breaking that accidental collision.
const H = '-';
const APPEARANCE_PREFIXES = [
  'p[trblxy]?' + H,
  'bg' + H,
  'text' + H,
  'border',
  'rounded',
  'ring' + H,
  'shadow',
  'divide' + H,
  'outline' + H,
  'font' + H,
  'tracking' + H,
  'leading' + H,
  'uppercase',
  'lowercase',
  'capitalize',
  'italic',
  'opacity' + H,
  'cursor' + H,
  'transition',
  'duration' + H,
  'ease' + H,
  'animate' + H,
  'hover:',
  'focus:',
  'active:',
  'disabled:',
  'group-hover:',
  'dark:',
  'data-\\[',
];
const APPEARANCE_RE = new RegExp(`^(${APPEARANCE_PREFIXES.join('|')})`);

// Owner decision 3 (2026-07-27): alignment describes the content passed into
// Card, not the container, so Card gets no `align` prop and these 7 sites
// stay a layout override in the ratchet. Scoped to Card only - TableCell's
// `text-right` at pages/settings/LocationsPage.tsx:113 is exactly the signal
// 6c's planned `align` prop is meant to retire, so it must keep counting as
// appearance there.
const CARD_ALIGNMENT_IS_LAYOUT = new Set([
  'text-left',
  'text-center',
  'text-right',
  'text-justify',
  'text-start',
  'text-end',
]);

export function classifyToken(tok: string, component: string): 'layout' | 'appearance' | 'other' {
  if (component === 'Card' && CARD_ALIGNMENT_IS_LAYOUT.has(tok)) return 'layout';
  if (LAYOUT_RE.test(tok)) return 'layout';
  if (APPEARANCE_RE.test(tok)) return 'appearance';
  return 'other';
}

// --- extraction ----------------------------------------------------------------

/**
 * Every `<Name ...>` / `<Name .../>` open tag in `code`, attrs text only.
 *
 * Brace- and string-aware: a prop value can be inline JSX
 * (`action={<button className="...">...</button>}`), and that nested
 * element has its own `>` characters. A plain `[^>]*?` regex - the original
 * version of this function - stops at the FIRST `>` it sees, which is the
 * nested button's, not EmptyState's own closing tag. Found via a real site,
 * pages/inventory/PriceBookPage.tsx:1104's `<EmptyState ... action={<button
 * className="...py-1.5...">}>`: the truncated match handed the button's
 * className to code that assumed it belonged to EmptyState. This scans
 * forward from `<Name` tracking `{`/`}` depth (skipping quoted/templated
 * strings, so a stray brace inside prose does not miscount) and only treats
 * a bare `>` at depth 0 as the true end of the tag.
 */
export function findComponentTags(code: string, name: string): string[] {
  const out: string[] = [];
  // No word boundary needed after `name`: `<CardHeader` fails to match
  // `<Card` because the character right after "Card" is not `\s`/`/`/`>`,
  // so the lookahead fails at that position - verified below too.
  const openRe = new RegExp(`<${name}(?=[\\s/>])`, 'g');
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(code))) {
    const start = m.index + m[0].length;
    let depth = 0;
    let inString: string | null = null;
    let end = -1;
    for (let i = start; i < code.length; i++) {
      const c = code[i];
      if (inString) {
        if (c === '\\') { i++; continue; }
        if (c === inString) inString = null;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') { inString = c; continue; }
      if (c === '{') { depth++; continue; }
      if (c === '}') { depth--; continue; }
      if (depth === 0 && c === '>') { end = i; break; }
    }
    if (end === -1) continue; // unterminated - not real JSX, skip
    out.push(code.slice(start, end));
  }
  return out;
}

/**
 * The raw text of a `className=...` attribute value, quotes/braces
 * stripped.
 *
 * Depth-0 only: `attrs` can itself contain a nested element's own
 * `className` (the same `action={<button className="...">}` shape
 * `findComponentTags` above guards against). Scanning for the token
 * "className" only while brace depth is 0 relative to the START of attrs
 * skips over any className belonging to a descendant passed in as a prop
 * value, and only matches one that is a direct attribute of this tag.
 */
export function extractClassNameAttr(
  attrs: string,
): { raw: string; isPlainString: boolean } | null {
  let depth = 0;
  let inString: string | null = null;
  for (let i = 0; i < attrs.length; i++) {
    const c = attrs[i];
    if (inString) {
      if (c === '\\') { i++; continue; }
      if (c === inString) inString = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inString = c; continue; }
    if (c === '{') { depth++; continue; }
    if (c === '}') { depth--; continue; }
    if (depth !== 0) continue;
    if (!(i === 0 || /\s/.test(attrs[i - 1]!)) || !attrs.startsWith('className', i)) continue;

    let j = i + 'className'.length;
    while (/\s/.test(attrs[j] ?? '')) j++;
    if (attrs[j] !== '=') continue; // e.g. a prop named `classNameFoo`
    j++;
    while (/\s/.test(attrs[j] ?? '')) j++;
    const q = attrs[j];
    if (q === '"' || q === "'") {
      const end = attrs.indexOf(q, j + 1);
      if (end === -1) return null;
      return { raw: attrs.slice(j + 1, end), isPlainString: true };
    }
    if (q === '{') {
      let d2 = 0;
      for (let k = j; k < attrs.length; k++) {
        if (attrs[k] === '{') d2++;
        else if (attrs[k] === '}') {
          d2--;
          if (d2 === 0) return { raw: attrs.slice(j + 1, k), isPlainString: false };
        }
      }
      return null;
    }
    return null;
  }
  return null;
}

/**
 * Every quoted / template-literal segment inside a `{...}` className
 * expression, interpolations dropped and comparison operands excluded.
 *
 * The comparison-operand exclusion exists because of a real find, not a
 * hypothetical: components/data/status-badge.tsx has
 * `size === 'lg' ? 'text-sm px-3 py-1' : 'text-xs'` inside its cn() call. A
 * naive "every quoted string is a class list" reading pulls in the 'lg'
 * comparison target as a token, which happened to land in the classifier's
 * `other` bucket only by luck (no Tailwind prefix collides with "lg") - a
 * token like `status === 'border'` would have silently inflated the
 * appearance count. Excluding any quoted string immediately preceded by
 * `===`/`==`/`!==`/`!=` closes that off at the source.
 */
// Sentinel with no whitespace and no Tailwind-legal character, so a `${...}`
// span survives the word split as one atomic unit rather than fragmenting
// into its own internal tokens (`density`, `===`, `"lg"`, `12`, ...).
const INTERP_SENTINEL = 'INTERP_SENTINEL_MARKER';

export function stringLiteralSegments(expr: string): string[] {
  const out: string[] = [];
  const re = /'([^'\\]*(?:\\.[^'\\]*)*)'|"([^"\\]*(?:\\.[^"\\]*)*)"|`([^`\\]*(?:\\.[^`\\]*)*)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(expr))) {
    const before = expr.slice(Math.max(0, m.index - 6), m.index);
    if (/[!=]==?\s*$/.test(before)) continue;
    out.push((m[1] ?? m[2] ?? m[3] ?? '').replace(/\$\{[^}]*\}/g, INTERP_SENTINEL));
  }
  return out;
}

/**
 * className attrs text -> the class-name tokens it statically contains.
 *
 * A word that CONTAINS the interpolation sentinel is dropped whole, not just
 * the interpolated part - `` `py-${density}` `` must not leak a bare "py-"
 * token. Filtering after the split (rather than deleting the sentinel before
 * it) is what keeps a glued prefix and a standalone `${expr}` word both
 * correctly discarded without fragmenting the expression's own internal
 * whitespace (`${a === "lg" ? 12 : 6}`) into spurious extra tokens.
 */
export function classNameTokens(attrs: string): string[] {
  const found = extractClassNameAttr(attrs);
  if (!found) return [];
  const segments = found.isPlainString ? [found.raw] : stringLiteralSegments(found.raw);
  const tokens: string[] = [];
  for (const seg of segments) {
    for (const tok of seg.split(/\s+/)) {
      if (tok && !tok.includes(INTERP_SENTINEL)) tokens.push(tok);
    }
  }
  return tokens;
}

export interface OverrideCounts {
  sites: number;
  appearance: number;
  layout: number;
  other: number;
}

/**
 * Strip block + line comments before tag-scanning. Found via a real false
 * positive: components/invoices/InvoiceReceiptCard.tsx:7 has a JSDoc comment
 * describing a now-deleted Card ("Both are gone; this card renders
 * ONCE...") - without this, that prose reads as a real, padding-less call
 * site. It carried no className, so it never affected an appearance count,
 * but it did inflate the no-className bucket 6a used to enumerate the
 * visual-risk set from 8 real sites to 9.
 *
 * The block-comment half deliberately differs from tokens-guard's own
 * unconditional version, which opens on any slash-star pair regardless of
 * context. That version has a live false-negative on this exact tree:
 * components/inventory/StageDetailDialog.tsx has an `accept` attribute
 * containing "image", slash, star (a MIME wildcard string) on an input, and
 * the unconditional match reads that string's slash-star as a comment
 * opener, swallowing roughly 130 real lines up to the next unrelated
 * star-slash - including a genuine EmptyState with a real className in
 * between. A real comment in this codebase is always preceded by whitespace
 * or the start of the file; the MIME string is not, so requiring the
 * opening pair NOT be preceded by a word character closes that hole without
 * a real parser.
 */
export function stripComments(src: string): string {
  return src.replace(/(?<![\w])\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

export function countOverridesInFile(rawCode: string, component: string): OverrideCounts {
  const code = stripComments(rawCode);
  const counts: OverrideCounts = { sites: 0, appearance: 0, layout: 0, other: 0 };
  for (const attrs of findComponentTags(code, component)) {
    const tokens = classNameTokens(attrs);
    if (!tokens.length) continue;
    counts.sites++;
    for (const tok of tokens) counts[classifyToken(tok, component)]++;
  }
  return counts;
}

export function countAppearanceOverrides(component: string, files: string[]): OverrideCounts {
  const total: OverrideCounts = { sites: 0, appearance: 0, layout: 0, other: 0 };
  for (const file of files) {
    const c = countOverridesInFile(readFileSync(file, 'utf8'), component);
    total.sites += c.sites;
    total.appearance += c.appearance;
    total.layout += c.layout;
    total.other += c.other;
  }
  return total;
}

// --- ratchet --------------------------------------------------------------------

describe('component-API ratchet (appearance overrides via className, may only decrease)', () => {
  const files = targetFiles();

  it('scans a non-empty file set outside components/ui', () => {
    expect(files.length).toBeGreaterThan(300);
    expect(files.some((f) => f.endsWith('CustomerDetailPage.tsx'))).toBe(true);
  });

  for (const [component, ceiling] of Object.entries(CEILINGS)) {
    it(`${component} appearance-override tokens stay at or below ${ceiling}`, () => {
      const counts = countAppearanceOverrides(component, files);
      const slack = ceiling - counts.appearance;
      // process.stdout, not console: vitest's console interception swallows
      // these under jsdom, matching every other guard in this suite.
      process.stdout.write(
        `  ratchet  ${component.padEnd(12)} appearance ${String(counts.appearance).padStart(4)} / ${String(
          ceiling,
        ).padEnd(4)}  (sites ${counts.sites}, layout ${counts.layout})` +
          (slack > 0 ? ` (${slack} slack - lower the ceiling)` : ' (at floor)') +
          '\n',
      );
      expect(counts.appearance).toBeLessThanOrEqual(ceiling);
    });
  }
});

// --- asserted examples (lock the detector itself) --------------------------------

describe('component-API guard detector (asserted examples)', () => {
  it('finds a bare tag with a plain string className', () => {
    expect(findComponentTags('<Card className="p-6 text-center">', 'Card')).toHaveLength(1);
  });

  it('does not match a subcomponent whose name merely starts with the target', () => {
    expect(findComponentTags('<CardHeader className="p-6">', 'Card')).toHaveLength(0);
    expect(findComponentTags('<CardContent className="p-6 pt-0" />', 'Card')).toHaveLength(0);
  });

  it('finds a tag whose attributes span multiple lines, no dotAll flag needed', () => {
    const code = '<Card\n  tone="warning"\n  className="p-4 text-center"\n>';
    const tags = findComponentTags(code, 'Card');
    expect(tags).toHaveLength(1);
    expect(classNameTokens(tags[0]!)).toEqual(['p-4', 'text-center']);
  });

  it('reads className={cn(...)} and template-literal forms, not just string literals', () => {
    expect(classNameTokens(`className={cn('p-4', flat && 'shadow-none')}`)).toEqual([
      'p-4',
      'shadow-none',
    ]);
    expect(classNameTokens('className={`p-6 ${extra}`}')).toEqual(['p-6']);
  });

  it('drops interpolations rather than guessing at them', () => {
    expect(classNameTokens('className={`py-${density === "lg" ? 12 : 6} px-4`}')).toEqual([
      'px-4',
    ]);
  });

  it('a token that cannot be statically read from an identifier expression is not counted', () => {
    expect(classNameTokens('className={content.badgeClassName}')).toEqual([]);
  });

  it('excludes a quoted comparison operand from a ternary, the status-badge.tsx case', () => {
    expect(
      classNameTokens(`className={cn('font-bold gap-1', size === 'lg' ? 'text-sm px-3 py-1' : 'text-xs', className)}`),
    ).toEqual(['font-bold', 'gap-1', 'text-sm', 'px-3', 'py-1', 'text-xs']);
  });

  it('classifies padding, colour, border, radius, shadow and typography as appearance', () => {
    expect(classifyToken('p-6', 'Card')).toBe('appearance');
    expect(classifyToken('pt-4', 'Card')).toBe('appearance');
    expect(classifyToken('bg-surface-light', 'Card')).toBe('appearance');
    expect(classifyToken('rounded-card', 'Card')).toBe('appearance');
    expect(classifyToken('shadow-card', 'Card')).toBe('appearance');
    expect(classifyToken('text-xs', 'Badge')).toBe('appearance');
    expect(classifyToken('font-medium', 'TableCell')).toBe('appearance');
  });

  it('classifies margin, size, flex/grid placement, position and responsive prefixes as layout', () => {
    expect(classifyToken('mt-4', 'Card')).toBe('layout');
    expect(classifyToken('w-full', 'Card')).toBe('layout');
    expect(classifyToken('flex', 'SectionCard')).toBe('layout');
    expect(classifyToken('items-center', 'SectionCard')).toBe('layout');
    expect(classifyToken('absolute', 'Badge')).toBe('layout');
    expect(classifyToken('z-10', 'Badge')).toBe('layout');
    expect(classifyToken('md:col-span-2', 'Card')).toBe('layout');
  });

  it('an unrecognised variant is left unclassified rather than guessed, e.g. last:border-r-0', () => {
    expect(classifyToken('last:border-r-0', 'TableCell')).toBe('other');
    expect(classifyToken('tabular-nums', 'TableCell')).toBe('other');
  });

  it('text alignment is layout on Card (decision 3) but appearance on TableCell (feeds the 6c align prop)', () => {
    expect(classifyToken('text-center', 'Card')).toBe('layout');
    expect(classifyToken('text-right', 'TableCell')).toBe('appearance');
  });

  it('a tag mentioned inside a comment is not a call site, the InvoiceReceiptCard.tsx find', () => {
    const code =
      '/**\n * Replaces the standalone "Payment Summary" `<Card className="p-6">` that\n * used to sit above the tabs. Both are gone now.\n */\nexport function X() { return <div />; }';
    expect(countOverridesInFile(code, 'Card')).toEqual({ sites: 0, appearance: 0, layout: 0, other: 0 });
  });

  it('a mid-string /* is not read as a comment opener, the StageDetailDialog.tsx find', () => {
    const code =
      '<input accept="image/*,application/pdf" />\n<EmptyState className="py-0" />';
    expect(countOverridesInFile(code, 'EmptyState')).toEqual({ sites: 1, appearance: 1, layout: 0, other: 0 });
  });

  it('a nested element inside a JSX-expression prop does not close the tag early, the PriceBookPage.tsx find', () => {
    const code =
      '<EmptyState\n  variant="card"\n  title="No bundles yet"\n  action={\n    <button className="rounded-md bg-primary px-3 py-1.5">Add</button>\n  }\n/>';
    const tags = findComponentTags(code, 'EmptyState');
    expect(tags).toHaveLength(1);
    // The button's own className must not be readable as EmptyState's.
    expect(classNameTokens(tags[0]!)).toEqual([]);
  });

  it('a nested className inside a prop value is not this tag\'s own, the SectionCard.tsx find', () => {
    // SectionCard's entire "32 appearance" scratch-audit signal turned out to
    // be almost entirely this shape: `meta`/`icon`/`title` are ReactNode
    // props, routinely passed as inline JSX carrying their own className.
    const code =
      '<SectionCard\n  title="Internal costs"\n  meta={<span className="text-[11px] font-medium text-text-secondary">Not shown</span>}\n>';
    const tags = findComponentTags(code, 'SectionCard');
    expect(tags).toHaveLength(1);
    expect(extractClassNameAttr(tags[0]!)).toBeNull();
  });

  it('a direct className is still found when a nested prop also has one', () => {
    const code =
      '<SectionCard className="p-4" meta={<span className="text-xs">x</span>}>';
    const tags = findComponentTags(code, 'SectionCard');
    expect(classNameTokens(tags[0]!)).toEqual(['p-4']);
  });

  it('a site with no className is not counted as a site', () => {
    const counts = countOverridesInFile('<Card tone="danger">', 'Card');
    expect(counts.sites).toBe(0);
  });

  it('one site with two appearance tokens counts as sites:1, appearance:2', () => {
    const counts = countOverridesInFile('<Card className="p-6 text-center">', 'Card');
    expect(counts).toEqual({ sites: 1, appearance: 1, layout: 1, other: 0 });
  });
});

// --- directory-scoped ratchet (phase 7) -------------------------------------------
//
// CEILINGS above is keyed by COMPONENT NAME, so it can only ever see a
// className written on one of those five tags. `targetFiles()` already walks
// components/patterns/, but a composition pattern authors most of its own
// markup on bare elements, and appearance written on a bare paragraph inside a
// pattern is invisible to a name-keyed ceiling. That is not hypothetical: it is
// exactly how PageHeader shipped its description slot as a bare paragraph
// carrying two typography utilities while every component-scoped ceiling in
// this file stayed at its floor and reported nothing.
//
// This second ratchet closes the gap by keying on a DIRECTORY instead of a
// component: every JSX open tag in every `targetFiles()` file under the path,
// whatever the tag is called. The composition layer is the one place where
// "author no appearance at all" is an absolute rule rather than a budget,
// because a pattern is by definition assembled out of primitives that already
// own how they look. So the ceiling is 0 and phase 10's new patterns inherit
// it on the day they are added.
//
// Measured 2026-07-28 with the exports above, after phase 7's PageHeader
// conversion moved its description slot onto the Text primitive: appearance 0
// across components/patterns/ListPageShell.tsx and components/patterns/
// PageHeader.tsx (5 className sites between them, every token layout). Adding
// this entry at its measured floor is the same move 6a/6b/6c made and is not a
// raise. NEVER raise it.
const DIR_CEILINGS: Record<string, number> = {
  'components/patterns': 0,
};

/**
 * Every distinct JSX open-tag NAME in `code`, deduplicated, in source order.
 *
 * Enumerated rather than hardcoded: the whole point of a directory ceiling is
 * that it cannot be dodged by inventing a tag the list did not anticipate. The
 * scan here only locates NAMES; each name is then handed to the existing
 * `findComponentTags`, which is the brace- and string-aware scanner that finds
 * the real end of the tag. Nothing about that function changes - several other
 * files import it.
 *
 * The trailing lookahead is the same one `findComponentTags` uses, so a name is
 * only accepted when the very next character opens attributes or closes the
 * tag. Two consequences worth stating because they were verified, not assumed:
 *
 *   - A TypeScript generic argument written as a lone type name, e.g. the
 *     element type inside an HTMLAttributes annotation, DOES match. It carries
 *     no className, so it contributes zero sites and zero tokens. Asserted
 *     below rather than filtered, because filtering by name is exactly the
 *     dodge this ratchet exists to prevent.
 *   - A dotted name is captured whole, so a namespaced tag is counted under its
 *     full name and never double-counted under its first segment.
 */
function findTagNames(code: string): string[] {
  const names = new Set<string>();
  for (const m of code.matchAll(/<([A-Za-z][A-Za-z0-9_.]*)(?=[\s/>])/g)) names.add(m[1]!);
  return [...names];
}

/**
 * `countOverridesInFile` for every tag rather than one named component.
 *
 * Deliberately a separate function that repeats four lines rather than a
 * generalisation of `countOverridesInFile`. That function and its signature are
 * imported elsewhere; widening it to take an optional name would change a live
 * contract to save four lines, which is a bad trade in a file this many callers
 * depend on.
 *
 * `classifyToken` is still called with the tag's own name, so the Card-scoped
 * alignment carve-out keeps applying to a literal Card tag here too. That is
 * intentional: the same site must never read as appearance under one ratchet
 * and layout under the other.
 */
function countAnyTagOverridesInFile(rawCode: string): OverrideCounts {
  const code = stripComments(rawCode);
  const counts: OverrideCounts = { sites: 0, appearance: 0, layout: 0, other: 0 };
  for (const name of findTagNames(code)) {
    for (const attrs of findComponentTags(code, name)) {
      const tokens = classNameTokens(attrs);
      if (!tokens.length) continue;
      counts.sites++;
      for (const tok of tokens) counts[classifyToken(tok, name)]++;
    }
  }
  return counts;
}

function countAnyTagOverrides(files: string[]): OverrideCounts {
  const total: OverrideCounts = { sites: 0, appearance: 0, layout: 0, other: 0 };
  for (const file of files) {
    const c = countAnyTagOverridesInFile(readFileSync(file, 'utf8'));
    total.sites += c.sites;
    total.appearance += c.appearance;
    total.layout += c.layout;
    total.other += c.other;
  }
  return total;
}

/** The `targetFiles()` entries that live under a DIR_CEILINGS key. */
function filesUnder(dir: string, files: string[], root = SRC): string[] {
  const prefix = dir.split('/').join(sep) + sep;
  return files.filter((f) => relative(root, f).startsWith(prefix));
}

describe('composition-layer ratchet (appearance authored inside a pattern, may only decrease)', () => {
  const files = targetFiles();

  for (const [dir, ceiling] of Object.entries(DIR_CEILINGS)) {
    const scoped = filesUnder(dir, files);

    it(`${dir} resolves to a real, non-empty file set`, () => {
      // Guards the ceiling itself: a typo in the key, or the directory being
      // renamed out from under it, would otherwise make this ratchet pass
      // forever by scanning nothing.
      expect(scoped.length).toBeGreaterThan(0);
    });

    it(`${dir} appearance tokens on ANY tag stay at or below ${ceiling}`, () => {
      const counts = countAnyTagOverrides(scoped);
      const slack = ceiling - counts.appearance;
      process.stdout.write(
        `  ratchet  ${dir.padEnd(20)} appearance ${String(counts.appearance).padStart(4)} / ${String(
          ceiling,
        ).padEnd(4)}  (files ${scoped.length}, sites ${counts.sites}, layout ${counts.layout})` +
          (slack > 0 ? ` (${slack} slack - lower the ceiling)` : ' (at floor)') +
          '\n',
      );
      expect(counts.appearance).toBeLessThanOrEqual(ceiling);
    });
  }
});

// --- asserted examples for the directory ratchet ------------------------------------

describe('composition-layer ratchet detector (asserted examples)', () => {
  it('counts appearance on a bare element no component ceiling covers, the PageHeader case', () => {
    // The exact shape phase 7e shipped and phase 7 converted: a description
    // slot written as a bare paragraph carrying its own typography.
    const counts = countAnyTagOverridesInFile('<p className="text-sm text-text-secondary">x</p>');
    expect(counts).toEqual({ sites: 1, appearance: 2, layout: 0, other: 0 });
  });

  it('reads the converted form as clean, since a primitive with props emits no className', () => {
    const counts = countAnyTagOverridesInFile('<Text as="p" size="sm" tone="secondary">x</Text>');
    expect(counts).toEqual({ sites: 0, appearance: 0, layout: 0, other: 0 });
  });

  it('still calls placement on a pattern layout wrapper layout, not appearance', () => {
    const counts = countAnyTagOverridesInFile('<Stack gap={1} className="min-w-0 shrink-0">x</Stack>');
    expect(counts).toEqual({ sites: 1, appearance: 0, layout: 2, other: 0 });
  });

  it('is not a fixed list of tag names: an invented tag is enumerated like any other', () => {
    const counts = countAnyTagOverridesInFile('<WhateverWeAddInPhase10 className="p-6" />');
    expect(counts).toEqual({ sites: 1, appearance: 1, layout: 0, other: 0 });
  });

  it('captures a dotted tag name whole, so it is counted once and not under its first segment', () => {
    expect(findTagNames('<Menu.Item className="p-6" />')).toEqual(['Menu.Item']);
    const counts = countAnyTagOverridesInFile('<Menu.Item className="p-6" />');
    expect(counts).toEqual({ sites: 1, appearance: 1, layout: 0, other: 0 });
  });

  it('a TypeScript generic argument matches the name scan but contributes nothing', () => {
    expect(findTagNames('interface P extends HTMLAttributes<HTMLDivElement> {}')).toEqual([
      'HTMLDivElement',
    ]);
    const counts = countAnyTagOverridesInFile(
      'interface P extends HTMLAttributes<HTMLDivElement> {}\n<p className="text-sm">x</p>',
    );
    expect(counts).toEqual({ sites: 1, appearance: 1, layout: 0, other: 0 });
  });

  it('inherits comment stripping, so a tag quoted in a doc block is not a call site', () => {
    const code =
      '/**\n * The shell used to emit <div className="p-6"> of its own.\n */\nexport function X() { return null; }';
    expect(countAnyTagOverridesInFile(code)).toEqual({
      sites: 0,
      appearance: 0,
      layout: 0,
      other: 0,
    });
  });

  it('inherits the nested-prop rule: a className inside a prop value is not the outer tag\'s', () => {
    const code = '<PageHeader\n  actions={<button className="p-6">Go</button>}\n/>';
    // One site, the nested button, counted under its own name. PageHeader
    // itself has no direct className and so is not a site at all.
    expect(countAnyTagOverridesInFile(code)).toEqual({
      sites: 1,
      appearance: 1,
      layout: 0,
      other: 0,
    });
  });

  it('filesUnder matches on a path segment, not a substring of a sibling name', () => {
    const root = join('r', 'src');
    const scoped = filesUnder(
      'components/patterns',
      [
        join(root, 'components', 'patterns', 'PageHeader.tsx'),
        join(root, 'components', 'patterns-legacy', 'Old.tsx'),
        join(root, 'pages', 'InvoicesPage.tsx'),
      ],
      root,
    );
    expect(scoped).toEqual([join(root, 'components', 'patterns', 'PageHeader.tsx')]);
  });
});

// --- raw-tag ratchet (phase 11 prerequisite, "raw-tag-ratchet" PR) ---------------
//
// CEILINGS and DIR_CEILINGS above both count APPEARANCE-TOKEN overrides - a
// className written on a named primitive, or on any tag inside a composition
// directory. Neither can express "how many raw <button>s are left to convert
// to <Button>": that is a count of TAG OCCURRENCES, not classNames, and most
// raw tags in this tree carry no className at all. This is a third,
// independent ratchet, keyed by HTML tag name, for exactly the 9 tags phase
// 11's conversion steps (11c-11g) target: button, input, label, textarea,
// select, heading (h1-h6, one ceiling), a, table, img.
//
// Boundary bug this exists to prevent, found while re-measuring 2026-07-30:
// an earlier scratch script used a character class as the tag boundary, e.g.
// `<button[ >]` - which only matches the tag name followed by a literal
// space or `>` on the SAME LINE. It silently missed the dominant real-world
// multi-line JSX open-tag form:
//
//   <button
//     onClick={handleClick}
//   >
//
// because `[ >]` has no `\n` member. That one bug produced an 8x undercount
// on <button> alone. The boundary below is a lookahead against a character
// class that explicitly includes `\s` - which already matches space, tab
// AND newline with no regex flags needed - plus `/` and `>` for the
// self-closing and bare-close forms: `(?=[\s/>])`. Proven against the exact
// multi-line shape above in the asserted examples, not just asserted as a
// property of the regex.
//
// Case-sensitive, exact-tag-name boundary, same guarantee `findComponentTags`
// above already gives named primitives: `<button` does not match
// `<ButtonGroup` (next char `G` is not in the boundary class) or
// `<buttonWrapper` (next char `W`), only a real `<button>` open tag.
//
// Scoped identically to CEILINGS: `targetFiles()`, i.e. every .tsx file
// outside components/ui/ (where these tags are legitimately authored, once,
// inside the primitives themselves), test files and __tests__ dirs.
//
// Measured fresh 2026-07-30 against the current tree with this exact
// function - NOT copied from this plan doc's own "re-measured 07-30" table
// (md_files/plans/frontend/2026-07-27-ui-component-architecture-program.md),
// which a live re-measurement found to disagree with the tree as it actually
// stands. Cross-checked two independent ways - this regex scanner, and a
// separate TypeScript-compiler-API walk counting real JsxOpeningElement /
// JsxSelfClosingElement AST nodes by tag name - and both agree exactly on
// every one of the 9 counts below:
//
//   button 839, input 252, label 158, textarea 39, select 4, heading 215,
//   a 44, table 57, img 38
//
// Seeded at exactly the measured value each - no slack, per "never raise a
// ratchet, never re-baseline to make it pass silently".
const RAW_TAG_PATTERNS: Record<string, RegExp> = {
  button: /<button(?=[\s/>])/g,
  input: /<input(?=[\s/>])/g,
  label: /<label(?=[\s/>])/g,
  textarea: /<textarea(?=[\s/>])/g,
  select: /<select(?=[\s/>])/g,
  heading: /<h[1-6](?=[\s/>])/g,
  a: /<a(?=[\s/>])/g,
  table: /<table(?=[\s/>])/g,
  img: /<img(?=[\s/>])/g,
};

const RAW_TAG_CEILINGS: Record<string, number> = {
  // 839 -> 838, "workflow-builder-buttons" batch: StepNode.tsx's kebab
  // actions trigger converts to Button (variant="ghost" tone="subtle"
  // size="icon", matching the recipe already shipped at
  // pages/workflows/WorkflowsHome.tsx:322). AddStepButton.tsx's rail `+`
  // trigger was ALSO tried the same way (variant={null} size="icon") but
  // reverted: its 44px circle needs a call-site `rounded-full` override to
  // stay circular (Button's own base always ships `rounded-button`, 14px),
  // and that specific override is exactly what the separate layering-guard
  // hard-appearance ratchet (ceiling 29, unrelated to this batch) forbids
  // increasing - left raw rather than regress that ratchet. The other 28 raw
  // buttons across this same 12-file batch (AddStepButton.tsx,
  // MergeFieldChips.tsx, RecipientMultiSelect.tsx, StepNode.tsx,
  // TestWorkflowDialog.tsx, TriggerForm.tsx, TriggerNode.tsx, WaitForm.tsx,
  // trigger/DateModePanel.tsx, trigger/EventModePanel.tsx,
  // trigger/ModeFork.tsx, trigger/SubjectPicker.tsx) are documented
  // deferrals, each commented in place: segmented toggle controls
  // (WaitForm.tsx x8, DateModePanel.tsx x3), list-row/card/radio-option click
  // targets (StepNode.tsx's selectable body, TriggerNode.tsx,
  // EventModePanel.tsx, ModeFork.tsx x2, SubjectPicker.tsx x2), a dropdown
  // menu item row (AddStepButton.tsx), chip/pill patterns with no matching
  // cell (MergeFieldChips.tsx x2, TriggerForm.tsx's CrumbChip), a close-X
  // inside a chip (RecipientMultiSelect.tsx), a dashed "add step" CTA family
  // with no matching cell (AddStepButton.tsx x2, including the reverted rail
  // trigger above), a plain-text disclosure toggle whose sizing/hover doesn't
  // match link slash brand (TestWorkflowDialog.tsx), and one dnd-kit drag
  // handle (StepNode.tsx, program's own never-convert list).
  // 838 -> 832, "dashboard widgets and layout controls" batch: NewMenu.tsx (the
  // "+ New" trigger), layout/CatalogDrawer.tsx (the drawer close-X), and the
  // header "view all" / "report" / "full calendar" text links in
  // widgets/Catalog.tsx (2) and widgets/TodaySchedule.tsx (1) now render through
  // Button. The remaining 11 raw buttons in this batch's files are list-row /
  // card click targets, a dropdown menu item, or hover treatments (scale-pop,
  // chip-bg + reveal-danger) with no matching variant/tone cell - each left raw
  // with a comment at its site.
  // 832 unchanged, "estimate-workspace-ai-center" batch: zero-conversion audit,
  // all 17 raw buttons in that batch are non-Button-shaped or have no clean
  // variant/tone/size match - see that batch's own comment above for detail.
  // 832 -> 829, "app layout, schedule board and data-table controls" batch:
  // AppLayout.tsx's two header hamburger toggles and Sidebar.tsx's collapsed
  // "AI Agentic Farm" icon launcher now render through Button (variant="onDark"
  // size="icon"). Corner radius goes from rounded-lg (--radius-card, 6px) to
  // the primitive's own rounded-button (--radius-button, 14px) - a real,
  // disclosed visible change on always-on nav chrome, and a correction: these
  // 3 buttons were the ones that had never picked up the app's own intentional
  // "buttons render softer than the 6px crisp default" rule (tokens.css:116),
  // while every other onDark icon button already in the tree (CopilotSheet.tsx,
  // CopilotPanel.tsx) already renders at 14px. The other 31 raw buttons across
  // the same 12-file batch (GlobalSearch.tsx, Header.tsx, Sidebar.tsx x5 more +
  // the 2 asChild-nested Quick Create triggers, SidebarAddShortcut.tsx,
  // ContextMenu.tsx, QuickScheduleCard.tsx, ScheduleSearch.tsx,
  // SettingsGearDropdown.tsx, UnassignedBuckets.tsx, ContactCell.tsx,
  // components/data/data-table.tsx) stay raw and are each commented in place:
  // list-row/listbox-option targets, a segmented tab toggle, dropdown/
  // context-menu items, close-X affordances, asChild-nested Radix triggers,
  // and a few genuine colour/shape mismatches against every minted
  // variant/tone cell.
  // Re-measured against this exact classifier post-conversion, cumulative
  // across all four merged batches.
  // 829 -> 818, "inventory category/location pickers and PO approval flows"
  // batch: 11 conversions across CategorySelector.tsx (1, delete-row icon),
  // CreateStageDialog.tsx (3, Preview PO footer button + Add item + Remove
  // line icon), DeleteItemDialog.tsx (1, Archive/Delete Item), FiltersPopover.tsx
  // (3, both "Clear all" text buttons + the Apply footer button) and
  // LowStockView.tsx (3, the row Generate PO button + both pagination
  // chevrons). The other 27 raw buttons across this same 12-file batch stay
  // raw and are each commented in place: asChild-nested Popover triggers
  // (CategorySelector.tsx, FiltersPopover.tsx, LocationSelector.tsx),
  // list-row/listbox-row/card click targets (CategorySelector.tsx x2,
  // LocationSelector.tsx x2, LocationStockHealth.tsx's card body), segmented
  // toggle controls (FiltersPopover.tsx's local Chip - the layering-guard
  // test's own named fixture, EmailComposeDialog.tsx's suggestion chip,
  // NewApprovalRequestDialog.tsx's action-type card grid), close-X
  // affordances inside a chip (EmailComposeDialog.tsx, FiltersPopover.tsx),
  // brand-tinted outline/ghost/filled buttons with no matching cell
  // (CategorySelector.tsx's Edit row-icon + Add-category footer,
  // CreateStageDialog.tsx's Email PO to Vendor, LocationSelector.tsx's Add
  // Location footer, LowStockView.tsx's Generate PO (all) toolbar button,
  // NewApprovalRequestDialog.tsx's Submit+Email Team + Scan buttons),
  // success/warning-toned buttons where neither tone is minted on Button
  // (DeleteVendorDialog.tsx's Archive vendor, EstimateComparisonDialog.tsx x2,
  // ImportCSVDialog.tsx's Reset, LocationStockHealth.tsx's Restock pill), a
  // danger-toned text link with no matching link/danger cell
  // (DeleteVendorDialog.tsx's Delete permanently), a group-hover:opacity
  // reveal on the button's own className that would add new SOFT classes at
  // the layering guard's zero-slack soft ceiling (LocationSelector.tsx's row
  // edit icon), and a mini pill nested inside an `uppercase` ancestor that
  // needs its own `normal-case` for the same zero-slack reason
  // (CreateStageDialog.tsx's inline Preview PO pill).
  // 818 -> 788, "inventory PO and stage detail dialogs" batch: NewPODialog.tsx
  // (Add line -> outline/neutral, "Clear"/"Clear filters" -> link/brand),
  // NotificationsDropdown.tsx (bell trigger -> ghost/subtle icon, dropping the
  // open-state ring, geometry restored via a layout-only h-8 w-8 override),
  // PODetailDialog.tsx (Save Receipt -> solid/business, the staged-disabled
  // pill -> solid/neutral), POPreviewDialog.tsx and StagePreviewDialog.tsx
  // (Save as PDF / Email Ticket -> outline/neutral), RestockDialog.tsx
  // (Receive N -> solid/business, Preview -> outline/neutral), ScanDialog.tsx
  // (Open Item / Start Scanning / Use this item / Create new item ->
  // solid/brand), SetQuantityDialog.tsx (Set quantity -> solid/business),
  // SignatureField.tsx (Re-sign / Apply my signature / Sign differently /
  // Sign·Adopt & Sign), and StageDetailDialog.tsx (Preview/Email/Print/PDF
  // footer trio x2 -> outline/neutral, Take photo/Record video -> solid/brand,
  // Select all/Clear -> outline/neutral). --success and --sage-700 share one
  // RGB (tokens.css), so solid/business is a pixel-exact match for every
  // success-CTA site converted here. The remaining 34 raw buttons across this
  // batch's 12 files stay raw, each commented in place: list-row / gallery /
  // typeahead-result click targets, segmented toggle and filter-chip rows,
  // selectable grid tiles, close-X affordances (chip, thumbnail overlay,
  // dialog header, alert banner), a combobox/select-trigger styled as a form
  // field, and colour/tone gaps against every minted cell (no outline+brand,
  // outline+success, or link+neutral/success tone exists; one site's font-mono
  // typography cue has no slack left in the frozen SOFT ratchet to restore).
  // Re-measured against this exact classifier, cumulative across all five
  // merged button batches.
  // NOTE for every batch record below that names `assets/AssetsView.tsx` or
  // `assets/AssetHistoryDrawer.tsx`: BOTH FILES ARE DELETED. They were the
  // Assets tab of the dead v1 `pages/inventory/InventoryPage.tsx`, their only
  // importer, and the routed page has carried its own kit-built replacements
  // (`pages/v2/inventory/components/{assetsView,assetHistoryPanel}.tsx`) since
  // the v2 rebuild. Deleting the v1 page orphaned them, so they went with it.
  // The batch totals below are deliberately left as measured - they were true
  // when taken - and the citations are annotated by this one note rather than
  // rewritten one by one, so a reader who greps either filename finds the
  // reason here. Their sibling `assets/{AssetDialog,AssetActionDialog,
  // AssetBits}.tsx` are all still live: the v2 forks import them directly.
  // 788 -> 765, "inventory transfer, staging and asset views" batch: 23 of
  // the 50 raw buttons across StagingAreaPicker.tsx, StagingView.tsx,
  // TransferDialog.tsx, VendorDetailDialog.tsx, assets/AssetActionDialog.tsx,
  // assets/AssetDialog.tsx and assets/AssetHistoryDrawer.tsx now render
  // through Button (VendorCard.tsx, lo/LOList.tsx and lo/TrackedItemSearch.tsx
  // had zero conversions - see below). The 27 remaining raw buttons across
  // this same 12-file batch are documented deferrals, each commented in
  // place: segmented toggle/filter controls (TransferDialog.tsx's DestPill
  // + ModeButton, StagingView.tsx's filter tabs, VendorDetailDialog.tsx's
  // transmit-method toggle, LOList.tsx's status chips), list-row/listbox-
  // option/dropdown-menu-item targets (StagingAreaPicker.tsx's preset row,
  // TransferDialog.tsx's and AssetDialog.tsx's search-result rows,
  // AssetsView.tsx's KebabAction, TrackedItemSearch.tsx's result row), a
  // close-X inside a chip (TransferDialog.tsx, AssetDialog.tsx), a
  // whole-card click target with heterogeneous content (VendorCard.tsx),
  // two-state triggers with no matching cell (StagingAreaPicker.tsx's
  // warehouse-area pill, StagingView.tsx's From-PO trigger), chip/badge-
  // styled links (StagingView.tsx's job# chip and Open Full Transaction
  // action), an idle-neutral/hover-brand text link with no matching cell
  // (StagingView.tsx's customer name), and colour tones this primitive does
  // not mint at all - `success` (StagingView.tsx's Receive +1 and Mark
  // Delivered), `warning` (VendorDetailDialog.tsx's Archive/Reactivate) and
  // outline/brand (VendorDetailDialog.tsx's Add-contact, StagingView.tsx's
  // Open Full Transaction). 4 sites originally converted to outline/neutral
  // were reverted to raw after adversarial review: that cell sets no idle
  // text colour (button.tsx's own header note), and none of these 4 rows'
  // ambient wrappers set one either, so the label would have silently
  // rendered near-black instead of the raw's muted text-secondary -
  // StagingView.tsx's PO-picker Preview, TransferDialog.tsx's Max(n) and
  // StagingDestCard Preview PO, VendorCategoryPicker.tsx's create-category
  // Cancel-x (VendorCategoryPicker.tsx has zero remaining conversions as a
  // result - its one other site, the +Add-new icon button, was correctly
  // deferred from the start for an unrelated hover-colour mismatch).
  // Re-measured against this exact classifier post-conversion, cumulative
  // with all prior batches.
  // 765 -> 752, "inventory add/approval dialogs" batch: ActionLogView.tsx
  // (Export CSV -> outline/neutral, both pagination chevrons -> outline/
  // neutral 3xs), AddGroupDialog.tsx (Remove line icon -> ghost/danger
  // revealOnHover 3xs, the item-picker dropdown's Close row -> ghost/subtle
  // 3xs), AddItemDialog.tsx (footer Save Item -> solid/brand default),
  // AddVendorDialog.tsx (Remove contact icon -> ghost/danger 3xs),
  // ApprovalDetailDialog.tsx (Reject -> outline/danger, Approve · post
  // movement -> solid/business, Confirm Reject -> solid/danger, the "Open
  // Job ->" inline link -> link/brand size={null}, matching the identical
  // StagingView.tsx precedent from the "transfer, staging and asset views"
  // batch immediately above), and CategoryManagerDropdown.tsx (the
  // rename-row and add-row Cancel-X icons -> ghost/subtle 3xs, 2 sites; the
  // inline add row was later removed - its footer now hands off to the vendor
  // category manager - so only the rename-row Cancel-X remains).
  // --success and --sage-700 share one RGB (tokens.css), so solid/business
  // is again a pixel-exact match for the Approve CTA. The remaining 36 raw
  // buttons across this batch's 12 files stay raw, each commented in place:
  // photo-tile upload triggers with a conditional idle ring/bg state
  // (AddBrandDialog.tsx, AddCategoryDialog.tsx, AddGroupDialog.tsx),
  // danger-toned text links with no matching link/danger cell, list-row/
  // listbox-row/card/accordion-header click targets, segmented toggle/
  // filter-chip/card-grid controls, close-X affordances (chip,
  // photo-thumbnail overlay), an asChild-nested Popover trigger, sites where
  // outline/neutral's unset idle text colour would silently go near-black
  // against a muted text-secondary label with no ambient replacement,
  // bg-background-light buttons with a no-op hover and no matching outline
  // cell (outline/neutral carries bg-surface-light), a group-hover:opacity
  // reveal with no ghost/subtle#reveal cell minted (only ghost/danger#reveal
  // exists), and colour/tone gaps against every minted cell (no
  // outline+brand or ghost+brand tone exists; ghost/success is not
  // implemented on Button at all). Re-measured against this exact
  // classifier, cumulative across all seven merged button batches.
  // 752 -> 741, "job detail, items and overview cards" batch: 11 conversions
  // across components/jobs/{EditJobLocationDialog,TeamCard(0),AddLineDialog,
  // items/ClampedDescription,items/LineItemRow,items/LineItemsTable,
  // items/ScopeOfWorkCard,overview/CustomerContactCard,overview/JobFilesCard}
  // .tsx - EditJobLocationDialog.tsx ("Add new address" + "Pick an existing
  // address instead" -> link/brand size={null}), AddLineDialog.tsx ("Change"
  // + "Back to search" -> link/brand size={null}), ClampedDescription.tsx
  // (the "more"/"less" toggle -> link/brand size={null}), LineItemRow.tsx
  // (the Edit pencil -> ghost/subtle icon, the Trash delete -> ghost/danger
  // icon, both with a layout-only h-8 w-8 override matching the
  // NotificationsDropdown.tsx precedent), LineItemsTable.tsx (the empty-state
  // "Add line item" CTA -> solid/business sm), ScopeOfWorkCard.tsx (the
  // per-block delete -> ghost/danger icon, same h-8 w-8 override),
  // CustomerContactCard.tsx ("View All" in the Communication History header
  // -> link/brand size={null}), and JobFilesCard.tsx ("View all" -> link/
  // brand size={null}). --sage-700/--success share one RGB (tokens.css), so
  // solid/business is again a pixel-exact match. The remaining 29 raw buttons
  // across this same 16-file batch stay raw, each commented in place:
  // list-row/card/grid-tile click targets with heterogeneous content
  // (EditJobLocationDialog.tsx's location row, AddLineDialog.tsx's search-
  // result row, PriceBookPicker.tsx's category card and item-card body,
  // AiJobAssistantBar.tsx's agent tile), a composite multi-part node click
  // target (JobLifecycleBar.tsx), a dnd-kit drag handle (LineItemRow.tsx,
  // this program's own never-convert shape), idle-opacity/hover-opacity
  // reorder chevrons where neither ghost/neutral (no idle colour at all) nor
  // ghost/subtle (hover jumps to text-text-primary, not the same-hue step)
  // reproduces the pair (LineItemRow.tsx x2, ScopeOfWorkCard.tsx x2), dashed
  // "add new" CTA cards with no matching cell (AddLineDialog.tsx,
  // PriceBookPicker.tsx's AdhocCard, ScopeOfWorkCard.tsx's "+ Flat price"),
  // a joined quantity-stepper pair sharing one border (PriceBookPicker.tsx's
  // QtyStepper x2), a segmented $/% toggle half (ReceiptCard.tsx's
  // ModeToggleGroup), an active-filter chip with a close-X (PriceBookPicker.
  // tsx), a two-state toggle pill with no matching cell (ScopeOfWorkCard.
  // tsx's Taxable pill), a variable-dimension photo tile with its own
  // overlay zoom control (ProductThumb.tsx), and idle-brand/hover-colour-
  // shift text links where no cell reproduces a hover that recolours instead
  // of underlining (TeamCard.tsx x3, ScopeOfWorkCard.tsx's "Save as preset",
  // CustomerContactCard.tsx's in-app-call number + its Call grid tile, which
  // must also stay visually identical to its sibling Text/Email/Map <a>
  // tiles), and AI-surface accent colours with no ai-toned cell minted
  // (AiInsightsCard.tsx, AiJobAssistantBar.tsx's "AI Agentic Farm" link,
  // JobNotesPreview.tsx's brand-tinted +/close toggle). Re-measured against
  // this exact classifier, cumulative across all eight merged button
  // batches.
  // 741 -> 736, "task and CRM shared field-cluster components" batch: 5 of the
  // 39 raw buttons across AiCommandBar.tsx, TaskDetailDrawer.tsx (2 sites:
  // Add subtask, Post), AttachmentsPanel.tsx (the empty-state Upload file CTA)
  // and AssigneeSelect.tsx (the combobox trigger, composed under
  // PopoverTrigger asChild the same way CustomerPickerWithCreate.tsx already
  // does) now render through Button - all solid/brand size="3xs" except the
  // outline/neutral trigger. The other 34 raw buttons across this same
  // 16-file batch stay raw and are each commented in place: segmented
  // toggle/filter-chip/type-toggle-badge controls (LinkedEntitySelect.tsx,
  // LineItemsEditor.tsx x7, IconRail.tsx's rail), dropdown-menu-item/listbox-
  // option rows (LinkedEntitySelect.tsx x2, AssignTeamPopover.tsx,
  // AssigneeSelect.tsx, CustomerPickerWithCreate.tsx x2, PickOrCreateCustomer.tsx,
  // address-autocomplete.tsx, LineItemsEditor.tsx's price-book row,
  // AttachmentsPanel.tsx's accordion header), close-X affordances
  // (AttachmentSection.tsx, MultiAssigneeSelect.tsx, IconRail.tsx),
  // small row/thumbnail-overlay delete icons (AttachmentSection.tsx,
  // AttachmentsPanel.tsx, LineItemsEditor.tsx x2), a bespoke idle-muted/
  // hover-to-brand-tone toggle with no matching ghost cell (TaskCard.tsx),
  // sites where outline/neutral's unset idle text colour would silently go
  // near-black against a muted text-secondary label with no ambient
  // replacement (TaskDetailDrawer.tsx's Nudge, TaskFilterBar.tsx x2), a
  // danger-toned row action whose hover token (--danger-text) has no matching
  // ghost/danger cell (TaskDetailDrawer.tsx's subtask delete), and a dotted-
  // underline link-styled text trigger with no matching link tone or size
  // rung (PaymentFeeBreakdown.tsx). Re-measured against this exact classifier,
  // cumulative across all nine merged button batches.
  // 736 -> 726, "shared report toolbar chrome" batch: all 10 non-listbox/
  // non-close-X raw buttons in pages/reports/_shared.tsx now render through
  // Button - the date-range/multi-select trigger and both Export/Fields
  // toolbar buttons (variant="outline" tone="neutral"), all four pager
  // Prev/Next buttons (outline/neutral, size="3xs" on the compact pager,
  // size="sm" on the default one), the FilterPanel trigger (outline/neutral
  // size="lg"), and the filter-panel "Clear all" text link (variant="link"
  // tone="brand", a byte-for-byte match of its original recipe). The other 5
  // raw buttons in the same file stay raw and are each commented in place:
  // 3 dropdown-menu-item/listbox-option rows (MultiSelectFilter's "All X" and
  // per-option rows, FacetFilter's per-column option row) and 2 close-X
  // affordances (FacetFilter's per-chip remove, FacetFilter's clear-all X -
  // the latter has no Button size cell close to its ~24px footprint, the
  // icon rung being a 40px square). This file is imported by every report
  // page, so nothing in pages/reports/ beyond it needed touching.
  // 726 -> 725, "report pages with no adjacent raw input/label" batch: 1 of the
  // 15 raw buttons across ActivityFilterBar.tsx, ActivityReport.tsx,
  // ArAgingReport.tsx, CommunicationTrackingReport.tsx (3),
  // ItemsServicesReport.tsx (2), MetricDetailPanel.tsx, PersonMetricPanel.tsx,
  // TechPerformanceBoard.tsx, TimesheetsReport.tsx (3) and
  // WeeklyRepDiagnostic.tsx now renders through Button
  // (ActivityFilterBar.tsx's "Clear all", ghost/subtle size="3xs"). The other
  // 14 raw buttons across this same 10-file batch stay raw and are each
  // commented in place: segmented tab/toggle controls (CommunicationTrackingReport.tsx's
  // tab strip, ItemsServicesReport.tsx's Company/Technician toggle,
  // TimesheetsReport.tsx's tab strip, WeeklyRepDiagnostic.tsx's
  // conversion-formula toggle), a 3-state breadcrumb whose active pill is
  // `disabled` with no faded look - converting it would pick up Button's
  // baked-in `disabled:opacity-50` (ActivityReport.tsx's crumb), a list-row
  // expand/collapse chevron (ArAgingReport.tsx), close-X affordances
  // (MetricDetailPanel.tsx, PersonMetricPanel.tsx), sites with no `warning`
  // tone minted on Button (CommunicationTrackingReport.tsx's Sample/Live
  // toggle) or no tone that covers a brand-tinted active pill plus a muted
  // idle state in one cell (TechPerformanceBoard.tsx's Active-techs-only
  // toggle), sites where outline/neutral's unset idle text colour would
  // silently go near-black against a muted text-secondary label with no
  // ambient replacement (CommunicationTrackingReport.tsx's Export, the same
  // trap as TaskFilterBar.tsx), and a paired success/danger row-action icon
  // set where no ghost/success cell exists and converting only the danger
  // half would misalign the pair's geometry (TimesheetsReport.tsx's
  // Approve/Reject). Re-measured against this exact classifier, cumulative
  // across all eleven merged button batches.
  // 725 -> 708, "inventory list pages" batch: 17 of the 34 raw buttons across
  // InventoryPage.tsx (10), VendorsPage.tsx (1), PriceBookPage.tsx (3) and
  // PurchaseOrdersPage.tsx (3) now render through Button - header CTAs
  // (Create PO / Add Vendor -> solid/brand default; Transfer/Import CSV/
  // Export -> outline/neutral sm), compact action rows (Restock/Transfer ->
  // solid/business|brand 3xs, Edit/Delete -> outline/neutral|danger 3xs), a
  // "Clear filter" link (ghost/subtle 3xs), a filled CTA (Restock All Low
  // Stock -> solid/business 3xs) and several small icon triggers (kebab
  // "More actions", brand Edit/Delete, PO row Preview/Email/Receive ->
  // ghost/subtle|danger size="icon", h-6 w-6 layout override, one disabled).
  // The other 17 raw buttons across this same 4-file batch stay raw and are
  // each commented in place: segmented toggle controls (VendorsPage.tsx's
  // status pill row, InventoryPage.tsx's ViewTab strip, PriceBookPage.tsx's
  // visibility pill), dropdown-menu-item rows (InventoryPage.tsx's
  // KebabAction), a close-X affordance (InventoryPage.tsx's DetailPanel,
  // which had no accessible name and got one added), KPI-tile click-filter
  // targets with heterogeneous content (VendorsPage.tsx, PriceBookPage.tsx,
  // PurchaseOrdersPage.tsx x2), photo-overlay contrast chips whose own
  // bg-surface-light/90 backdrop-blur-sm shadow-sm no background-less ghost
  // cell reproduces (PriceBookPage.tsx's bundle + category card Edit/Delete,
  // 4 sites), and colour/tone gaps against every minted cell - a filled
  // success-tinted outline (InventoryPage.tsx's Restock), a brand-tinted
  // outline (InventoryPage.tsx's Generate PO), a filter chip with an idle
  // background no ghost/outline cell carries (PurchaseOrdersPage.tsx's Clear
  // KPI filter), a brand-tinted filled pill (PurchaseOrdersPage.tsx's
  // NextActionLabel), and an idle-neutral/hover-brand text link no link cell
  // reproduces (PurchaseOrdersPage.tsx's PO# preview trigger). Re-measured
  // against this exact classifier, cumulative across all twelve merged
  // button batches.
  // 708 -> 690, "adopt Button on remaining report pages (buttons only, inputs
  // untouched)" batch: 18 of the 54 raw buttons across CampaignRoiReport.tsx (3:
  // Cancel/reset -> ghost/subtle size="3xs", Export CSV -> outline/neutral),
  // CommissionsReport.tsx (1: DateRangePicker trigger -> outline/neutral
  // size="sm"), EstimateConversionReport.tsx (2: FilterMenu trigger ->
  // outline/neutral size="3xs", Clear filters -> link/brand size={null}),
  // EstimatesReport.tsx (1: Export -> outline/neutral size="3xs"),
  // ExpensesReport.tsx (3: Export -> outline/neutral size="sm", Prev/Next pager
  // -> outline/neutral size="sm"), JobStatisticsReport.tsx (1: "Show all techs"
  // -> link/brand size={null}), JobsReport.tsx + LeadsReport.tsx +
  // SalesReport.tsx (2 each, 6 total: their identical FieldsModal footer -
  // Cancel -> ghost/subtle, Save fields -> solid/brand), and PaymentsReport.tsx
  // (1: Clear -> ghost/subtle size="3xs") now render through Button.
  // TimesheetsReport.tsx's Reject override icon was also converted here
  // (ghost/danger size="icon") but reverted during rebase against the "report
  // pages with no adjacent raw input/label" batch above, which independently
  // and correctly left this exact Approve/Reject pair raw for the geometry
  // reason already stated there - deferring to that established precedent
  // rather than re-litigating it. The other 36 raw buttons across this same
  // 12-file batch stay raw and are each commented in place: segmented toggle /
  // filter-chip / date-anchor / By-Time / report-type / view controls
  // (CommissionsReport.tsx x2, EstimateConversionReport.tsx x3,
  // EstimatesReport.tsx x3, ItemsServicesReport.tsx x2), underline
  // tab-navigation controls (JobStatisticsReport.tsx, TimesheetsReport.tsx),
  // dropdown-menu-item / checklist / listbox-option rows (CommissionsReport.tsx
  // x3, JobsReport.tsx x2, LeadsReport.tsx x2, PaymentsReport.tsx x1,
  // SalesReport.tsx x2), a grid-tile click target with heterogeneous content
  // (EstimateConversionReport.tsx's aging bucket), small close-X affordances
  // (ExpensesReport.tsx's DrillChart close, EstimatesReport.tsx's rep-scope
  // clear), a two-state toggle with no matching retoned-outline cell
  // (EstimateConversionReport.tsx's Sample-data toggle), two-state tinted
  // pills with no success/warning tone minted on Button (ExpensesReport.tsx's
  // Receipt/Status cells), a solid CTA filled with bg-text-primary with no
  // matching solid tone (CampaignRoiReport.tsx's Add, CommissionsReport.tsx's
  // Apply), and sites where outline/neutral's unset idle text colour would
  // silently go near-black against a muted text-secondary label with no
  // ambient replacement (CommissionsReport.tsx's FieldsMenu trigger +
  // ActionBtn, PaymentsReport.tsx's FilterResults trigger). Re-measured
  // against this exact classifier, cumulative across all thirteen merged
  // button batches.
  // 690 -> 685, "estimate dialogs and schedule board controls" batch: 5 of the
  // 28 raw buttons across components/estimates/{NewEstimateDialog,
  // SendEstimateDialog,DuplicateEstimateDialog,photos/PhotoAttachmentStrip}.tsx
  // and components/schedule/{QuickScheduleCard,ContextMenu,
  // SettingsGearDropdown,ScheduleSearch,UnassignedBuckets}.tsx now render
  // through Button - all 5 in NewEstimateDialog.tsx ("Create new lead" /
  // "Create estimate without a lead" x2 each, "Add new client") -> link/brand
  // size={null}. The other 23 raw buttons across these 9 files stay raw, each
  // commented in place: list-row/card-row click targets (NewEstimateDialog.tsx
  // x3, DuplicateEstimateDialog.tsx's selectable lead row), footer action rows
  // where idle text stays brand-coloured and only the background changes on
  // hover, a pair no ghost+brand or outline+brand cell reproduces
  // (NewEstimateDialog.tsx x2), a photo thumbnail tile, its
  // hover-reveal close-X overlay, and a dashed "add new" CTA tile
  // (photos/PhotoAttachmentStrip.tsx), and a chip close-X
  // (SendEstimateDialog.tsx). The 13 raw buttons across the 5 schedule/ files
  // were already reviewed and left raw, each with its own comment, by the
  // earlier "app layout, schedule board and data-table controls" batch (see
  // 832 -> 829 above) - re-verified here against this exact classifier, zero
  // new conversions or comments needed. Re-measured cumulative across all
  // fourteen merged button batches.
  // 685 -> 684, "pages/reports batch" (CommissionsReport.tsx,
  // CallsReport.tsx and CampaignRoiReport.tsx held out, in-flight
  // elsewhere): 1 of the 45 raw buttons across this scope now renders through
  // Button - InvoicesReport.tsx's "Clear filters" -> ghost/subtle size="3xs"
  // (identical recipe to PaymentsReport.tsx's "Clear" in the same directory:
  // idle text-text-secondary / hover text-text-primary is an exact colour
  // match, the rung adds a hover:bg-background-light the raw never had, and
  // shrinks the raw's unset footprint to the 3xs rung's fixed h-6/px-2,
  // disclosed). The other 44 raw buttons across this scope stay raw. 41 of
  // them already carried their own in-place deferral comment from an earlier
  // batch (ActivityReport.tsx's breadcrumb, ArAgingReport.tsx's row chevron,
  // CommunicationTrackingReport.tsx, EstimateConversionReport.tsx,
  // EstimatesReport.tsx, ExpensesReport.tsx, ItemsServicesReport.tsx,
  // JobStatisticsReport.tsx, JobsReport.tsx, LeadsReport.tsx,
  // MetricDetailPanel.tsx, PaymentsReport.tsx, PersonMetricPanel.tsx,
  // SalesReport.tsx, TechPerformanceBoard.tsx, TimesheetsReport.tsx,
  // WeeklyRepDiagnostic.tsx and _shared.tsx) - re-verified here against this
  // exact classifier, zero new conversions or comments needed. The remaining
  // 3, all in DateRangeControl.tsx (a control shared by 9 report pages,
  // including the two held-out ones), were undocumented and got a comment
  // added at each site in this batch: the preset-row and date-field-row
  // triggers are a two-line select-style shape (stacked title + subtext, no
  // border of its own, no fixed-height rung fits stacked content - the
  // outline/neutral idle-text trap doesn't even apply since this shape has no
  // matching cell to begin with), and the preset/field menu's option row is a
  // dropdown-menu-item / listbox-option row, the same shape deferred
  // everywhere else in this directory. Re-measured against this exact
  // classifier, cumulative across all fifteen merged button batches.
  // 684 -> 676, phase 11c "button-small-component-dirs" batch: 8 of the 35 raw
  // buttons reviewed across components/{ai-center,copilot,leads,timeclock,
  // notifications,data,filters,customers,form,service-plans}/** and
  // ErrorBoundary.tsx now render through Button - ErrorBoundary.tsx's "Go to
  // dashboard" (outline/neutral, default size; disclosed deltas: adds a
  // bg-surface-light fill + hover:bg-background-light, rounded-lg corrects to
  // rounded-button), FilterBar.tsx's "Clear all (n)" (ghost/subtle
  // size={null}) and "Done" (solid/brand 3xs; hover:bg-primary/90 normalizes
  // to the token's hover:bg-primary-dark, rounded-md corrects to
  // rounded-button), GeofenceSettingsDialog.tsx's store-row Edit/Remove
  // (ghost/subtle|danger size="icon" className="h-7 w-7", matching the
  // CustomerDetailPage.tsx precedent), EmployeePayrollCard.tsx's "All team
  // members" back link (ghost/subtle sm, matching the shared PageHeader back-
  // control recipe), and NotificationPanel.tsx's "Mark all read" and "Show
  // earlier" (ghost/subtle size={null}, matching the LeadsReport/SalesReport/
  // JobsReport footer-Cancel precedent). The other 27 raw buttons across these
  // 18 files stay raw, each commented in place: circular (rounded-full)
  // controls the layering-guard has no slack to re-round - CopilotFab.tsx's
  // FAB, Composer.tsx's mic toggle + send button, CopilotLauncher.tsx's pill,
  // VoiceOrb.tsx's orb (5, all also carry a custom glow shadow or gradient
  // toggle state no cell reproduces); toggles whose colour only appears once selected
  // (Transcript.tsx's thumbs up/down, 2); sites with no solid/success tone
  // minted on Button (NotificationItem.tsx's Approve/Deny pair and single
  // action button, 3) or no ghost/success tone (EmployeePayrollCard.tsx's
  // Approve/Reject OT pair, 2 - same gap already documented for
  // TimesheetsReport.tsx's identical pair); segmented toggle/tab controls
  // (FilterBar.tsx's facet tab list, RecurrenceBuilder.tsx's weekday chips,
  // 2); listbox/dropdown/menu-item rows and a sort toggle with no matching
  // hover recipe (StoreAddressSearch.tsx's address suggestion,
  // TagInput.tsx's sort toggle + tag-colour chip + create-tag row, 4); a chip
  // close-X, a dashed "add" pill from the same no-matching-cell family as
  // AddStepButton.tsx, and a colour-swatch picker (TagInput.tsx, 3); idle-
  // secondary text links with no matching link/brand or ghost cell
  // (CreateJobFromLeadDialog.tsx's job# link, DuplicateCustomerDialog.tsx's
  // de-emphasized Cancel/Create-anyway pair, DateTimePicker.tsx's Clear, 4);
  // an Input-shaped popover trigger (DateTimePicker.tsx's date field, 1); and
  // a suggestion-prompt row with a per-index animation delay
  // (CopilotPanel.tsx, 1). components/ai-center/{BookingModal,AgentCard,
  // AiCenterModal}.tsx (5 raw buttons) and components/data/ContactCell.tsx
  // (1) were already reviewed and left raw, each with its own comment, by
  // earlier batches (PR #1096 and the "app layout, schedule board and
  // data-table controls" batch respectively) - re-verified here against this
  // exact classifier, zero new conversions or comments needed.
  // components/data/data-table.tsx and components/filters/controls/
  // CheckboxFacet.tsx were excluded from this batch's scope entirely (held by
  // an in-flight Phase 11b batch) and were not touched. Re-measured against
  // this exact classifier, cumulative across all fifteen merged button
  // batches.
  // 676 unchanged, "workflows/layout/estimates/tasks" batch: zero-conversion
  // audit of components/workflows/** (minus RecipientMultiSelect.tsx, held by
  // an in-flight Phase 11b batch), components/layout/**, components/estimates/**
  // and components/tasks/**. Every raw <button> left in this scope was already
  // a documented deferral from an earlier pass - the 839 -> 838
  // "workflow-builder-buttons" batch (components/workflows/**), the
  // 832 -> 829 "app layout, schedule board and data-table controls" batch
  // (components/layout/**), the 690 -> 685 "estimate dialogs and schedule
  // board controls" batch (components/estimates/**), and the 741 -> 736
  // "task and CRM shared field-cluster components" batch (components/tasks/**)
  // - and re-verifying each site against the current button.tsx variant/tone
  // grid confirms none has since become Button-shaped: segmented toggle/pill
  // controls (WaitForm.tsx, MergeFieldChips.tsx, trigger/DateModePanel.tsx,
  // LinkedEntitySelect.tsx's type toggle), list-row/card/radio-option/listbox
  // click targets (StepNode.tsx's selectable body, TriggerNode.tsx,
  // trigger/EventModePanel.tsx, trigger/ModeFork.tsx, trigger/SubjectPicker.tsx,
  // NewEstimateDialog.tsx, DuplicateEstimateDialog.tsx, GlobalSearch.tsx,
  // LinkedEntitySelect.tsx's result/clear rows), dropdown-menu-item rows
  // (AddStepButton.tsx, Header.tsx's OverflowItem), chip/pill patterns and
  // close-X affordances with no matching cell (TriggerForm.tsx's CrumbChip,
  // SendEstimateDialog.tsx, PhotoAttachmentStrip.tsx x2, Sidebar.tsx's remove-X
  // and Customize toggle, TaskDetailDrawer.tsx's Nudge and subtask delete,
  // TaskFilterBar.tsx x2, LinkedEntitySelect.tsx's clear pill), colour/tone
  // gaps against every minted cell (TaskCard.tsx's hover-to-business quick-
  // complete toggle, SidebarAddShortcut.tsx's outline/brand "+ Add"), an
  // asChild-nested Radix trigger pair (Sidebar.tsx's Quick Create, this
  // program's own never-convert shape) and one dnd-kit drag handle
  // (StepNode.tsx, also never-convert). Zero conversions, zero new deferral
  // comments needed. Re-measured against this exact classifier, cumulative
  // across all fourteen merged button batches (unchanged from the prior entry).
  // 676 unchanged, "dashboard/schedule/settings/tasks pages" batch: zero-
  // conversion audit across pages/dashboard/**, pages/SchedulePage.tsx,
  // pages/CustomerFormPage.tsx, pages/settings/** and pages/tasks/** (44 raw
  // buttons total, 11 of them in pages/dashboard/** already reviewed and
  // commented by the earlier "dashboard widgets and layout controls" batch -
  // see 838 -> 832 above - re-verified here with zero new comments needed).
  // The other 33, newly reviewed and commented in place: draggable task chips
  // (CalendarView.tsx x2), full-width list-row click targets (RolesPage.tsx's
  // role row, CalendarView.tsx's day-view row, CustomerFormPage.tsx's
  // franchise search-result row), segmented toggle/filter groups
  // (BrandingPage.tsx's template picker, RolesPage.tsx's scope toggle,
  // UsersTeamsPage.tsx's status filter, CalendarView.tsx's view-mode toggle,
  // SchedulePage.tsx's Standard/Member View + Day/Week/Month + time-window
  // toggles), a two-state toggle pill with no matching cell (SchedulePage.tsx's
  // Plan Mode), dropdown/context-menu item rows (SchedulePage.tsx x2, one
  // covering an adjacent Confirm/Remove pair), a custom radio option
  // (CustomerFormPage.tsx's RadioRow), an icon-only toggle inside a chip with
  // no hover treatment at all (PhoneNumbersSettingsPage.tsx), a close-X inside
  // a draggable chip (PaymentsListsPage.tsx), danger-toned text links with no
  // matching link/danger cell (UsersTeamsPage.tsx), icon-only removes with no
  // hover background at all (CustomerFormPage.tsx x2), idle-brand text CTAs
  // with no hover state at all - every link/brand cell adds a hover:underline
  // these sites never had, the same trap already deferred at
  // PaymentFeeBreakdown.tsx (CustomerFormPage.tsx x4) - and a plain-text
  // disclosure toggle matching the TestWorkflowDialog.tsx precedent
  // (CustomerFormPage.tsx's "More Details"). Two sites in SchedulePage.tsx
  // (the sidebar open/collapse-panel icon triggers) read as ghost/subtle
  // structurally but sit at rounded-md while Button's base always ships
  // rounded-button with no radius-only prop to hold it at 6px - converting
  // would need a call-site override the zero-slack layering-guard
  // hard-appearance ratchet forbids, the same AddStepButton.tsx rail-trigger
  // precedent - left raw. Three sites in CalendarView.tsx's own pager
  // (Previous/Today/Next) read as outline/neutral structurally, but
  // outline/neutral sets no idle text colour and this row's ambient wrapper
  // sets none either - the same idle-text-colour trap already deferred at
  // TaskFilterBar.tsx and CommissionsReport.tsx's FieldsMenu - left raw.
  // Re-measured against this exact classifier, cumulative across all fifteen
  // merged button batches.
  // 676 -> 664, "pages-detail-misc-features" batch: 12 of the 36 raw buttons across
  // pages/{LeadDetailPage,LoginPage,AcceptInvitePage,DashboardPage,
  // EstimateWorkspacePage,PublicEstimatePage,PublicInvoicePage}.tsx and
  // pages/workflows/WorkflowsHome.tsx now render through Button: LeadDetailPage.tsx's
  // customer-name trigger (link/brand size={null}); LoginPage.tsx's Verify + Sign In
  // (solid/brand), Resend code (link/brand size={null}) and Sign in with Google
  // (outline/neutral); AcceptInvitePage.tsx's Go to sign in (link/brand size={null}),
  // Set password & sign in (solid/brand) and Continue with Google (outline/neutral);
  // DashboardPage.tsx's Reset to default (link/brand size={null});
  // EstimateWorkspacePage.tsx's "view the current revision" (link/brand size={null});
  // and PublicEstimatePage.tsx + PublicInvoicePage.tsx's identical Back to payment
  // methods trigger (ghost/subtle size={null}). pages/design-system/** was audited and
  // skipped entirely - all three files are internal style-guide/demo pages (public,
  // query-free, "kitchen-sink"/mockup pages), not production surfaces.
  // pages/workflows/** and features/estimate-workspace/** were checked against open
  // PRs first: feat/workflow-builder and refactor/shared-component-library have no
  // open PR into staging (the former's last commit predates this batch by weeks, the
  // latter merged as #1017 long ago), so both were in scope. The other 24 raw buttons
  // across this batch stay raw, each commented in place: a compound badge+chevron
  // status-dropdown trigger and a full-width card click target (LeadDetailPage.tsx),
  // an eyebrow-style plain-text disclosure toggle matching the TestWorkflowDialog.tsx
  // precedent, and a hover-to-primary-with-no-underline contact trigger
  // (LeadDetailPage.tsx); four hover-to-primary+underline contact triggers, one with a
  // non-fading disabled state (CustomerDetailPage.tsx); an icon-only 32px back button
  // whose hover fill has no matching cell (EstimateWorkspacePage.tsx); a two-state
  // toggle with an unminted tone (DashboardPage.tsx); a segmented Owner/Director
  // toggle group (MarketingAnalyticsPage.tsx); an AI-tinted text trigger with no
  // ghost/link ai-tone cell and an underline tab-navigation control (ReportsPage.tsx);
  // a full-row card click target (WorkflowsHome.tsx); and 9 raw buttons across
  // features/estimate-workspace/components/{AiImagePanel,EstimateNameTitle,
  // EstimateTabs,ScopePresetPicker}.tsx that were already reviewed and left raw, each
  // with its own comment, by the earlier "estimate-workspace-ai-center" batch (see 832
  // unchanged above) - re-verified here against this exact classifier, zero new
  // conversions or comments needed. Re-measured against this exact classifier,
  // cumulative across all fifteen merged button batches.
  // 664 unchanged, "button-inventory-batch1" batch: zero-conversion audit of
  // components/inventory/{AddItemDialog,NewPODialog,StageDetailDialog,
  // StagingView,CategoryManagerDropdown,CategorySelector,AddGroupDialog}.tsx
  // (49 raw buttons total). Every one was already a documented deferral from
  // an earlier pass - the 829 -> 818 "inventory category/location pickers and
  // PO approval flows" batch (CategorySelector.tsx), the 818 -> 788 "inventory
  // PO and stage detail dialogs" batch (NewPODialog.tsx, StageDetailDialog.tsx),
  // the 788 -> 765 "inventory transfer, staging and asset views" batch
  // (StagingView.tsx), and the 765 -> 752 "inventory add/approval dialogs"
  // batch (AddItemDialog.tsx, CategoryManagerDropdown.tsx) - and re-verifying
  // every site against the current button.tsx variant/tone grid confirms none
  // has since become Button-shaped: asChild-nested Popover triggers
  // (CategoryManagerDropdown.tsx, CategorySelector.tsx, this program's own
  // never-convert shape); list-row/listbox-row/dropdown-row/gallery-tile click
  // targets (NewPODialog.tsx's job typeahead + item search rows,
  // StageDetailDialog.tsx's photo gallery + PDF page-picker tiles,
  // CategoryManagerDropdown.tsx's and CategorySelector.tsx's listbox rows,
  // AddGroupDialog.tsx's item search row); segmented toggle/filter-chip/card
  // controls (AddItemDialog.tsx's Catalog/Internal visibility pair,
  // NewPODialog.tsx's category filter chips, StagingView.tsx's status filter
  // tabs, AddGroupDialog.tsx's GroupTypeOption card pair); a two-state
  // open/closed trigger with its own active-state bg/border
  // (StagingView.tsx's From-PO picker); chip/badge-styled text links with no
  // matching cell (StagingView.tsx's job# chip and customer-name hover link);
  // a combobox/select-trigger styled as a form field, not a CTA
  // (NewPODialog.tsx's ItemPicker trigger); the outline/neutral
  // idle-text-colour trap with no ambient replacement (AddItemDialog.tsx's
  // Upload/Camera/Suggest-SKU/Add-vendor/Add-category, NewPODialog.tsx's and
  // StagingView.tsx's PO-row Preview, AddGroupDialog.tsx's Free-form line);
  // colour tones this primitive does not mint at all - `success`
  // (StageDetailDialog.tsx's and StagingView.tsx's Receive +1,
  // StagingView.tsx's Mark Delivered, CategoryManagerDropdown.tsx's rename
  // save-check icon - its add-row twin went with the inline add row),
  // outline/brand (StageDetailDialog.tsx's Upload file, StagingView.tsx's Open
  // Full Transaction), link/success (NewPODialog.tsx's Unlink), and ghost/brand
  // (CategoryManagerDropdown.tsx's "+ Add category" footer, which now opens the
  // vendor category manager); the tinted "soft" fill structure, published in the W1 vocabulary
  // but not yet minted (NewPODialog.tsx's Add-a-new-item footer,
  // CategorySelector.tsx's Add-category footer); a group-hover:opacity
  // reveal with no matching reveal cell, only ghost/danger#reveal exists
  // (CategoryManagerDropdown.tsx's rename icon, CategorySelector.tsx's Edit
  // icon - the latter also a hover-colour mismatch against every ghost cell);
  // a photo-tile upload trigger with a conditional idle ring/bg state
  // (AddGroupDialog.tsx's hero photo banner); a danger-toned text link with no
  // link/danger cell (AddGroupDialog.tsx's Remove photo); a font-mono SOFT
  // class the frozen SOFT ratchet has no slack to restore
  // (StageDetailDialog.tsx's inline PO-number link); a close-X whose hover
  // tone (warning) has no matching ghost cell (StageDetailDialog.tsx's alert
  // dismiss) or whose shadow+ring (HARD) has no matching cell
  // (StageDetailDialog.tsx's thumbnail remove-X); and an icon-only dialog
  // close-X sitting at rounded-md while Button's base always ships
  // rounded-button with no radius-only prop to hold it at 6px - converting
  // would need a call-site override the zero-slack layering-guard
  // hard-appearance ratchet forbids, the same SchedulePage.tsx sidebar-toggle
  // precedent (StageDetailDialog.tsx's PDF-picker dialog close-X). Zero
  // conversions, zero new deferral comments needed. Re-measured against this
  // exact classifier, cumulative across all sixteen merged button batches.
  // 664 unchanged, "button-inventory-batch3" (components/inventory/{AddLocationDialog,
  // NotificationsDropdown,LocationStockHealth,EmailComposeDialog,
  // ApprovalEmailDialog,ApprovalDetailDialog,AddBrandDialog,DeleteVendorDialog,
  // ApprovalsView,AddCategoryDialog,AddVendorDialog,CreateStageDialog,ScanDialog,
  // PrePODetailDialog,EstimateComparisonDialog,VendorCard,VendorCategoryPicker,
  // ActionLogView}.tsx, components/inventory/assets/{AssetDialog,AssetsView}.tsx,
  // components/inventory/lo/{LOList,TrackedItemSearch}.tsx,
  // components/inventory/{LowStockView,RestockDialog,ImportCSVDialog,POPreviewDialog,
  // BulkRestockDialog}.tsx and the since-deleted v1 VendorsPage.tsx, deferred from an
  // earlier wave while a Phase 11b FormField batch was in flight on the same
  // directory): zero-conversion audit of all 47 raw buttons across these 28 files.
  // Every one was already a documented deferral from an earlier pass - "inventory
  // add/approval dialogs" (#1111), "inventory PO and stage detail dialogs" (#1108),
  // "inventory transfer, staging and asset views" (#1107), "inventory category/
  // location pickers and PO approval flows" (#1106) and "inventory list pages"
  // (#1116) - and re-verifying each site against the current button.tsx variant/tone
  // grid confirms none has since become Button-shaped: segmented toggle/filter-chip/
  // multi-select-pill controls (AddLocationDialog.tsx's location-type card grid,
  // EmailComposeDialog.tsx's + ApprovalEmailDialog.tsx's
  // recipient chips, ApprovalsView.tsx's filter-tab strip, AddVendorDialog.tsx's
  // transmit-method toggle, RestockDialog.tsx's Source pills, VendorsPage.tsx's
  // status-filter group, LOList.tsx's status chips, PrePODetailDialog.tsx's tab
  // strip), close-X affordances inside a chip or panel header
  // (NotificationsDropdown.tsx, EmailComposeDialog.tsx,
  // ApprovalEmailDialog.tsx, AssetDialog.tsx, VendorCategoryPicker.tsx,
  // ActionLogView.tsx), whole-card/full-row/dropdown-row click targets
  // (LocationStockHealth.tsx's location card, ApprovalsView.tsx's approval card,
  // AssetDialog.tsx's + TrackedItemSearch.tsx's search-result row,
  // BulkRestockDialog.tsx's location accordion header, VendorCard.tsx's vendor
  // card, AssetsView.tsx's dropdown menu item, ScanDialog.tsx's action-card row,
  // VendorsPage.tsx's KPI-tile click-filter), outline+brand buttons with no
  // matching cell (outline only has neutral + danger tones) - ApprovalDetailDialog.tsx's
  // Email Team/Email (2), AddVendorDialog.tsx's Add contact, CreateStageDialog.tsx's
  // Email PO to Vendor, LowStockView.tsx's Generate PO (all), POPreviewDialog.tsx's
  // Email PO, photo-tile upload triggers with a conditional idle ring/bg state no
  // cell reproduces (AddBrandDialog.tsx, AddCategoryDialog.tsx), danger-toned text
  // links with no matching link/danger cell (AddBrandDialog.tsx's Remove,
  // AddCategoryDialog.tsx's Remove, DeleteVendorDialog.tsx's Delete permanently),
  // success/warning-toned buttons where neither tone is minted on Button
  // (LocationStockHealth.tsx's Restock pill, DeleteVendorDialog.tsx's Archive
  // vendor, EstimateComparisonDialog.tsx's Use Recommended + per-quote winner pill,
  // ImportCSVDialog.tsx's status-banner dismiss-X), an onDark context button whose
  // idle border+tint has no matching cell (ScanDialog.tsx's Phone Camera), a
  // two-step danger confirm whose idle tinted background (not just hover) the
  // transparent-until-hover outline/danger cell can't reproduce
  // (PrePODetailDialog.tsx's "Confirm dismiss?"), and a compact ~18px pill with no
  // matching size rung (CreateStageDialog.tsx's inline Preview PO pill). Real count
  // re-measured against this exact classifier: 664, unchanged. Zero conversions,
  // zero new deferral comments needed. Cumulative across all fifteen merged button
  // batches.
  // 664 -> 665, SRVW-113: SubStatusPicker.tsx's radiogroup row (role="radio", dot
  // indicator, two-line label + "Under <parent>" caption) - the exact same
  // list-row/radio-option deferral EventModePanel.tsx's own row already carries,
  // one subject over. Not a CTA any Button cell is shaped for.
  // 665 -> 664, visits-and-task-categories slice 16: CategoryManagerDropdown.tsx's
  // inline add row (and its raw save-check button) is gone - the footer's
  // "+ Add category" row now opens the shared vendor category manager.
  // 664 -> 570, visits-and-task-categories migration/CI fixer (2026-09-28): tightened to
  // the measured floor. This test's own ratchet line printed "570 / 664 (94 slack)" on
  // feat/visits-and-task-categories at b040ea9dd. The slack is not this build's work (a line
  // grep of its diff against its staging base f1a12742b nets zero raw <button>s); it is
  // conversions/deletions that landed on staging without the ceiling being lowered.
  // Zero conversions here; re-measured with countRawTagOccurrences over rawTagFiles().
  // 570 -> 575, selective promotion of this build to main (2026-09-28): main never got the
  // staging-only conversions/deletions that 570 measured, so this test's own ratchet line
  // printed "575 / 570" on the promotion branch. Set to that measured count, not a raise
  // on main's 665.
  // 575 -> 577, selective promotion of #2155 (per-org schedule event colors) to main
  // (2026-09-30): eventColorsCard.tsx adds two raw <button>s - the underlined "Reset to
  // default" link button and the colour swatch radio options (role="radio", the same
  // list-row/radio-option deferral SubStatusPicker.tsx carries). Staging already counts
  // both under its own 570; main never got staging's conversions. This test's own ratchet
  // line printed "577 / 575" on the promotion branch. Set to the measured count, not a raise.
  button: 577,
  // 252 -> 248, phase 11a "pattern-toolbar" batch: InventoryPage.tsx,
  // PurchaseOrdersPage.tsx and PriceBookPage.tsx (2 sites, Items + Groups
  // tabs) each hand-rolled a raw <input> search box; all 4 now render
  // through Toolbar's shared Input primitive. Re-measured against this
  // exact classifier post-conversion, not carried from an earlier count.
  // 248 -> 207, phase 11 "inventory-dialogs batch B": 41 of the 45 raw
  // <input>s in components/inventory/{NewPODialog,PODetailDialog,
  // PrePODetailDialog,RestockDialog,ScanDialog,
  // SetQuantityDialog,SignatureField,StageDetailDialog,StagingAreaPicker,
  // TransferDialog,VendorCategoryPicker,VendorDetailDialog}.tsx and
  // components/inventory/assets/{AssetDialog,AssetsView}.tsx now render
  // through the Input primitive (a hidden `type="file"` camera/upload
  // trigger converts cleanly - Input's box classes never paint since the
  // element stays display:none/sr-only). The remaining 4 stay raw on
  // purpose: 3 are `type="checkbox"` (SignatureField, TransferDialog,
  // AssetsView) - Input's base box styling (h-11 border-2 bg-text-primary/5
  // px-4 py-2) is shaped for a text box, not a small inline checkbox, and
  // this codebase already has a purpose-built Checkbox primitive with a
  // different API (checked/onCheckedChange) - swapping the tag is a real
  // component change, not this batch's mechanical scope. The 4th is
  // AssetDialog.tsx's VISIBLE photo-upload `<input type="file">`, styled
  // entirely via `file:*` variants with no hidden/sr-only wrapper - Input's
  // own `file:*` base classes collide with the call site's under
  // twMerge's variant-scoped conflict resolution (e.g. the call site's
  // unprefixed `text-xs` cannot cancel Input's `md:text-sm`, so text would
  // silently flip at the md breakpoint) - a real visual regression, not a
  // shape this batch converts blind. Re-measured against this exact
  // classifier post-conversion, not carried from an earlier count.
  // 207 -> 139, "adopt Input/Textarea on inventory dialogs, batch A": a
  // disjoint 17-file set, components/inventory/{ActionLogView,
  // AddBranchDialog,AddBrandDialog,AddCategoryDialog,AddGroupDialog,
  // AddItemDialog,AddLocationDialog,AddVendorDialog,ApprovalDetailDialog,
  // ApprovalEmailDialog,BulkRestockDialog,CategoryManagerDropdown,
  // CreateStageDialog,EmailComposeDialog,GeneratePODialog,ImportCSVDialog,
  // NewApprovalRequestDialog}.tsx - every text/number/date/email/url/file
  // raw <input> in these 17 files now renders through the shared Input
  // primitive (68 sites). The 7 remaining raw <input>s in this batch are
  // all type="checkbox" - Input's own styling is built for a text box, not
  // a checkbox, and the dedicated Checkbox primitive (ui/checkbox.tsx) is
  // out of scope for an Input/Textarea-only batch, so they stay raw on
  // purpose. Re-measured against this exact classifier post-conversion,
  // cumulative with batch B above (disjoint files, no double-count).
  // 139 -> 134, phase 11b/11d "formfield-timeclock-estimates-settings" batch:
  // StoreAddressSearch.tsx's combobox search field, StoreLocationPicker.tsx's
  // Store name + two CoordInput (Latitude/Longitude) fields, BrandingPage.tsx's
  // hidden logo-upload file input, and PhotoAttachmentStrip.tsx's hidden
  // camera-upload file input (both hidden file inputs convert cleanly per the
  // batch-B precedent - Input's box classes never paint since the element
  // stays display:none) now render through the Input primitive (5 sites). The
  // remaining 10 raw <input>s across this same 12-file batch stay raw and are
  // each commented in place: WaiveDepositDialog.tsx (2) and
  // RecurrenceBuilder.tsx (3) are type="radio" rows - Input's box styling is
  // built for a text field, not a small inline radio; PaymentsListsPage.tsx
  // (1 checkbox + 2 radio) is the same shape; GeofenceSettingsDialog.tsx's
  // clock-in-radius field is type="range" (a native slider, not a text box);
  // BrandingPage.tsx's brand-colour field is type="color" (a native swatch
  // button, not a text box). Re-measured against this exact classifier
  // post-conversion, not carried from an earlier count.
  // 134 -> 123, phase 11b/11d "formfield-jobs-tasks-crm" batch (14 files across
  // components/jobs/, components/tasks/, components/crm/, disjoint from the
  // "formfield-timeclock-estimates-settings" batch above): 11 raw <input>s now
  // render through the Input primitive - CreatePOFromJobDialog.tsx's qty/unit
  // cost/expected-date fields (3), JobFilesCard.tsx's + AttachmentSection.tsx's
  // + both of AttachmentsPanel.tsx's hidden type="file" triggers (4, box
  // classes never paint since the element stays hidden - same shape as the
  // inventory batches), AiCommandBar.tsx's free-text command field (1), and
  // TaskDetailDrawer.tsx's Due-date + "Add subtask" fields (2). The remaining
  // raw <input>s in this batch stay raw on purpose: 4 are type="checkbox"
  // (AssignJobDialog.tsx, CreatePOFromJobDialog.tsx x2, JobLeadTasksTab.tsx,
  // TaskDetailDrawer.tsx) - Input's own box styling is built for a text box,
  // not a checkbox; and TaskDetailDrawer.tsx's inline-editable Sheet title is
  // styled to read as an editable heading (invisible border until hover/
  // focus), not a text box - forcing it through Input's default border/
  // background would visibly box in what is meant to look like a title, a
  // real restyle rather than a structural swap. Re-measured against this
  // exact classifier post-conversion, cumulative with the batch above
  // (disjoint files, no double-count).
  input: 123,
  // 158 -> 153, phase 11b/11d "formfield-auth-and-staff" batch: LoginPage.tsx
  // (3 - MFA code, Email, Password) and AcceptInvitePage.tsx (2 - Password,
  // Confirm password) each hand-rolled a `<label className="mb-1 block ...">`
  // above a control, with the id typed twice; all 5 now render through
  // FormField, which owns the label and generates/wires the id once.
  // AcceptInvitePage's sixth `<label>` is the Terms consent row, which WRAPS
  // its checkbox rather than sitting above it - a shape FormField does not
  // render and is deliberately not being given a prop for, so it stays raw
  // and the floor is 153, not 152. Re-measured against this exact classifier
  // post-conversion, not carried from an earlier count.
  // 153 -> 150, "inventory-formfield-labels" batch (triage of the 23
  // components/inventory/ dialogs): the PO email dialog's Subject + Message
  // labels (dialog since deleted) and SignatureField.tsx's typed-name label each hand-rolled the
  // same `<label className="mb-1 block ...">` above a sibling input/textarea
  // with no htmlFor/id, so all 3 now render through FormField. The other 51
  // raw <label>s found across that same 23-file sweep WRAP their control
  // (checkbox/radio rows, file-drop zones, or a local `Field({ label,
  // children })`-shaped helper, inline or shared) or are compound controls
  // outside this batch's fit criteria (the PO email dialog's ChipInput,
  // StagingAreaPicker's input+button row) and were deliberately left raw -
  // see the inline comments at those two sites. Re-measured against this
  // exact classifier post-conversion, not carried from an earlier count.
  // 150 -> 149, phase 11b/11d "formfield-timeclock-estimates-settings" batch:
  // StoreLocationPicker.tsx's "Service address" label sat above a single
  // sibling control (StoreAddressSearch, which forwards its own `id` prop to
  // an internal raw <input>) with htmlFor/id already hand-wired - it now
  // renders through FormField (cloneElement onto StoreAddressSearch). The
  // other 19 raw <label>s across this same 12-file batch stay raw and are
  // each commented in place: checkbox/radio/toggle rows that WRAP their
  // control (WaiveDepositDialog.tsx x2, PaymentsListsPage.tsx x3,
  // PhoneNumbersSettingsPage.tsx x1, UsersTeamsPage.tsx x2,
  // RecurrenceBuilder.tsx x3, StoreLocationPicker.tsx's own other 2 sites,
  // GeofenceSettingsDialog.tsx x1 wrapping a type="range" slider); a label
  // beside (not above) a Checkbox in a payment-method row
  // (MarkSentDialog.tsx, SendEstimateDialog.tsx); a label above a compound
  // Input+Select control, a label above a button group, and a label above a
  // radio group (RecurrenceBuilder.tsx x3 - compound controls outside this
  // pass's fit criteria, see FormField.tsx's own header comment); and a
  // label wrapping a SelectField (UsersTeamsPage.tsx - both a wrapping shape
  // and a <select>-family control, out of scope). Re-measured against this
  // exact classifier post-conversion, not carried from an earlier count.
  // 149 -> 144, phase 11b/11d "formfield-jobs-tasks-crm" batch (disjoint from
  // the "formfield-timeclock-estimates-settings" batch above): ScopeOfWorkCard
  // .tsx's Title + Description labels and TotalsFooter.tsx's Sales tax
  // jurisdiction label each hand-rolled a `<label>` above a sibling control
  // with no htmlFor/id, so all 3 now render through FormField -
  // TotalsFooter.tsx's label wraps a compound Select (a Radix root with no DOM
  // of its own), so it uses FormField's render-prop child, the id landing on
  // the SelectTrigger, same shape as StaffFormDialog's Role/Department fields.
  // CreateTaskModal.tsx's Title + Description labels convert the same way (2
  // more). The other 10 raw <label>s in this batch WRAP their control
  // (checkbox rows in AssignJobDialog.tsx, JobLeadTasksTab.tsx,
  // TaskFilterBar.tsx x2, AssignTeamPopover.tsx x2, LineItemsEditor.tsx) or
  // wrap a compound picker with no id prop of its own to receive fieldProps
  // (CreateTaskModal.tsx's Owner/Watchers/Due Date/Priority/Linked To, backed
  // by AssigneeSelect/MultiAssigneeSelect/DateTimePicker/SelectField/
  // LinkedEntitySelect) or wrap a hidden file-upload dropzone
  // (JobFilesCard.tsx) - all deliberately left raw, each commented in place.
  // Re-measured against this exact classifier post-conversion, cumulative
  // with the batch above (disjoint files, no double-count).
  // 144 -> 141, "formfield-misc-components-pages" batch (11 files: components/
  // data/data-table.tsx, components/filters/controls/CheckboxFacet.tsx,
  // components/invoices/RecordPaymentDialog.tsx, components/settings/
  // LogoUpload.tsx, components/workflows/RecipientMultiSelect.tsx, pages/
  // CustomersPage.tsx, pages/JobDetailPage.tsx, pages/inventory/InventoryPage
  // .tsx, pages/reports/{CallsReport,CampaignRoiReport}.tsx, pages/
  // service-plans/ServicePlansPage.tsx
  // -- TWO OF THOSE ELEVEN NO LONGER EXIST. `pages/JobDetailPage.tsx` and
  // `pages/inventory/InventoryPage.tsx` were both dead v1 pages: `App.tsx`
  // routes only what `v2Routes()` returns, so neither had been reachable
  // since the v2 cutover, and each was deleted once its routed replacement
  // reached parity. The "144 -> 141" figure is NOT restated - it was a
  // correct measurement when taken, and the conversions it counts really
  // happened. Only the file list is annotated, so a reader who greps for
  // either path learns why it is missing instead of concluding the record
  // is wrong. Same treatment switch.stories.tsx gives its own removed call
  // site. Today's scan simply never visits them, and every ratchet here is
  // `toBeLessThanOrEqual`, so a deletion can only ever create slack.
  // ): ServicePlansPage.tsx's Plan name +
  // Start date labels each hand-rolled a `<label>` above a sibling Input with
  // no htmlFor/id, so both now render through FormField; its Sold by label
  // converts the same way via FormField's render-prop child (Select is a
  // Radix root with no DOM of its own, so the id lands on the SelectTrigger,
  // same shape as TotalsFooter.tsx's precedent above) - 3 sites. The other 5
  // raw <label>s in ServicePlansPage.tsx's plan-builder dialog stay raw, each
  // commented in place: Customer and Recurrence wrap a compound picker
  // (CustomerPickerWithCreate, RecurrenceBuilder) with no id prop of its own
  // to receive fieldProps; Service location's PickOrAccreteLocation already
  // renders its own label through FormField internally and likewise has no
  // outer id prop to target (the resulting double label predates this batch
  // and is out of scope to fix here); Line items and Default materials each
  // head a repeating add/remove list of per-row inputs, not a single control
  // with one id. RecordPaymentDialog.tsx's Amount/Date/Reference number/Notes
  // fields hand-rolled the shared `<Label>` component (not the raw HTML tag)
  // next to Input/Textarea with no htmlFor/id on 3 of the 4 - all now render
  // through FormField too, but since `<Label>` was never a raw `<label>` tag
  // this ratchet does not see them; its Payment method field stays on the
  // shared `<Label>` for the same closed-prop-list SelectField reason as
  // RecordEstimatePaymentDialog's identical field. The other 10 files in this
  // batch have zero real Label+control pairings once wrap-shaped sites and
  // sites with a placeholder standing in for a label are excluded: every
  // remaining raw <label> in
  // data-table.tsx, CheckboxFacet.tsx, RecipientMultiSelect.tsx (x2),
  // CustomersPage.tsx, InventoryPage.tsx and CallsReport.tsx WRAPS a
  // checkbox/switch row rather than sitting above/beside its control;
  // LogoUpload.tsx's and JobDetailPage.tsx's labels are hidden-file-input
  // BUTTON triggers, not description text for a field; CampaignRoiReport
  // .tsx's Closing rate label sits to the LEFT of its control inline with a
  // heading row, a layout FormField cannot express (Stack's default and only
  // direction is vertical, no direction prop exists on FormField) without a
  // real visual change. Re-measured against this exact classifier
  // post-conversion, not carried from an earlier count.
  // 141 -> 133, phase 11b/11d "formfield-inventory-dialogs-a-i" batch (11
  // components/inventory/ dialogs, alphabetically AddBranchDialog through
  // ImportCSVDialog). AddBranchDialog.tsx, AddBrandDialog.tsx,
  // AddCategoryDialog.tsx, AddGroupDialog.tsx, AddLocationDialog.tsx,
  // ApprovalEmailDialog.tsx, CreateStageDialog.tsx and EmailComposeDialog.tsx
  // each hand-rolled a page-local `Field({ label, children })` helper - one
  // `<label>` JSX literal wrapping a caption span, invoked at every field in
  // that file. The ratchet counts source-text literals, not rendered
  // instances, so all of that file's Field-wrapped sites converting to
  // FormField and the now-dead helper being deleted removes exactly ONE
  // `<label>` occurrence per file (8 files, -8), independent of how many
  // fields it had. AddItemDialog.tsx and AddVendorDialog.tsx keep their Field
  // helper alive (net zero each) because at least one site per file has no
  // FormField-expressible shape: AddItemDialog's Visibility toggle is a
  // button pair, not an input/select; AddVendorDialog's Category field is
  // VendorCategoryPicker (outside this batch's files), which accepts no id
  // prop and renders two structurally different controls (a free-text Input
  // in "new" mode, a Select otherwise) - its PO Transmit Method field (a
  // button-chip multi-select) stays on the same helper for the same button-
  // pair reason as AddItemDialog's Visibility. ImportCSVDialog.tsx never had a Field
  // helper and converts nothing - its two `<label>`s are a file-drop zone and
  // a checkbox-leads-its-own-label row. Every other raw `<label>` left across
  // the batch is the same handful of shapes FormField's own header comment
  // names as out of scope: checkbox/radio rows, file-drop zones, a label
  // sitting inline BESIDE its control instead of above it ("Auto-fill from
  // PO" in CreateStageDialog.tsx), and a compound picker with no id prop of
  // its own (VendorCategoryPicker) - each commented in place at its site.
  // <input>/<textarea> unaffected: every control paired with a Field/label in
  // this batch already rendered through the Input/Textarea primitives, so no
  // raw-tag conversion happened on either axis. Re-measured against this
  // exact classifier post-conversion, cumulative with the batches above
  // (disjoint files, no double-count).
  // 133 -> 124, "formfield-inventory-dialogs-n-v" batch (9 files,
  // components/inventory/{NewApprovalRequestDialog,NewPODialog,RestockDialog,
  // ScanDialog,SetQuantityDialog,TransferDialog,VendorDetailDialog}.tsx and
  // components/inventory/assets/{AssetDialog,AssetsView}.tsx): the prior
  // "inventory-formfield-labels" batch above (153 -> 150) deliberately left
  // every WRAPPING label in this 23-file family raw, "outside this batch's
  // fit criteria" - this batch is the specific, granular follow-up that
  // triages those wrapping sites in these 9 files rather than leaving the
  // whole shape unconverted. 9 raw <label>s now render through FormField:
  // NewApprovalRequestDialog.tsx's Quantity + Reason (2, plain Input/
  // Textarea), ScanDialog.tsx's Manual/Bluetooth Wedge Entry (1), NewPODialog
  // .tsx's Expected Delivery + Job # + Customer + Site/Notes (4, the local
  // `Field({label,children})` helper stays defined for its two remaining
  // SelectField call sites, Vendor + Trade), TransferDialog.tsx's
  // SearchablePicker (a shared component whose two-branch chip-or-search-
  // input body converts via FormField's render-prop child, the id landing on
  // the Input in the search branch only) and its single-mode Quantity+Max-
  // button row (render-prop, id on the Input, the Max button left outside
  // FormField's slot system) (2), and VendorDetailDialog.tsx's LabeledInput
  // helper (used 5x: Person/Email/Phone/Website/Account #, all single-Input
  // pairs, so the helper's own `<label>` retires entirely) + its Lead (days)
  // + Vendor Name fields (3) - 6 total in that file, collapsing its label
  // count from 5 to 2. AssetDialog.tsx's local `Field` helper had ALL 5 of
  // its call sites convert (Name, Serial - Input; Catalog item - two-branch
  // chip-or-search render-prop, same shape as SearchablePicker; Notes -
  // Textarea; Photo - render-prop, id onto the raw `<input type="file">`,
  // left raw per the existing `input` ceiling note rather than rewritten to
  // Input), so the helper itself is deleted, not just its call sites - the
  // only full net-zero-usages retirement in this batch. Duplicate-serial and
  // no-catalog-match hint/warning paragraphs that don't map to FormField's
  // fixed-tone hint/error slots (tone mismatch - warning vs FormField's
  // danger/secondary) stay as plain siblings after the closing FormField tag
  // instead, preserving their own copy, colour and margin untouched. The
  // remaining 19 raw <label>s across this same 9-file batch stay raw and are
  // each commented in place: SelectField-paired labels (11 sites across
  // NewApprovalRequestDialog x3, NewPODialog x1, RestockDialog x3,
  // SetQuantityDialog x2, TransferDialog x4 via Item/Reason/LocationPicker/
  // BulkJobSection, VendorDetailDialog x1) - SelectField's own API has no
  // `id` and does not spread the rest of its props onto the trigger, so
  // FormField's generated id would reach no element, the same structural
  // block LeadFormPage's TimeSelect deferral already established; a
  // segmented toggle-chip row (RestockDialog.tsx's Source, a radio/toggle-
  // row shape FormField's own header comment excludes); checkbox rows that
  // WRAP a second real control on the same horizontal line, not a vertical
  // label-above-control column (TransferDialog.tsx's BulkLines per-line
  // toggle+qty row, AssetsView.tsx's Show retired); a label shared by two
  // real controls at once, a search Input plus a SelectField picker
  // (TransferDialog.tsx's BulkPOSection - blocked on both the compound shape
  // and SelectField); and VendorDetailDialog.tsx's Category field, wrapping
  // VendorCategoryPicker (a different, out-of-batch file) whose two internal
  // modes neither accept nor forward an `id`. Re-measured against this exact
  // classifier post-conversion, cumulative with the batches above (disjoint
  // files, no double-count).
  // 124 unchanged, "formfield-textarea-remainder" batch (2026-07-31): reviewed every raw
  // <label> across a disjoint 26-file remainder set (service-plans/RecurrenceBuilder.tsx,
  // tasks/CreateTaskModal.tsx, service-plans/ServicePlansPage.tsx, settings/
  // PaymentsListsPage.tsx, settings/UsersTeamsPage.tsx, reports/JobStatisticsReport.tsx,
  // tasks/TaskFilterBar.tsx, estimates/WaiveDepositDialog.tsx, crm/AssignTeamPopover.tsx,
  // workflows/RecipientMultiSelect.tsx, timeclock/StoreLocationPicker.tsx, filters/controls/
  // CheckboxFacet.tsx, payments/StripeOnboardingDrawer.tsx, tasks/JobLeadTasksTab.tsx,
  // estimates/SendEstimateDialog.tsx, estimates/MarkSentDialog.tsx, crm/LineItemsEditor.tsx,
  // timeclock/GeofenceSettingsDialog.tsx, jobs/AssignJobDialog.tsx, pages/CustomerFormPage.tsx,
  // pages/AcceptInvitePage.tsx, pages/PublicEstimatePage.tsx, pages/CustomersPage.tsx,
  // estimate-workspace/components/NotesCard.tsx, copilot/Composer.tsx,
  // pages/CustomerDetailPage.tsx). Zero converted - every raw <label> in this set is
  // non-FormField-shaped: a checkbox/radio/switch row wrapping its control on one line, an
  // inline caption sitting beside (not above) a SelectField with no id to forward, or a
  // wrapping label (span+input inside <label>) around a compound picker. Most were already
  // documented by earlier batches; 11 sites had the reasoning genuinely missing and got a
  // terse in-place comment added (no markup change): JobStatisticsReport.tsx's 3 "Job type:"
  // filter labels (SelectField-no-id + inline-beside-control), RecipientMultiSelect.tsx's 2
  // checkbox rows, CheckboxFacet.tsx's 1 checkbox row, StripeOnboardingDrawer.tsx's 1
  // terms-attestation checkbox row, CustomerFormPage.tsx's 1 "This is a franchise" checkbox
  // row, AcceptInvitePage.tsx's 1 terms-agreement checkbox row, PublicEstimatePage.tsx's 1
  // terms-agreement checkbox row, and CustomersPage.tsx's 1 "Show archived" checkbox row
  // (pre-existing comment there explained the control's provenance, not its non-conversion -
  // augmented in place). Re-measured against this exact classifier post-review; count is
  // unchanged because nothing here was ever FormField-shaped to begin with.
  label: 124,
  // 39 -> 32, phase 11 "inventory-dialogs batch B": every <textarea> in
  // components/inventory/{RestockDialog,StageDetailDialog,
  // VendorDetailDialog}.tsx and components/inventory/assets/
  // {AssetActionDialog,AssetDialog}.tsx now renders through the Textarea
  // primitive. No shape carve-outs - all 7 were plain multiline note/message
  // fields, none needed the size sub-scale or a new prop. Re-measured against
  // this exact classifier post-conversion, not carried from an earlier count.
  // 32 -> 21, "adopt Input/Textarea on inventory dialogs, batch A": every
  // raw <textarea> in the disjoint 17-file batch-A set above (11 sites -
  // notes/description/reason/message fields) now renders through the shared
  // Textarea primitive. Zero deferred - no textarea in this batch carried a
  // shape (like type="checkbox" on <input>) that made the primitive a bad
  // fit. Re-measured against this exact classifier post-conversion,
  // cumulative with batch B above (disjoint files, no double-count).
  // 21 -> 16, phase 11b/11d "formfield-jobs-tasks-crm" batch: all 5 raw
  // <textarea>s across the 14-file set (CreateTaskModal.tsx's Description,
  // TaskDetailDrawer.tsx's task-description + add-comment fields, and
  // LineItemsEditor.tsx's per-line "Description for customer" field, mounted
  // twice - once in the desktop grid row, once in the mobile stacked card)
  // now render through the shared Textarea primitive. Zero deferred - every
  // one was a plain multiline note/description field. Re-measured against
  // this exact classifier post-conversion, not carried from an earlier count.
  // 16 -> 14, "formfield-textarea-remainder" batch (2026-07-31): of the 3 raw
  // <textarea>s in this batch's 26-file set (see the `label` entry above for
  // the full file list), 2 now render through the shared Textarea primitive -
  // estimate-workspace/components/NotesCard.tsx's note-composer field
  // (size="sm", its min-h-[60px]+text-sm signature is the same "smaller"
  // shape already covered by Textarea's sm rung) and pages/
  // CustomerDetailPage.tsx's customer-note field (default md size,
  // className="resize-none" only - w-full/px/py/border/bg/text/focus were
  // all appearance the primitive already owns). 1 deferred with an in-place
  // comment: copilot/Composer.tsx's chat input renders on the AI copilot's
  // dark glass bar (bg-on-fill/border-on-fill/text-on-fill/ai-500 focus
  // ring) - Textarea's own default is a light surface, and restoring the
  // on-dark theme via className is a wall of hard classes the layering-guard
  // has no slack for (27/29 hard at batch start - see the two mic/send
  // buttons in the same file, deferred for the identical reason). Re-measured
  // against this exact classifier post-conversion, not carried from an
  // earlier count.
  textarea: 14,
  select: 4,
  // 215 -> 185, "settings panel card-section titles" batch (first heading batch):
  // all 30 raw headings across pages/settings/ now render through Heading -
  // MyProfilePage.tsx (2), EmailSettingsPage.tsx (2, one h2 scale="lg"),
  // SecurityPage.tsx (3), PaymentsListsPage.tsx (3), LocationsPage.tsx (2),
  // SettingsLayout.tsx (1 h1, scale="lg"), InventorySettingsPage.tsx (1),
  // PhoneSmsPage.tsx (2), RolesPage.tsx (2, one h3 scale="base", one h4),
  // BrandingPage.tsx (5, one keeps a residual mb-3 layout class),
  // CompanyProfilePage.tsx (6, one keeps a residual mb-1 layout class),
  // UsersTeamsPage.tsx (1 h4). Zero deferred - every site matched an existing
  // scale/weight/tone combination exactly. Re-measured against this exact
  // classifier post-conversion, not carried from an earlier count.
  // 185 -> 174, "workflow builder and AI center panel titles" batch (first
  // heading batch): 11 raw headings now render through Heading -
  // components/ai-center/AgentDetailModal.tsx's agent-name <h2>,
  // BookingModal.tsx's two step-title <h2>s, AiCenterModal.tsx's modal-title
  // <h2> (leading-tight dropped, no matching prop) and category <h3> (flex
  // items-center gap-2 kept as a layout-only residual className),
  // pages/workflows/WorkflowsHome.tsx's hero <h1> plus three <h2>s and one
  // <h3> (tracking-tight dropped at all five; the <h3> also had no explicit
  // font size class at all, inferred to scale="base" from its inherited
  // ~16px render), and components/workflows/WorkflowSettings.tsx's "Danger
  // zone" <h3>. 5 sites deferred, each commented in place: ai-center/
  // ImplementationPromo.tsx's promo <h3> (font-extrabold has no matching
  // Heading weight, text-on-fill has no matching tone) and the four
  // trigger-builder panel titles sharing one signature (components/workflows/
  // trigger/{ModeFork,EventModePanel,SubjectPicker,DateModePanel}.tsx -
  // text-[15px] has no matching scale key AND font-extrabold has no matching
  // weight, both documented deferrals at once). Re-measured against this
  // exact classifier post-conversion, not carried from an earlier count.
  // 174 -> 156, "inventory page and dialog titles" batch: 18 raw headings across
  // components/inventory/{LowStockView,ApprovalsView,StagingView,ActionLogView,
  // StageDetailDialog,PrePODetailDialog,lo/LOList,assets/AssetHistoryDrawer}.tsx
  // and pages/inventory/{PurchaseOrdersPage,InventoryPage,VendorsPage,
  // PriceBookPage}.tsx now render through the Heading primitive - the repeated
  // <h1 className="text-xl font-semibold tracking-tight ...">  page-shell title
  // signature (7 sites, tracking-tight dropped - no letter-spacing axis on
  // Heading, disclosed inline at each site) plus assorted <h2>/<h3> card and
  // drawer titles that map cleanly onto scale/weight/tone (one more,
  // leading-tight, dropped the same documented way at AssetHistoryDrawer.tsx
  // and InventoryPage.tsx's item-detail h2s). StageDetailDialog.tsx's
  // `DialogTitle asChild` h3 converts too - Heading forwards ref and spreads
  // props, so it composes through Radix's Slot the same as a plain tag. The 10
  // remaining raw headings in the same two directories are deferred, each
  // commented in place: 8 bracket font sizes (text-[10px]/text-[11px], no
  // matching scale key - ImportCSVDialog.tsx x2, StagingView.tsx,
  // FiltersPopover.tsx, AssetHistoryDrawer.tsx, InventoryPage.tsx x3) and 2
  // eyebrow-style uppercase/tracking-wide labels with no matching Heading
  // variant (LocationStockHealth.tsx, CreateStageDialog.tsx). Re-measured
  // against this exact classifier post-conversion, cumulative on top of the
  // settings-panel and workflows/ai-center batches above.
  // 156 -> 139, "headings-pages-root-m-z" batch: 17 raw headings across the
  // 9-file M-Z half of frontend/src/pages/*.tsx loose files (NotAuthorizedPage,
  // MarketingAnalyticsPage's <h1>, PublicEstimatePage x5, PublicInvoicePage x5,
  // ReportsPage, StandaloneInvoiceFormPage, StatementPage, UpgradePage,
  // UsersPage) now render through the Heading primitive. Every converted site
  // was a plain scale/weight/tone match against the raw's existing look, level
  // preserved unchanged; PublicInvoicePage.tsx's INVOICE <h1> drops
  // `tracking-tight` (no letter-spacing prop on Heading, disclosed inline) -
  // the only non-exact delta in the batch. 3 deferred, all in
  // MarketingAnalyticsPage.tsx: the three section-header <h3>s
  // (Channel performance / Product / service profitability / Organic &
  // reputation) carry `text-[15px]`, a bracket font size with no matching
  // Heading scale key - each commented in place. Re-measured against this
  // exact classifier post-conversion, cumulative on top of the settings-panel,
  // workflows/ai-center and inventory batches above.
  // 139 -> 98, "reports section-title headings" batch: 41 of the 42 raw
  // heading tags (h2 and h3, plus one h1) section and subsection titles
  // across the 20-file frontend/src/pages/reports/ directory
  // (ActivityReport.tsx x7, ArAgingReport.tsx x2, CampaignRoiReport.tsx x2,
  // EstimateConversionReport.tsx x3, EstimatesReport.tsx, GenericReport.tsx,
  // InvoicesReport.tsx, ItemsServicesReport.tsx x2, JobStatisticsReport.tsx
  // x3, JobsReport.tsx, LeadsReport.tsx, MetricDetailPanel.tsx,
  // PaymentsReport.tsx x2, PersonMetricPanel.tsx, ReportShell.tsx,
  // ReportStubPage.tsx, TechPerformanceBoard.tsx, TimesheetsReport.tsx x3,
  // comm-tracking/CadenceTab.tsx x2, comm-tracking/QaTab.tsx x2,
  // comm-tracking/TrainingImpactTab.tsx x3) now render through Heading.
  // Almost every h2 and h3 site was already exactly text-sm (or text-xs)
  // plus font-semibold and text-text-primary, matching Heading's own
  // measured level defaults (DEFAULT_SCALE for levels 2 and 3 both resolve
  // to "sm"), so most sites needed only `level` with no other prop;
  // ActivityReport.tsx's "When active" is the sole text-xs h3, taking an
  // explicit scale="xs". ReportShell.tsx's lone h1 (text-2xl) took
  // scale="2xl" against level 1's "xl" default; ReportStubPage.tsx's h1
  // (text-xl) matched the zero-prop default exactly. Existing layout classes
  // (margin, text-center, the icon-plus-label flex row on
  // CampaignRoiReport.tsx's "Pipeline forecast") were preserved verbatim in
  // a residual className; no typography or colour class survived in any
  // className. 1 site deferred and left raw: ItemsServicesReport.tsx's
  // per-technician breakdown label (text-xs, font-semibold, uppercase,
  // tracking-wide and text-text-secondary together) is the eyebrow style
  // Heading's own header comment records as not yet supported. Re-measured
  // against this exact classifier, cumulative on top of the settings-panel,
  // workflows/ai-center, inventory and pages-root-m-z batches above.
  // 98 -> 84, "adopt Heading on top-level page titles and section headers,
  // batch A" (frontend/src/pages/*.tsx, A-L by filename, 14 files): 14 of the
  // 34 raw headings in this file set now render through the Heading primitive
  // - AcceptInvitePage.tsx (1, the "Welcome" h2), CustomerDetailPage.tsx (1 of
  // 3, the customer-name h1), CustomerFormPage.tsx (1 of 3, the "Edit/New
  // Customer" h1, a byte-identical default match), CustomersPage.tsx,
  // DashboardPage.tsx, EstimatesPage.tsx, JobDetailPage.tsx, JobFormPage.tsx,
  // JobsPage.tsx, LeadsPage.tsx (1 each, all page-title h1s), LeadDetailPage.tsx
  // (1 of 16, the lead-number/customer h1), LeadFormPage.tsx (2, "New Lead" +
  // "Edit Lead", both default matches) and LoginPage.tsx (1, the "Sign In" /
  // MFA h2). The remaining 20 raw headings across this same 14-file batch stay
  // raw and are each commented in place: 17 eyebrow-style section labels
  // (uppercase + tracking-wide, no matching Heading variant -
  // CustomerDetailPage.tsx x2, CustomerFormPage.tsx x2,
  // EstimateWorkspacePage.tsx x1, LeadDetailPage.tsx x12) and 3 bracket font
  // sizes on LeadDetailPage.tsx (text-[10px], no matching scale key). One
  // disclosed dropped delta: JobDetailPage.tsx's entity-hero h1 also carried
  // `leading-tight`, which Heading has no line-height axis to express - every
  // child inside it sets its own explicit font-weight and colour already, so
  // the rendered text is otherwise unchanged. Re-measured against this exact
  // classifier, cumulative on top of the settings-panel, workflows/ai-center,
  // inventory, pages-root-m-z and reports batches above.
  // 84 -> 67, "adopt Heading on remaining small-directory titles" batch (first
  // heading batch): 17 of the 21 raw headings across the ~23-site small-directory
  // census now render through Heading - components/estimates/EstimateDocumentView.tsx
  // (the E-number h1), components/jobs/AiJobAssistantBar.tsx, components/settings/
  // {StaffSection,OrgTaxRatesSection}.tsx, components/timeclock/
  // {EmployeePayrollCard,MyTimeLog}.tsx, features/estimate-workspace/components/
  // SignatureCard.tsx, pages/dashboard/widgets/_shared.tsx, pages/
  // dashboard/layout/CatalogDrawer.tsx, pages/tasks/{TasksHubPage,views/MyDayView}
  // .tsx, components/ErrorBoundary.tsx, components/charts/ChartCard.tsx,
  // components/crm/IconRail.tsx, components/invoices/InvoiceLineItemsEditor.tsx and
  // components/notifications/NotificationPanel.tsx (the sr-only/visible dual-mode
  // h2 - both branches now share one Heading, `className={hideHeaderTitle ?
  // 'sr-only' : undefined}`, since sr-only doesn't compete with the retained
  // type-size classes) and components/payments/StripePaymentsStatusCard.tsx. The
  // other 4 raw headings stay raw, each commented in place: two eyebrow-style
  // labels with no matching Heading variant (EstimateDocumentView.tsx's "Scope of
  // Work" h3, NotesCard.tsx's "Notes" h4 - both uppercase+tracking-wide small-caps),
  // components/jobs/overview/SectionCard.tsx's h3 (a single-site odd tone,
  // text-ai-600, with no clean Heading tone match, plus a caller-forwarded
  // titleClassName override), and components/layout/Header.tsx's page-title h1
  // (a responsive breakpoint font size, text-lg escalating to sm:text-xl - no
  // scale key expresses two sizes across breakpoints, and restoring the sm:
  // escalation via className would be a dropped-typography-class restore, the
  // same layering-guard blind spot the button phase hit repeatedly). Re-measured
  // against this exact classifier, cumulative on top of the settings-panel,
  // workflows/ai-center, inventory, pages-root-m-z, reports and pages-root-a-l
  // batches above.
  // 67 -> 58, closing the nine-count slack the guard had been reporting for
  // several runs. Nothing was converted to earn this: the tree already measured
  // 58 and the ceiling was simply higher than the count. It is lowered now
  // because the kit finally has somewhere for a heading to go - ui-kit's
  // components/ui/heading.tsx (level 1-6, scale independent of level) landed
  // with the statCard/CardTitle parity work, and CardTitle renders a real h3
  // through it. Before that a page below page-header level had no legal way to
  // author a heading and hand-rolled role="heading" instead, so holding slack
  // open was the humane choice. It no longer is.
  heading: 58,
  a: 44,
  // 57 -> 56. The invoice credit and refund dialogs each hand-rolled the same
  // give-back ledger table; they now share one (invoices/GiveBackLedger.tsx),
  // so the tree is one raw <table> lighter and the ceiling follows it down.
  table: 56,
  img: 38,
};

/**
 * Count of raw `<tag` open-tag occurrences (bare-close, self-closing or
 * multi-line) in `rawCode`, comments stripped first so a tag mentioned only
 * in prose (the InvoiceReceiptCard.tsx shape `stripComments` above already
 * guards) is not a real call site.
 */
export function countRawTagOccurrences(rawCode: string, tag: string): number {
  const re = RAW_TAG_PATTERNS[tag];
  if (!re) throw new Error(`countRawTagOccurrences: unknown tag "${tag}"`);
  return stripComments(rawCode).match(re)?.length ?? 0;
}

function countRawTagOccurrencesInFiles(tag: string, files: string[]): number {
  let total = 0;
  for (const file of files) total += countRawTagOccurrences(readFileSync(file, 'utf8'), tag);
  return total;
}

/**
 * The raw-tag ratchet's file set: `targetFiles()` minus `src/ui-kit`.
 *
 * This ratchet counts the APP's remaining conversion debt - "how many raw
 * <button>s are left to turn into <Button>". `components/ui` is already
 * excluded above for the reason that a raw <button> inside Button IS the
 * primitive, not a call site to convert. `src/ui-kit` is the vendored CRM UI
 * kit: a second, self-contained primitive family shipping its own Button,
 * Input, Table and Textarea, so exactly the same reasoning applies to its
 * internals. Its 12 raw tags are primitive implementations, and no phase-11
 * conversion step targets them.
 *
 * NOTE this is scoped to THIS ratchet only, deliberately. The appearance
 * ratchets above (CEILINGS / DIR_CEILINGS) still measure `src/ui-kit` in full
 * via the unmodified `targetFiles()`, and it sits at their floor with zero
 * slack. The ceilings below are NOT raised - they are staging's numbers,
 * measured before the kit existed, and they stay exactly as committed.
 */
function rawTagFiles(root = SRC): string[] {
  return targetFiles(root).filter((f) => relative(root, f).split(sep)[0] !== 'ui-kit');
}

describe('raw-tag ratchet (raw HTML tag occurrences outside components/ui, may only decrease)', () => {
  const files = rawTagFiles();

  for (const [tag, ceiling] of Object.entries(RAW_TAG_CEILINGS)) {
    const label = tag === 'heading' ? 'h1-h6' : tag;
    it(`raw <${label}> occurrences stay at or below ${ceiling}`, () => {
      const count = countRawTagOccurrencesInFiles(tag, files);
      const slack = ceiling - count;
      process.stdout.write(
        `  ratchet  <${label.padEnd(8)}> ${String(count).padStart(4)} / ${String(ceiling).padEnd(4)}` +
          (slack > 0 ? ` (${slack} slack - lower the ceiling)` : ' (at floor)') +
          '\n',
      );
      expect(count).toBeLessThanOrEqual(ceiling);
    });
  }
});

// --- asserted examples for the raw-tag ratchet (lock the detector, prove red) ----
//
// One fixture per tag, each containing exactly 2 occurrences (button's
// fixture is 3, see below): a single-line form AND the multi-line form that
// the naive `[ >]` boundary bug missed. Both purposes the CEILINGS asserted
// examples serve above are covered per tag, not just once for `button`:
// (1) the count is asserted exactly, locking the detector; (2) a fixture
// count above a deliberately-lowered ceiling is proven, by executing the
// real vitest assertion and catching it throw, to actually fail - "goes
// red" is demonstrated, not just claimed.
const RAW_TAG_FIXTURES: Record<string, { code: string; expected: number }> = {
  button: {
    code: '<button onClick={fn}>Go</button><button\n  disabled\n>\n  Save\n</button><ButtonGroup />',
    expected: 2,
  },
  input: { code: '<input value="x" /><input\n  type="text"\n/>', expected: 2 },
  label: { code: '<label htmlFor="x">X</label><label\n>Y</label>', expected: 2 },
  textarea: { code: '<textarea value="x" /><textarea\n  rows={3}\n>text</textarea>', expected: 2 },
  select: { code: '<select><option /></select><select\n  value={v}\n/>', expected: 2 },
  heading: { code: '<h1>a</h1><h2\n  className="x"\n>b</h2><h6>c</h6><header>not a heading</header>', expected: 3 },
  a: { code: '<a href="/x">t</a><a\n  href="/y"\n>u</a>', expected: 2 },
  table: { code: '<table><tbody /></table><table\n  className="w-full"\n>x</table>', expected: 2 },
  img: { code: '<img src="/x.png" /><img\n  alt="y"\n/>', expected: 2 },
};

describe('raw-tag ratchet detector (asserted examples, one fixture per tag)', () => {
  for (const [tag, { code, expected }] of Object.entries(RAW_TAG_FIXTURES)) {
    it(`${tag}: counts a single-line AND a multi-line open tag, the 8x button-undercount shape`, () => {
      expect(countRawTagOccurrences(code, tag)).toBe(expected);
    });

    it(`${tag}: a real fixture count exceeding a lowered ceiling fails the ratchet assertion (proven red)`, () => {
      const tooLow = expected - 1;
      expect(() => {
        expect(countRawTagOccurrences(code, tag)).toBeLessThanOrEqual(tooLow);
      }).toThrow();
    });
  }

  it('matches every documented boundary character: space, tab, newline, self-close slash, bare close', () => {
    const code = '<a href="/x">t</a><a/><a\n>x</a><a\thref="/y">y</a><a >z</a>';
    expect(countRawTagOccurrences(code, 'a')).toBe(5);
  });

  it('does not match a component whose name merely starts with the tag - case-sensitive, exact-tag boundary', () => {
    expect(countRawTagOccurrences('<ButtonGroup><buttonWrapper /></ButtonGroup>', 'button')).toBe(0);
  });

  it('the heading ceiling covers h1 through h6 only, not header/hgroup or other levels', () => {
    const code = '<h1>a</h1><h2>b</h2><h3>c</h3><h4>d</h4><h5>e</h5><h6>f</h6><header>g</header><hgroup>h</hgroup>';
    expect(countRawTagOccurrences(code, 'heading')).toBe(6);
  });

  it('inherits comment stripping: a tag named only in a doc comment is not a real occurrence', () => {
    const code =
      '/**\n * Replaces the old <table className="w-full"> markup with DataTable.\n */\nexport function X() { return null; }';
    expect(countRawTagOccurrences(code, 'table')).toBe(0);
  });

  it('scans the same non-empty target-file scope CEILINGS uses', () => {
    expect(targetFiles().length).toBeGreaterThan(300);
  });
});
