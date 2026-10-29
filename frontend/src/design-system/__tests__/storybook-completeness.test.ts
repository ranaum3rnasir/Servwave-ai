/* =============================================================================
   Storybook completeness guard - W2 plan, Storybook phase.

   THE GAP THIS CLOSES. A cva() block can grow a new variant value (a call
   site's real signature gets minted) with nobody remembering to add a story
   for it - the .stories.tsx file quietly falls out of sync with the
   component it documents, and nothing catches that except a human noticing
   the story panel looks incomplete. This test is the machine check: it reads
   every cva() block's own variant keys and values, straight out of the
   component source (not a hand-maintained list that can itself drift), reads
   every co-located .stories.tsx file for which of those values a real story
   renders, and fails - naming the exact primitive / variant key / value
   triples - the moment the two disagree.

   WHAT COUNTS AS "HAS A STORY". A value is covered when some exported Story
   in the co-located file actually RENDERS it - either as a literal prop
   (`tone="danger"`, `gap={3}`) in an `args` object or in JSX inside a
   `render` function, or via a `.map()` over a locally-declared literal array
   whose elements are spread onto the prop (`GAPS.map((gap) => <Alert
   gap={gap}>)`, the shape alert.tsx's own GapScale story and several others
   use for a wide scale). The meta object's `argTypes.options` list is
   DELIBERATELY EXCLUDED from evidence: listing a value as a selectable
   control option is not the same claim as a story rendering it, and treating
   the two as equivalent would make this guard toothless - every file in this
   tree already lists every cva value in `argTypes` (good practice on its
   own), so if that counted as "a story", this test could never go red. The
   red/green proof at the bottom of this file demonstrates the distinction
   directly: deleting a story's `args` entry while leaving its `argTypes`
   option in place still fails.

   PARSER SHAPE, NOT AN AST. Regex + balanced-bracket scanning, matching the
   established style of component-api-guard.test.ts in this same directory
   (stripComments, brace-depth matching, string-literal-aware scanning) rather
   than pulling in a TypeScript parser dependency for one guard. Every
   non-obvious shape below was found by reading the real files this test
   scans, not guessed at - see the inline notes at each branch.

   ONE DELIBERATE, NAMED SPECIAL CASE: button.tsx's `cell` KEY.
   Every other primitive's cva variant key IS its public prop name (`tone`
   on Badge is JSX prop `tone`), so "does `tone="danger"` appear as a literal
   somewhere" is direct evidence. Button is the one exception: its cva block
   is keyed on `cell` (`"solid/brand"`, `"outline/danger"`, ...), an internal
   axis nothing outside button.tsx ever writes - the PUBLIC props are
   `variant` + `tone` (+ `revealOnHover`), resolved to a `cell` key at
   render time by `resolveButtonCell()`. A literal search for `cell="solid/
   brand"` would find nothing in button.stories.tsx (correctly - that file
   never writes the word "cell" at all) and every one of Button's 13 cells
   would misreport as missing. `resolveCellCoverage` below is the named
   adapter: split a `structure/tone` cell key on its slash and require each
   half to have independent evidence as a `variant` / `tone` literal
   somewhere in the file (plus `revealOnHover` truthy evidence for a
   `#reveal`-suffixed cell). This does not verify the exact PAIRING a story
   renders - only that both halves appear somewhere in the file - which is a
   real, disclosed weaker guarantee than every other primitive in this test
   gets. Scoped to the literal variant key name `cell`, so no other primitive
   is affected by it.

   THE SECOND SHAPE THIS PARSER WALKS: A PLAIN `Record<Key, string>` LOOKUP.
   cva is not the only way a component splices a variant's class into its
   className string. dialog.tsx's `width`/`pad`/`gap` and sheet.tsx's
   `side`/`width`/`pad`/`gap` are each a plain `const NAME: Record<Key,
   string> = {...}` object, indexed with `NAME[prop]` at the exact byte
   position the pre-phase-8 base string held that fragment - both files'
   own header comments explain why: cva's `variants` map always appends a
   variant's class AFTER the base string, which would change the byte order
   of the DEFAULT-value render even though the class SET stayed identical,
   and preserving that exact byte order is the one thing phase 8's split of
   those primitives was not allowed to do. `extractCvaBlocks` has nothing to
   walk there - no call to `cva(...)` exists in either file - so before this
   guard walked `extractRecordLookupBlocks` too, `checkCompleteness` hit its
   own `if (blocks.length === 0) continue` for both files and skipped them
   WHOLESALE: not just the `width`/`pad`/`gap` axes, the entire file, with
   zero enforcement power over either. `extractRecordLookupBlocks` below
   finds the same "prop value -> class string" axis in that shape instead:
   every `Record<Key, string>` declaration (scoped to a `string`-valued
   Record specifically - see its own doc comment for why that is what
   distinguishes a class-producing lookup from an internal derivation table
   like button.tsx's `DEFAULT_TONE: Record<ButtonStructure, ButtonTone>`,
   which produces a *tone*, not a class, and is not this guard's business),
   plus the real prop name it is indexed by, read straight off a live
   `NAME[prop]` usage in the same file - never hand-maintained, so it cannot
   itself drift out of sync with a rename the way a hand-written list could.
   `checkCompleteness` now only skips a file when NEITHER shape yields
   anything to check, so a value that only ever lived as manually-verified
   prose in a story file's header comment (dialog.stories.tsx / sheet.
   stories.tsx both said as much, in nearly those words, before this change)
   is machine-checked the same way a cva value already was.
   ============================================================================= */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_DIR = resolve(HERE, '..', '..', 'components', 'ui');

// -----------------------------------------------------------------------------
// Comment stripping. Same two-pattern approach as component-api-guard.test.ts's
// own `stripComments` (block comments not preceded by a word character, so a
// `/*` inside a string like a MIME-type attribute is not misread as an
// opener; line comments not preceded by `:` so a `https://` URL survives) -
// duplicated rather than imported, since importing a named export from
// another *.test.ts file would re-execute that file's own top-level
// `describe` blocks a second time under vitest.
// -----------------------------------------------------------------------------
export function stripComments(src: string): string {
  return src.replace(/(?<![\w])\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// -----------------------------------------------------------------------------
// Balanced-bracket scanning, string- and template-literal-aware. `text[openIdx]`
// must be `open`; returns the index of the matching `close`, or -1 if the
// text ends first (malformed input, not real code - callers treat -1 as
// "give up on this span" rather than throwing).
// -----------------------------------------------------------------------------
export function matchBalanced(text: string, openIdx: number, open: string, close: string): number {
  let depth = 0;
  let inString: string | null = null;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') { i++; continue; }
      if (c === inString) inString = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inString = c; continue; }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Every top-level `key: value` entry of an object-literal's INNER text (the
 * text strictly between its outer `{` and `}`), split on top-level commas
 * only - a comma inside a nested `{}`/`[]`/`()` or inside a string does not
 * split. Each entry's key/value are separated on the first top-level `:`.
 * Trailing-comma artifacts (an empty final segment) are dropped.
 */
export function splitTopLevelEntries(inner: string): Array<{ keyRaw: string; valueRaw: string }> {
  const segments: string[] = [];
  let depth = 0;
  let inString: string | null = null;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (inString) {
      if (c === '\\') { i++; continue; }
      if (c === inString) inString = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inString = c; continue; }
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') depth--;
    else if (c === ',' && depth === 0) {
      segments.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  segments.push(inner.slice(start));

  const entries: Array<{ keyRaw: string; valueRaw: string }> = [];
  for (const seg of segments) {
    if (!seg.trim()) continue;
    let d = 0;
    let s: string | null = null;
    let colonIdx = -1;
    for (let i = 0; i < seg.length; i++) {
      const c = seg[i];
      if (s) {
        if (c === '\\') { i++; continue; }
        if (c === s) s = null;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') { s = c; continue; }
      if (c === '{' || c === '[' || c === '(') d++;
      else if (c === '}' || c === ']' || c === ')') d--;
      else if (c === ':' && d === 0) { colonIdx = i; break; }
    }
    if (colonIdx === -1) continue; // not a key:value entry (e.g. a bare spread) - not a cva shape
    entries.push({ keyRaw: seg.slice(0, colonIdx).trim(), valueRaw: seg.slice(colonIdx + 1).trim() });
  }
  return entries;
}

/** A key token (quoted string, bare identifier, boolean, or number) -> its bare string form. */
function normalizeKey(raw: string): string {
  const t = raw.trim();
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
    return t.slice(1, -1);
  }
  return t;
}

/** The ordered list of top-level keys of a flat object-literal's inner text. */
export function parseObjectKeys(objInner: string): string[] {
  return splitTopLevelEntries(objInner).map((e) => normalizeKey(e.keyRaw));
}

/**
 * `const <id> = { ... }` (optionally `export`ed, optionally type-annotated,
 * e.g. `const SURFACE_TONE_CLASSES: Record<SurfaceTone, string> = {...}`) ->
 * that object literal's inner text, or null if no such object-literal const
 * is found. Used to resolve a cva variant whose value is a bare identifier
 * (`tone: SURFACE_TONE_CLASSES`) rather than an inline object, the shape
 * action-link.tsx / surface.tsx / button.tsx each use for their own reasons
 * (see each file's header).
 */
export function resolveObjectLiteralByIdentifier(fileText: string, id: string): string | null {
  const re = new RegExp(`(?:export\\s+)?const\\s+${id}\\b\\s*(?::[^=]*)?=\\s*`);
  const m = re.exec(fileText);
  if (!m) return null;
  const idx = m.index + m[0].length;
  if (fileText[idx] !== '{') return null;
  const close = matchBalanced(fileText, idx, '{', '}');
  if (close === -1) return null;
  return fileText.slice(idx + 1, close);
}

// -----------------------------------------------------------------------------
// cva() block extraction.
// -----------------------------------------------------------------------------

export interface CvaBlock {
  /** The `const <name> = cva(...)` variable name - disambiguates a file with
   *  more than one cva() call, e.g. toggle-group.tsx's `toggleGroupVariants`
   *  and `toggleGroupItemVariants`. */
  varName: string;
  /** variant key name -> ordered list of its values, as bare strings. */
  variants: Map<string, string[]>;
  /** Any variant key whose value was neither an inline object literal nor a
   *  resolvable identifier - recorded rather than silently dropped, so a
   *  future shape this parser does not understand fails loudly instead of
   *  quietly under-reporting. Expected to be empty across the real tree. */
  unparsed: string[];
}

/**
 * Every `const X = cva(...)` block in `fileText` (comments already expected
 * to be stripped by the caller). Only the `variants: {...}` key is read -
 * `compoundVariants` and `defaultVariants` are deliberately not - see the
 * file header on why a plain substring search for lowercase "variants:"
 * cannot collide with either (both are spelled with a capital V).
 */
export function extractCvaBlocks(fileText: string): CvaBlock[] {
  const blocks: CvaBlock[] = [];
  const declRe = /(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*cva\(/g;
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(fileText))) {
    const varName = m[1]!;
    const parenIdx = m.index + m[0].length - 1; // index of the "(" itself
    const callEnd = matchBalanced(fileText, parenIdx, '(', ')');
    if (callEnd === -1) continue;
    const callInner = fileText.slice(parenIdx + 1, callEnd);

    const variantsKeyRe = /(?<![A-Za-z0-9_$])variants\s*:\s*\{/;
    const vm = variantsKeyRe.exec(callInner);
    if (!vm) {
      blocks.push({ varName, variants: new Map(), unparsed: [] });
      continue;
    }
    const braceIdx = vm.index + vm[0].length - 1;
    const braceEnd = matchBalanced(callInner, braceIdx, '{', '}');
    if (braceEnd === -1) continue;
    const variantsInner = callInner.slice(braceIdx + 1, braceEnd);

    const variants = new Map<string, string[]>();
    const unparsed: string[] = [];
    for (const { keyRaw, valueRaw } of splitTopLevelEntries(variantsInner)) {
      const variantKey = normalizeKey(keyRaw);
      const v = valueRaw.trim();
      if (v.startsWith('{')) {
        const close = matchBalanced(v, 0, '{', '}');
        const objInner = close === -1 ? v.slice(1) : v.slice(1, close);
        variants.set(variantKey, parseObjectKeys(objInner));
      } else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(v)) {
        const resolved = resolveObjectLiteralByIdentifier(fileText, v);
        if (resolved === null) {
          unparsed.push(variantKey);
          variants.set(variantKey, []);
        } else {
          variants.set(variantKey, parseObjectKeys(resolved));
        }
      } else {
        unparsed.push(variantKey);
        variants.set(variantKey, []);
      }
    }
    blocks.push({ varName, variants, unparsed });
  }
  return blocks;
}

// -----------------------------------------------------------------------------
// Record-lookup axis extraction - the non-cva shape. See the file header's
// "THE SECOND SHAPE THIS PARSER WALKS" for why this exists alongside
// extractCvaBlocks rather than folding into it (a Record lookup has no
// `variants:` key, no `cva(` call, and is indexed by a live `NAME[prop]`
// usage rather than being the prop name itself by construction).
// -----------------------------------------------------------------------------

export interface RecordLookupBlock {
  /** The `const NAME: Record<Key, string> = {...}` variable name. */
  varName: string;
  /** The prop name the lookup is indexed by, read off a real `NAME[prop]`
   *  usage elsewhere in the file (`DIALOG_PAD[pad]` -> "pad",
   *  `PAD_X[padX ?? pad]` -> "padX", the first identifier inside the
   *  brackets). Null when no such usage exists anywhere in the file - kept
   *  as an explicit parse issue rather than silently dropped, same
   *  discipline as CvaBlock's `unparsed`. */
  propName: string | null;
  /** Ordered list of the lookup's keys, as bare strings. */
  values: string[];
}

/**
 * Top-level-comma-separated segments of `text` (depth- and string-aware,
 * tracking `{[(<` / `}])>` together so a nested generic like
 * `Record<NonNullable<X['size']>, string>`'s inner comma-free type argument
 * does not get mistaken for a splitting point). Unlike `splitTopLevelEntries`
 * this does not require a `key:value` shape - a generic argument list has
 * none.
 */
function splitTopLevelCommas(text: string): string[] {
  const segments: string[] = [];
  let depth = 0;
  let inString: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') { i++; continue; }
      if (c === inString) inString = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inString = c; continue; }
    if (c === '{' || c === '[' || c === '(' || c === '<') depth++;
    else if (c === '}' || c === ']' || c === ')' || c === '>') depth--;
    else if (c === ',' && depth === 0) { segments.push(text.slice(start, i)); start = i + 1; }
  }
  segments.push(text.slice(start));
  return segments;
}

/**
 * True when `varName` is consumed as a bare identifier VALUE somewhere in
 * `fileText` other than its own declaration - the shape surface.tsx's
 * `SURFACE_TONE_CLASSES` uses (`variants: { tone: SURFACE_TONE_CLASSES }`
 * inside a `cva()` call). A Record block referenced that way is not an
 * orphan: `extractCvaBlocks` + `resolveObjectLiteralByIdentifier` already
 * walk it as part of that cva block's own `tone` variant, with its own
 * coverage check run against the real prop (`tone`), not this lookup's own
 * name. Re-scanning it here too would either double the same demand under a
 * second, made-up variant-key label, or - since this shape is never indexed
 * with `NAME[prop]` bracket syntax at all - misreport it as an unresolved
 * axis. Declaration lines never match: `const NAME: Record<...>` has no
 * colon immediately before `NAME`, only one immediately after it.
 */
function isConsumedAsIdentifierValue(fileText: string, varName: string): boolean {
  const escapedName = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`:\\s*${escapedName}\\b`).test(fileText);
}

/**
 * Every `const NAME: Record<Key, string> = {...}` in `fileText` (comments
 * already expected stripped by the caller) - deliberately scoped to a
 * `string`-valued Record specifically. That is what marks a lookup as
 * "prop value -> class string": every internal derivation table in this
 * tree that maps to something else (button.tsx's `DEFAULT_TONE:
 * Record<ButtonStructure, ButtonTone>`, card.tsx's `LEGACY_PADDING:
 * Record<"none" | "sm" | "md" | "lg", PadStep>`, empty-state.tsx's
 * `DENSITY_TO_PAD: Record<..., keyof typeof EMPTY_STATE_PAD>`) produces an
 * intermediate value for more lookup, not a class string a story could
 * render evidence of, and is correctly invisible to this extractor. A block
 * already resolved through the cva-identifier path (see
 * `isConsumedAsIdentifierValue`) is silently skipped rather than yielded -
 * it is fully covered already, under its real prop name, by the existing
 * cva pass.
 */
export function extractRecordLookupBlocks(fileText: string): RecordLookupBlock[] {
  const blocks: RecordLookupBlock[] = [];
  const declRe = /(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*Record\s*</g;
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(fileText))) {
    const varName = m[1]!;
    const ltIdx = m.index + m[0].length - 1; // index of the "<" itself
    const gtIdx = matchBalanced(fileText, ltIdx, '<', '>');
    if (gtIdx === -1) continue;
    const genericArgs = splitTopLevelCommas(fileText.slice(ltIdx + 1, gtIdx));
    if (genericArgs.length !== 2 || genericArgs[1]!.trim() !== 'string') continue;

    const afterGeneric = fileText.slice(gtIdx + 1);
    const eqMatch = /^\s*=\s*\{/.exec(afterGeneric);
    if (!eqMatch) continue;
    const braceIdx = gtIdx + 1 + eqMatch[0].length - 1;
    const close = matchBalanced(fileText, braceIdx, '{', '}');
    if (close === -1) continue;
    const values = parseObjectKeys(fileText.slice(braceIdx + 1, close));

    const escapedName = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const usageRe = new RegExp(`\\b${escapedName}\\[\\s*([A-Za-z_$][A-Za-z0-9_$]*)`);
    const um = usageRe.exec(fileText);
    if (!um && isConsumedAsIdentifierValue(fileText, varName)) continue;
    blocks.push({ varName, propName: um ? um[1]! : null, values });
  }
  return blocks;
}

// -----------------------------------------------------------------------------
// Story-file coverage extraction.
// -----------------------------------------------------------------------------

/**
 * Remove every `argTypes: { ... }` span from `text`, replacing it with
 * spaces of the same length (preserving every other offset, which nothing
 * downstream relies on, but is cheap and avoids re-deriving indices). This
 * is what makes "listed as a control option" NOT count as "has a story" -
 * see the file header.
 */
function stripArgTypes(text: string): string {
  let out = text;
  const re = /argTypes\s*:\s*\{/;
  for (;;) {
    const m = re.exec(out);
    if (!m) break;
    const braceIdx = m.index + m[0].length - 1;
    const close = matchBalanced(out, braceIdx, '{', '}');
    if (close === -1) break;
    out = out.slice(0, m.index) + ' '.repeat(close - m.index + 1) + out.slice(close + 1);
  }
  return out;
}

/** `const NAME = [ ... ]` (optionally typed/exported/`as const`) -> its literal elements, as bare strings. Non-literal elements (spreads, `undefined`) are dropped. */
function findLocalArrays(text: string): Map<string, string[]> {
  const arrays = new Map<string, string[]>();
  const re = /(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=]*)?=\s*\[/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const bracketIdx = m.index + m[0].length - 1;
    const close = matchBalanced(text, bracketIdx, '[', ']');
    if (close === -1) continue;
    const inner = text.slice(bracketIdx + 1, close);
    const elements: string[] = [];
    // `splitTopLevelEntries` expects `key: value` shape; a plain array's
    // elements have no colon, so a top-level comma split is done directly
    // here instead of reusing it.
    let depth = 0;
    let s: string | null = null;
    let start = 0;
    const push = (raw: string) => {
      const t = raw.trim();
      if (!t || t === 'undefined') return;
      if (t.startsWith('...')) return; // a spread, e.g. [undefined, ...SIZES] - not a literal element
      elements.push(normalizeKey(t));
    };
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i];
      if (s) {
        if (c === '\\') { i++; continue; }
        if (c === s) s = null;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') { s = c; continue; }
      if (c === '{' || c === '[' || c === '(') depth++;
      else if (c === '}' || c === ']' || c === ')') depth--;
      else if (c === ',' && depth === 0) { push(inner.slice(start, i)); start = i + 1; }
    }
    push(inner.slice(start));
    arrays.set(m[1]!, elements);
  }
  return arrays;
}

/** `ARRAY.map((param` -> paramName -> ARRAY, for every `.map()` call over a named array in `text`. */
function findMapParams(text: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /([A-Za-z_$][A-Za-z0-9_$]*)\.map\(\s*\(\s*([A-Za-z_$][A-Za-z0-9_$]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) map.set(m[2]!, m[1]!);
  return map;
}

/** A JSX-attribute or object-property VALUE expression -> its literal bare-string form(s), resolving a `.map()` loop-variable identifier to every element of the array it iterates. Non-literal, unresolvable expressions contribute nothing (never a false positive, only a possible under-count that other stories typically also cover). */
function literalsOf(exprRaw: string, localArrays: Map<string, string[]>, mapParams: Map<string, string>): string[] {
  const expr = exprRaw.trim();
  if ((expr.startsWith("'") && expr.endsWith("'")) || (expr.startsWith('"') && expr.endsWith('"'))) {
    return [expr.slice(1, -1)];
  }
  if (/^-?\d+(\.\d+)?$/.test(expr)) return [expr];
  if (expr === 'true' || expr === 'false') return [expr];
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(expr)) {
    const arrayName = mapParams.get(expr);
    if (arrayName && localArrays.has(arrayName)) return localArrays.get(arrayName)!;
  }
  return [];
}

/**
 * Every literal value found for JSX attribute / args-object key `key`
 * anywhere in `storyText` (argTypes already stripped by the caller) - the
 * union of four shapes real files in this tree use: `key="literal"`,
 * `key={literal-or-map-resolved-identifier}`, a bare boolean JSX shorthand
 * (`<Inline wrap>` meaning `wrap={true}`), and `key: literal` inside any
 * `args: {...}` object.
 */
export function findCoveredValues(storyText: string, key: string): Set<string> {
  const covered = new Set<string>();
  const localArrays = findLocalArrays(storyText);
  const mapParams = findMapParams(storyText);
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // key="literal" / key='literal'
  const quotedRe = new RegExp(`\\b${escapedKey}\\s*=\\s*(["'])((?:(?!\\1).)*)\\1`, 'g');
  let qm: RegExpExecArray | null;
  while ((qm = quotedRe.exec(storyText))) covered.add(qm[2]!);

  // key={expr}
  const braceAttrRe = new RegExp(`\\b${escapedKey}\\s*=\\s*\\{`, 'g');
  let am: RegExpExecArray | null;
  while ((am = braceAttrRe.exec(storyText))) {
    const braceIdx = am.index + am[0].length - 1;
    const close = matchBalanced(storyText, braceIdx, '{', '}');
    if (close === -1) continue;
    const exprText = storyText.slice(braceIdx + 1, close);
    for (const lit of literalsOf(exprText, localArrays, mapParams)) covered.add(lit);
  }

  // bare boolean JSX shorthand: `<Foo ... wrap ...>`, not followed by `=` or `:`
  const bareRe = new RegExp(`[\\s<]${escapedKey}(?=[\\s/>])(?!\\s*[:=])`, 'g');
  if (bareRe.test(storyText)) covered.add('true');

  // key: literal inside any args: {...} object
  const argsRe = /\bargs\s*:\s*\{/g;
  let gm: RegExpExecArray | null;
  while ((gm = argsRe.exec(storyText))) {
    const braceIdx = gm.index + gm[0].length - 1;
    const close = matchBalanced(storyText, braceIdx, '{', '}');
    if (close === -1) continue;
    const inner = storyText.slice(braceIdx + 1, close);
    for (const { keyRaw, valueRaw } of splitTopLevelEntries(inner)) {
      if (normalizeKey(keyRaw) !== key) continue;
      for (const lit of literalsOf(valueRaw, localArrays, mapParams)) covered.add(lit);
    }
  }

  return covered;
}

/**
 * button.tsx's `cell` axis - see the file header's "ONE DELIBERATE, NAMED
 * SPECIAL CASE". `cellValues` are the raw keys straight out of
 * BUTTON_CELL_CLASSES (`"solid/brand"`, `"ghost/danger#reveal"`, `"onDark"`).
 */
export function resolveCellCoverage(storyText: string, cellValues: string[]): Set<string> {
  const covered = new Set<string>();
  const variantCovered = findCoveredValues(storyText, 'variant');
  const toneCovered = findCoveredValues(storyText, 'tone');
  const revealCovered = findCoveredValues(storyText, 'revealOnHover').has('true');
  for (const cell of cellValues) {
    const needsReveal = cell.endsWith('#reveal');
    const base = needsReveal ? cell.slice(0, -'#reveal'.length) : cell;
    const slash = base.indexOf('/');
    if (slash === -1) {
      if (variantCovered.has(base)) covered.add(cell);
      continue;
    }
    const structure = base.slice(0, slash);
    const tone = base.slice(slash + 1);
    if (variantCovered.has(structure) && toneCovered.has(tone) && (!needsReveal || revealCovered)) {
      covered.add(cell);
    }
  }
  return covered;
}

// -----------------------------------------------------------------------------
// File discovery.
// -----------------------------------------------------------------------------

function listUiTsxFiles(): string[] {
  return readdirSync(UI_DIR)
    .filter((f) => f.endsWith('.tsx') && !f.endsWith('.stories.tsx') && !f.includes('.test.'))
    .map((f) => join(UI_DIR, f));
}

export interface PrimitiveGap {
  file: string;
  varName: string;
  variantKey: string;
  value: string;
}

export interface CompletenessResult {
  gaps: PrimitiveGap[];
  scannedPrimitives: number;
  scannedValues: number;
  parseIssues: Array<{ file: string; varName: string; variantKey: string }>;
}

/**
 * The full scan: every cva() block under `components/ui/*.tsx` (excluding
 * `.stories.tsx` and test files, per the brief) against its co-located
 * `.stories.tsx` file's coverage.
 */
export function checkCompleteness(): CompletenessResult {
  const gaps: PrimitiveGap[] = [];
  const parseIssues: CompletenessResult['parseIssues'] = [];
  let scannedPrimitives = 0;
  let scannedValues = 0;

  for (const componentPath of listUiTsxFiles()) {
    const componentFile = basename(componentPath);
    const componentText = stripComments(readFileSync(componentPath, 'utf8'));
    const blocks = extractCvaBlocks(componentText);
    const recordBlocks = extractRecordLookupBlocks(componentText);
    // A file with neither shape (no cva() call, no string-valued Record
    // lookup) has nothing for this guard to check - skip it. A file with
    // only the Record shape (dialog.tsx, sheet.tsx: zero cva() calls) must
    // NOT be skipped just because `blocks` is empty - that was the gap.
    if (blocks.length === 0 && recordBlocks.length === 0) continue;

    const storyPath = join(dirname(componentPath), componentFile.replace(/\.tsx$/, '.stories.tsx'));
    let storyText: string;
    try {
      storyText = stripArgTypes(stripComments(readFileSync(storyPath, 'utf8')));
    } catch {
      storyText = ''; // no story file at all - every value below reports missing
    }

    for (const block of blocks) {
      for (const variantKey of block.unparsed) {
        parseIssues.push({ file: componentFile, varName: block.varName, variantKey });
      }
      for (const [variantKey, values] of block.variants) {
        if (values.length === 0) continue;
        scannedPrimitives++;
        const covered =
          variantKey === 'cell' && componentText.includes('BUTTON_CELL_CLASSES')
            ? resolveCellCoverage(storyText, values)
            : findCoveredValues(storyText, variantKey);
        for (const value of values) {
          scannedValues++;
          if (!covered.has(value)) {
            gaps.push({ file: componentFile, varName: block.varName, variantKey, value });
          }
        }
      }
    }

    for (const recordBlock of recordBlocks) {
      if (recordBlock.propName === null) {
        parseIssues.push({
          file: componentFile,
          varName: recordBlock.varName,
          variantKey: '(no NAME[prop] usage found to resolve the axis to a prop)',
        });
        continue;
      }
      if (recordBlock.values.length === 0) continue;
      scannedPrimitives++;
      const covered = findCoveredValues(storyText, recordBlock.propName);
      for (const value of recordBlock.values) {
        scannedValues++;
        if (!covered.has(value)) {
          gaps.push({ file: componentFile, varName: recordBlock.varName, variantKey: recordBlock.propName, value });
        }
      }
    }
  }

  return { gaps, scannedPrimitives, scannedValues, parseIssues };
}

// -----------------------------------------------------------------------------
// The guard itself.
// -----------------------------------------------------------------------------

describe('storybook completeness (every cva variant value has a rendered story)', () => {
  it('scans a non-empty, non-trivial set of cva blocks', () => {
    const result = checkCompleteness();
    process.stdout.write(
      `  scanned ${result.scannedPrimitives} variant keys, ${result.scannedValues} values, ` +
        `${result.gaps.length} gaps, ${result.parseIssues.length} parse issues\n`,
    );
    expect(result.scannedPrimitives).toBeGreaterThan(15);
    expect(result.scannedValues).toBeGreaterThan(80);
  });

  it('reports zero variant key/value shapes this parser could not read', () => {
    const result = checkCompleteness();
    if (result.parseIssues.length > 0) {
      process.stdout.write(
        '  unparsed cva variant values (parser gap, not a coverage gap):\n' +
          result.parseIssues.map((p) => `    ${p.file} ${p.varName}.${p.variantKey}\n`).join(''),
      );
    }
    expect(result.parseIssues).toEqual([]);
  });

  it('every cva() variant value in components/ui has a story that renders it', () => {
    const result = checkCompleteness();
    if (result.gaps.length > 0) {
      const lines = result.gaps
        .map((g) => `    ${g.file} :: ${g.varName}.${g.variantKey} = "${g.value}"`)
        .join('\n');
      process.stdout.write(
        `  storybook completeness gaps (${result.gaps.length} of ${result.scannedValues}):\n${lines}\n`,
      );
    }
    expect(result.gaps).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// Asserted examples (lock the detector itself, mirroring
// component-api-guard.test.ts's own "asserted examples" section).
// -----------------------------------------------------------------------------

describe('storybook completeness detector (asserted examples)', () => {
  it('extracts a plain inline-object cva variants block', () => {
    const src = stripComments(`
      const badgeVariants = cva("base", {
        variants: {
          variant: { default: "a", outline: "b" },
          tone: { brand: "", neutral: "x" },
        },
        defaultVariants: { variant: "default", tone: "brand" },
      });
    `);
    const [block] = extractCvaBlocks(src);
    expect(block!.varName).toBe('badgeVariants');
    expect(block!.variants.get('variant')).toEqual(['default', 'outline']);
    expect(block!.variants.get('tone')).toEqual(['brand', 'neutral']);
  });

  it('does not confuse compoundVariants or defaultVariants with the variants key', () => {
    const src = stripComments(`
      const alertVariants = cva("base", {
        variants: { tone: { danger: "x" } },
        compoundVariants: [{ variant: "outline", tone: "danger", class: "y" }],
        defaultVariants: { tone: "danger" },
      });
    `);
    const [block] = extractCvaBlocks(src);
    expect([...block!.variants.keys()]).toEqual(['tone']);
  });

  it('reads numeric and boolean-shaped keys, including a decimal step', () => {
    const src = stripComments(`
      const stackVariants = cva("flex", {
        variants: {
          wrap: { true: "flex-wrap", false: "" },
          gap: { 0: "gap-0", 0.5: "gap-0.5", 12: "gap-12" },
        },
      });
    `);
    const [block] = extractCvaBlocks(src);
    expect(block!.variants.get('wrap')).toEqual(['true', 'false']);
    expect(block!.variants.get('gap')).toEqual(['0', '0.5', '12']);
  });

  it('reads a quoted key that could not be a bare identifier, e.g. "3xl"', () => {
    const src = stripComments(`
      const headingVariants = cva("", {
        variants: { scale: { '2xl': 'text-2xl', xl: 'text-xl' } },
      });
    `);
    const [block] = extractCvaBlocks(src);
    expect(block!.variants.get('scale')).toEqual(['2xl', 'xl']);
  });

  it('resolves a variant value that is an identifier reference to a same-file object literal', () => {
    const src = stripComments(`
      const SURFACE_TONE_CLASSES: Record<SurfaceTone, string> = {
        light: "",
        dark: "bg-surface-dark text-on-dark",
      }
      const surfaceVariants = cva("", {
        variants: { tone: SURFACE_TONE_CLASSES },
      })
    `);
    const [block] = extractCvaBlocks(src);
    expect(block!.variants.get('tone')).toEqual(['light', 'dark']);
    expect(block!.unparsed).toEqual([]);
  });

  it('records an unresolvable variant value rather than silently dropping it', () => {
    const src = stripComments(`
      const mysteryVariants = cva("", { variants: { tone: SomethingNeverDeclared } });
    `);
    const [block] = extractCvaBlocks(src);
    expect(block!.unparsed).toEqual(['tone']);
    expect(block!.variants.get('tone')).toEqual([]);
  });

  it('finds two separate cva blocks in one file, keyed by their own variable name', () => {
    const src = stripComments(`
      const toggleGroupVariants = cva("a", { variants: { variant: { segmented: "x", pill: "y" } } })
      const toggleGroupItemVariants = cva("b", { variants: { variant: { segmented: "x2", pill: "y2" } } })
    `);
    const blocks = extractCvaBlocks(src);
    expect(blocks.map((b) => b.varName)).toEqual(['toggleGroupVariants', 'toggleGroupItemVariants']);
  });

  it('finds a literal JSX attribute value, quoted', () => {
    const covered = findCoveredValues(`<Badge tone="danger">x</Badge>`, 'tone');
    expect(covered.has('danger')).toBe(true);
  });

  it('finds a literal args-object value, including a bare number and a bare boolean', () => {
    const text = `export const Default: Story = { args: { gap: 0, wrap: false, tone: 'brand' } };`;
    expect(findCoveredValues(text, 'gap').has('0')).toBe(true);
    expect(findCoveredValues(text, 'wrap').has('false')).toBe(true);
    expect(findCoveredValues(text, 'tone').has('brand')).toBe(true);
  });

  it('resolves a .map() over a locally declared literal array spread onto a prop', () => {
    const text = `
      const GAPS = [0, 0.5, 1, 12] as const;
      export const GapScale: Story = {
        render: () => (
          <>
            {GAPS.map((gap) => (
              <Alert key={gap} gap={gap} />
            ))}
          </>
        ),
      };
    `;
    const covered = findCoveredValues(text, 'gap');
    expect([...covered].sort()).toEqual(['0', '0.5', '1', '12']);
  });

  it('reads a bare boolean JSX shorthand attribute as true, not as a coverage gap', () => {
    const covered = findCoveredValues(`<Inline gap={3} wrap align="center">x</Inline>`, 'wrap');
    expect(covered.has('true')).toBe(true);
  });

  it('does NOT count an argTypes.options listing as coverage - the whole point of stripArgTypes', () => {
    const raw = `
      const meta = {
        argTypes: {
          tone: { control: { type: 'select' }, options: ['brand', 'neutral', 'danger'] },
        },
      };
      export const Default: Story = { args: { tone: 'brand' } };
    `;
    const stripped = stripArgTypes(raw);
    const covered = findCoveredValues(stripped, 'tone');
    // 'brand' still covered - it is in a real args object, not just argTypes.
    expect(covered.has('brand')).toBe(true);
    // 'neutral' and 'danger' are ONLY in argTypes.options, so they must NOT
    // read as covered once that span is stripped.
    expect(covered.has('neutral')).toBe(false);
    expect(covered.has('danger')).toBe(false);
  });

  it('resolves button.tsx-shaped cell coverage from separate variant/tone literals, including the reveal modifier', () => {
    const text = `
      export const Solid: Story = {
        render: () => (
          <Button variant="solid" tone="brand">Brand</Button>
        ),
      };
      export const GhostRevealOnHover: Story = {
        args: { variant: 'ghost', tone: 'danger', revealOnHover: true },
      };
      export const OnDark: Story = {
        render: () => <Button variant="onDark">On dark</Button>,
      };
    `;
    const covered = resolveCellCoverage(text, [
      'solid/brand',
      // Neither "solid" nor "danger" individually is under-evidenced here -
      // "solid" comes from Solid's own render, "danger" from
      // GhostRevealOnHover's tone. This is the documented weaker guarantee:
      // the heuristic finds each half independently, not the exact pairing
      // a story renders, so this reads as covered even though no single
      // story renders solid+danger together.
      'solid/danger',
      'ghost/danger#reveal',
      'ghost/danger', // present without the reveal modifier requirement
      'link/brand', // "link" is never rendered anywhere in this fixture text
      'onDark',
    ]);
    expect(covered.has('solid/brand')).toBe(true);
    expect(covered.has('solid/danger')).toBe(true);
    expect(covered.has('ghost/danger#reveal')).toBe(true);
    expect(covered.has('ghost/danger')).toBe(true);
    expect(covered.has('link/brand')).toBe(false);
    expect(covered.has('onDark')).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Record-lookup axis detector (asserted examples). Same discipline as the
// cva detector's own section above: every non-obvious shape is a real one
// found by reading dialog.tsx / sheet.tsx / card.tsx / surface.tsx, not
// guessed at.
// -----------------------------------------------------------------------------

describe('storybook completeness detector - record-lookup axis (asserted examples)', () => {
  it('extracts a dialog.tsx-shaped Record<Key, string> block and resolves its prop from bracket usage', () => {
    const src = stripComments(`
      export type DialogWidth = "xs" | "sm" | "md" | "lg"
      const DIALOG_WIDTH: Record<DialogWidth, string> = {
        xs: "max-w-sm",
        sm: "max-w-md",
        md: "max-w-lg",
        lg: "max-w-2xl",
      }
      const DialogContent = (({ width = "md" }) => (
        <div className={cn("fixed", DIALOG_WIDTH[width], "z-50")} />
      ))
    `);
    const [block] = extractRecordLookupBlocks(src);
    expect(block!.varName).toBe('DIALOG_WIDTH');
    expect(block!.propName).toBe('width');
    expect(block!.values).toEqual(['xs', 'sm', 'md', 'lg']);
  });

  it('finds every Record<Key, string> block in a file, keyed by their own variable names - the sheet.tsx shape', () => {
    const src = stripComments(`
      const SHEET_SIDE: Record<SheetSide, string> = { top: "a", bottom: "b", left: "c", right: "d" }
      const SHEET_PAD: Record<SheetSpacing, string> = { none: "p-0", md: "p-6" }
      const SheetContent = (({ side = "right", pad = "md" }) => (
        <div className={cn(SHEET_PAD[pad], SHEET_SIDE[side])} />
      ))
    `);
    const blocks = extractRecordLookupBlocks(src);
    expect(blocks.map((b) => b.varName)).toEqual(['SHEET_SIDE', 'SHEET_PAD']);
    expect(blocks.find((b) => b.varName === 'SHEET_SIDE')!.propName).toBe('side');
    expect(blocks.find((b) => b.varName === 'SHEET_PAD')!.propName).toBe('pad');
  });

  it('does not extract a Record whose value type is not "string" - an internal derivation table, not a class lookup', () => {
    const src = stripComments(`
      const DEFAULT_TONE: Record<ButtonStructure, ButtonTone> = { solid: "brand", outline: "neutral" }
      const LEGACY_PADDING: Record<"none" | "sm" | "md" | "lg", PadStep> = { none: 0, sm: 4, md: 6, lg: 8 }
    `);
    expect(extractRecordLookupBlocks(src)).toEqual([]);
  });

  it('resolves a nested-generic Record<Key, string> type argument - the modal.tsx shape', () => {
    const src = stripComments(`
      const SIZE: Record<NonNullable<ModalProps['size']>, string> = {
        sm: 'max-w-md', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl',
      };
      function Modal({ size = 'md' }) {
        return <div className={cn(SIZE[size], 'max-h-[90vh]')} />;
      }
    `);
    const [block] = extractRecordLookupBlocks(src);
    expect(block!.varName).toBe('SIZE');
    expect(block!.propName).toBe('size');
    expect(block!.values).toEqual(['sm', 'md', 'lg', 'xl']);
  });

  it('resolves the first identifier in a fallback-expression bracket usage - the card.tsx padX/padY shape', () => {
    const src = stripComments(`
      const PAD_X: Record<PadStep, string> = { 0: "px-0", 6: "px-6" }
      function padClasses(pad, padX, padY) {
        return \`\${PAD_X[padX ?? pad]}\`
      }
    `);
    const [block] = extractRecordLookupBlocks(src);
    expect(block!.varName).toBe('PAD_X');
    expect(block!.propName).toBe('padX');
  });

  it('skips a Record already consumed as a cva identifier value rather than reporting it as an orphan axis - the surface.tsx shape', () => {
    const src = stripComments(`
      const SURFACE_TONE_CLASSES: Record<SurfaceTone, string> = {
        light: "",
        dark: "bg-surface-dark text-on-dark",
      }
      const surfaceVariants = cva("", {
        variants: { tone: SURFACE_TONE_CLASSES },
      })
    `);
    // Not yielded at all - extractCvaBlocks + resolveObjectLiteralByIdentifier
    // already walk this same Record as part of surfaceVariants' own `tone`
    // variant (see the cva detector's own asserted example above), under the
    // real prop name `tone`. Yielding it a second time here would either
    // double-count the same demand or, since it is never indexed with
    // `NAME[prop]` bracket syntax, misreport it as unresolved.
    expect(extractRecordLookupBlocks(src)).toEqual([]);
  });

  it('records a null propName - an unresolved axis - when a Record is neither bracket-indexed nor cva-consumed, rather than silently dropping it', () => {
    const src = stripComments(`
      const MYSTERY_LOOKUP: Record<"a" | "b", string> = { a: "x", b: "y" }
    `);
    const [block] = extractRecordLookupBlocks(src);
    expect(block!.varName).toBe('MYSTERY_LOOKUP');
    expect(block!.propName).toBeNull();
    expect(block!.values).toEqual(['a', 'b']);
  });

  it('end to end: a record-lookup axis with a story that covers every value reports zero gaps, one that is missing a value reports exactly that value', () => {
    const covered = findCoveredValues(
      `export const SizeXs: Story = { args: { width: 'xs' } };
       export const SizeSm: Story = { args: { width: 'sm' } };
       export const SizeLg: Story = { args: { width: 'lg' } };`,
      'width',
    );
    const values = ['xs', 'sm', 'md', 'lg'];
    const gaps = values.filter((v) => !covered.has(v));
    // "md" is the default, set only in a Default story this fixture omits -
    // the one value this deliberately-incomplete fixture must report missing.
    expect(gaps).toEqual(['md']);
  });
});
