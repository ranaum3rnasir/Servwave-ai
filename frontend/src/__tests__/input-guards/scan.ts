/* =============================================================================
   Source scanner for the text entry guards (mobile slice 14).

   iOS zooms the page when a focused text field's text is under 16 px, and the
   zoom does not undo itself. Every text entry primitive therefore adds
   `mobile:!text-base` (src/ui-kit/lib/textEntry.ts): 16 px everywhere except md-and-up
   with a fine pointer, where each call site keeps exactly the size it already
   had. That class is the "touch floor".

   - findSmallTextEntrySizes (KB-01): a font size under 16 px that reaches a
     phone or tablet:
       * on a raw element (`<input>`, `<textarea>`, `<select>`, cmdk's input)
         or on a wrapper component that hands its className to one, any
         size under 16 px with no touch floor beside it;
       * on ANY text entry element, floored primitives and their wrappers
         included (`<Input>`, `<SelectTrigger>`, `<SelectField>`...), a size
         under 16 px behind a touch variant (`mobile:`, `touch:`, `max-md:`),
         which would beat the floor.
   - findUnreplacedOutlineRemovals (A11Y-06): `outline-none` on a text entry
     element with no focus indicator in its place.

   Which components are text entry elements is DISCOVERED, not listed: a
   component is a wrapper when it renders a raw text entry element (or another
   wrapper) and passes its own `className` / `inputClassName` into that tag's
   classes. It is floored when that tag carries the touch floor (or is itself
   floored); otherwise a caller's small size reaches the raw element, and the
   caller is reported. So a new `<MyInput className="text-xs">` wrapper is
   caught at its call sites without anyone adding it to a list.

   Only `className` and `inputClassName` attributes are read, at the tag's own
   brace depth, so a class on nested JSX passed through a prop (`label={<span
   className="text-xs">}`) is not the field's. Classes assembled in a variable
   elsewhere are out of reach of a source scan; the mobile gate measures those
   at runtime (frontend/e2e/mobile, check `inputFont`).
   ============================================================================= */
import { sourceFiles } from '../layout-guards/scan';

export { sourceFiles };

export interface Offence {
  /** `<Tag> token`, e.g. `<input> text-sm`. */
  token: string;
  line: number;
}

/**
 * Elements that draw a text field (or a select trigger) themselves. Any other
 * tag with `role="combobox"` counts too (the kit Combobox's trigger button).
 */
export const RAW_TAGS = ['input', 'textarea', 'select', 'CommandPrimitive.Input', 'SelectPrimitive.Trigger'] as const;
const COMBOBOX_ROLE = /\srole=["']combobox["']/;
const CLASS_ATTRS = ['className', 'inputClassName'];

/** iOS zooms a focused field whose text is under this. */
export const MIN_TOUCH_PX = 16;

export type EntryKind = 'raw' | 'floored';
/** Component name -> whether a caller's small size reaches a raw field ('raw') or is floored. */
export type EntryMap = ReadonlyMap<string, EntryKind>;

export function lineOf(src: string, index: number): number {
  return src.slice(0, index).split('\n').length;
}

export function isCommentLine(src: string, index: number): boolean {
  const start = src.lastIndexOf('\n', index - 1) + 1;
  const head = src.slice(start, index).trimStart();
  return /^(\/\/|\/\*|\*|\{\s*\/\*)/.test(head);
}

/** The opening tag's source, up to its `>` at brace depth 0. */
export function openingTag(src: string, start: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start + 1; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (depth === 0 && (c === '"' || c === "'")) quote = c;
    else if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (depth === 0 && c === '>') return src.slice(start, i + 1);
  }
  return src.slice(start);
}

/**
 * The class attributes of the tag that opens at `start`, each as raw source
 * (a string literal's contents, or a `{...}` expression). Stops at the tag's
 * closing `>` at brace depth 0; attributes inside a nested `{...}` are skipped.
 */
export function classAttributes(src: string, start: number): string[] {
  const tag = openingTag(src, start);
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  for (let i = 1; i < tag.length; i++) {
    const c = tag[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (depth === 0 && (c === '"' || c === "'")) {
      quote = c;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    if (depth !== 0 || !/\s/.test(tag[i - 1] ?? '')) continue;
    const name = CLASS_ATTRS.find((a) => tag.startsWith(`${a}=`, i));
    if (!name) continue;
    const valueAt = i + name.length + 1;
    const open = tag[valueAt];
    if (open === '"' || open === "'") {
      const end = tag.indexOf(open, valueAt + 1);
      out.push(tag.slice(valueAt + 1, end));
      i = end;
    } else if (open === '{') {
      let d = 0;
      let end = valueAt;
      for (; end < tag.length; end++) {
        if (tag[end] === '{') d++;
        else if (tag[end] === '}' && --d === 0) break;
      }
      out.push(tag.slice(valueAt, end + 1));
      i = end;
    }
  }
  return out;
}

/** `<input type="...">` values that draw no text field (the gate's `inputFont` check skips them too). */
export const NOT_TEXT_TYPE = /(^|\s)type=["'](hidden|checkbox|radio|range|file|color|submit|button|reset)["']/;

export const TAG_NAME = /<([A-Za-z][\w]*(?:\.[A-Z]\w*)?)(?=[\s/>])/g;

interface EntryTag {
  tag: string;
  attrs: string[];
  index: number;
}

/** Every opening tag in `src` that is a raw text field or a known text entry component. */
function textEntryTags(src: string, known: EntryMap): EntryTag[] {
  const out: EntryTag[] = [];
  TAG_NAME.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_NAME.exec(src))) {
    const tag = m[1]!;
    const raw = (RAW_TAGS as readonly string[]).includes(tag);
    if (!raw && !known.has(tag) && !/^[A-Z]/.test(tag)) continue;
    if (isCommentLine(src, m.index)) continue;
    const opening = openingTag(src, m.index);
    if (!raw && !known.has(tag) && !COMBOBOX_ROLE.test(opening)) continue;
    if (tag === 'input' && NOT_TEXT_TYPE.test(opening)) continue;
    out.push({ tag, attrs: classAttributes(src, m.index), index: m.index });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sizes

/** A font-size utility with its variant chain: `md:text-sm` -> ['md:', 'sm']. */
const SIZE_RE = /(?<![\w\-[:/!])((?:[\w\-[\]&=.@()>*]+:)*)!?text[-](xs|sm|base|lg|[2-9]?xl|3xs|2xs|\[(\d*\.?\d+)(px|rem)\])(?![\w\-\]/])/g;

/** Variants for parts that are not the field's own text. */
const NOT_FIELD_TEXT = /(^|:)(placeholder|file|before|after|marker|selection):$/;
/** Variants that apply on a phone or tablet and come after the floor in the stylesheet. */
const TOUCH_VARIANT = /(^|:)(mobile|touch|max-[\w[\]-]+):/;

interface SizeToken {
  text: string;
  variants: string;
  important: boolean;
  px: number;
}

function sizeTokens(value: string): SizeToken[] {
  const out: SizeToken[] = [];
  SIZE_RE.lastIndex = 0;
  let k: RegExpExecArray | null;
  while ((k = SIZE_RE.exec(value))) {
    const variants = k[1] ?? '';
    if (NOT_FIELD_TEXT.test(variants)) continue;
    const step = k[2]!;
    let px: number;
    if (k[3]) px = k[4] === 'rem' ? parseFloat(k[3]) * 16 : parseFloat(k[3]);
    else px = ({ '3xs': 8, '2xs': 10, xs: 12, sm: 14, base: 16 } as Record<string, number>)[step] ?? 18;
    out.push({ text: k[0], variants, important: k[0].includes('!'), px });
  }
  return out;
}

/**
 * The touch floor: an important size of 16 px or more behind `mobile:`
 * (`mobile:!text-base`). Important, because `md:`/`lg:` come later in the
 * stylesheet and a plain `mobile:text-base` loses to them on an iPad.
 */
function hasTouchFloor(attrs: string[]): boolean {
  return attrs.some((a) => sizeTokens(a).some((t) => /(^|:)mobile:$/.test(t.variants) && t.important && t.px >= MIN_TOUCH_PX));
}

/** A caller's own size of 16 px or more at every width: the primitives leave the floor out then. */
function hasLargeUnprefixedSize(attrs: string[]): boolean {
  return attrs.some((a) => sizeTokens(a).some((t) => t.variants === '' && t.px >= MIN_TOUCH_PX));
}

// ---------------------------------------------------------------------------
// Wrapper discovery

/** A PascalCase component definition: `function Foo(`, `const Foo = ...`. */
const COMPONENT_DEF = /(?:^|\n)[ \t]*(?:export\s+)?(?:default\s+)?(?:function\s+([A-Z][a-z]\w*)\s*[(<]|const\s+([A-Z][a-z]\w*)\s*(?::[^=\n]+)?=)/g;

function componentAt(defs: Array<[number, string]>, index: number): string | null {
  let name: string | null = null;
  for (const [at, n] of defs) {
    if (at > index) break;
    name = n;
  }
  return name;
}

const FORWARDS_CLASS = /\b(className|inputClassName)\b/;

/**
 * Every component in `files` that hands its className to a text entry element,
 * and whether that element floors a caller's small size. Iterated to a fixed
 * point, so a wrapper of a wrapper is found too. A name defined twice with
 * different answers counts as 'raw' (the strict one).
 */
export function discoverTextEntryComponents(files: ReadonlyArray<readonly [string, string]> = sourceFiles()): Map<string, EntryKind> {
  const known = new Map<string, EntryKind>();
  const tsx = files.filter(([f]) => f.endsWith('.tsx'));
  const defsByFile = new Map<string, Array<[number, string]>>();
  for (const [file, src] of tsx) {
    const defs: Array<[number, string]> = [];
    COMPONENT_DEF.lastIndex = 0;
    let d: RegExpExecArray | null;
    while ((d = COMPONENT_DEF.exec(src))) defs.push([d.index, (d[1] ?? d[2])!]);
    defsByFile.set(file, defs);
  }
  for (let round = 0; round < 10; round++) {
    const next = new Map<string, EntryKind>();
    for (const [file, src] of tsx) {
      const defs = defsByFile.get(file)!;
      for (const { tag, attrs, index } of textEntryTags(src, known)) {
        if (!attrs.some((a) => a.startsWith('{') && FORWARDS_CLASS.test(a))) continue;
        const owner = componentAt(defs, index);
        if (!owner || owner === tag) continue;
        const floored = known.get(tag) === 'floored' || hasTouchFloor(attrs);
        const kind: EntryKind = floored ? 'floored' : 'raw';
        next.set(owner, next.get(owner) === 'raw' ? 'raw' : kind);
      }
    }
    const same = next.size === known.size && [...next].every(([k, v]) => known.get(k) === v);
    known.clear();
    for (const [k, v] of next) known.set(k, v);
    if (same) break;
  }
  return known;
}

// ---------------------------------------------------------------------------
// KB-01: text under 16 px on a phone or tablet

export function findSmallTextEntrySizes(src: string, known: EntryMap): Offence[] {
  const out: Offence[] = [];
  for (const { tag, attrs, index } of textEntryTags(src, known)) {
    const flooredByComponent = known.get(tag) === 'floored' && !hasLargeUnprefixedSize(attrs);
    const floored = flooredByComponent || hasTouchFloor(attrs);
    for (const value of attrs) {
      for (const t of sizeTokens(value)) {
        if (t.px >= MIN_TOUCH_PX) continue;
        if (floored && !TOUCH_VARIANT.test(t.variants)) continue;
        out.push({ token: `<${tag}> ${t.text}`, line: lineOf(src, index) });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// A11Y-06: outline removed with nothing in its place

const OUTLINE_NONE = /(?<![\w\-[:])outline-none(?![\w-])/;
const FOCUS_VARIANTS = new Set(['focus', 'focus-visible', 'focus-within']);
const DRAWING_FAMILIES = new Set(['ring', 'outline', 'border', 'shadow']);
const DRAWS_NOTHING = new Set(['none', '0', 'transparent']);

/**
 * True when a class string gives a focus style that draws something: a ring,
 * an outline, a border or a shadow under focus / focus-visible / focus-within
 * (not `focus:ring-0`, `focus-visible:outline-none` or a bare ring offset).
 */
export function drawsFocusIndicator(classes: string): boolean {
  return classes.split(/[\s"'`]+/).some((cls) => {
    const at = cls.lastIndexOf(':');
    if (at < 0 || !cls.slice(0, at).split(':').some((v) => FOCUS_VARIANTS.has(v))) return false;
    const util = cls.slice(at + 1);
    const dash = util.indexOf('-');
    const family = dash < 0 ? util : util.slice(0, dash);
    const value = dash < 0 ? '' : util.slice(dash + 1);
    return DRAWING_FAMILIES.has(family) && !DRAWS_NOTHING.has(value) && !value.startsWith('offset');
  });
}

/**
 * `outline-none` on a text entry element is fine only when the SAME string
 * literal also gives a focus style. Per literal, not per attribute: in
 * `cn(base, ghost && "border-0 ... outline-none")` the base string's focus
 * border is on a border the ghost literal just removed.
 */
export function findUnreplacedOutlineRemovals(src: string, known: EntryMap): Offence[] {
  const out: Offence[] = [];
  for (const { tag, attrs, index } of textEntryTags(src, known)) {
    for (const value of attrs) {
      const literals = value.startsWith('{') ? value.match(/"[^"]*"|'[^']*'|`[^`]*`/g) ?? [] : [value];
      for (const literal of literals) {
        if (OUTLINE_NONE.test(literal) && !drawsFocusIndicator(literal)) {
          out.push({ token: `<${tag}> outline-none`, line: lineOf(src, index) });
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Report

/** `file:line <Tag> token` for every offence in the tree, minus exempt files. */
export function scanTree(
  finder: (src: string, known: EntryMap) => Offence[],
  exempt: Readonly<Record<string, string>> = {},
  files: ReadonlyArray<readonly [string, string]> = sourceFiles(),
): string[] {
  const known = discoverTextEntryComponents(files);
  const out: string[] = [];
  for (const [file, src] of files) {
    if (!file.endsWith('.tsx') || file in exempt) continue;
    for (const o of finder(src, known)) out.push(`${file}:${o.line} ${o.token}`);
  }
  return out;
}
