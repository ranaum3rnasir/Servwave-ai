/* =============================================================================
   Accessible-name scanner (mobile slice 25, rubric A11Y-03).

   The kit and legacy `Button` refuse an unnamed `size="icon"` / `size="icon-sm"`
   at the type level (src/components/ui/__tests__/iconButtonName.test.tsx). This
   scanner covers what the type check cannot see:

   - a raw `<button>` whose only content is lucide icons, with no `aria-label`
     or `aria-labelledby`: a screen reader announces it as just "button";
   - a `<Checkbox>`, `<Switch>` or native checkbox/radio with no `aria-label`,
     `aria-labelledby` or `id` (for a `<label htmlFor>`), and no enclosing
     `<label>`: announced as "checkbox" / "switch" with no idea what it sets.

   A control hidden from assistive tech (`aria-hidden="true"`) needs no name.
   ============================================================================= */

export interface Unnamed {
  /** `<button>` (icon only), `<Checkbox>`, `<Switch>` or `<input type=checkbox|radio>`. */
  token: string;
  line: number;
}

const lineOf = (src: string, index: number) => src.slice(0, index).split('\n').length;

/** The opening tag starting at `start` (`<` ... `>`), skipping `>` inside `{...}`. */
function openingTag(src: string, start: number): string {
  let depth = 0;
  for (let i = start + 1; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return src.slice(start, i + 1);
  }
  return src.slice(start);
}

/** A match inside a `//`, `/* * /` or `{/* * /}` comment line is prose, not JSX. */
function inComment(src: string, index: number): boolean {
  const head = src.slice(src.lastIndexOf('\n', index - 1) + 1, index).trimStart();
  return /^(\/\/|\/\*|\*|\{\s*\/\*)/.test(head);
}

const NAMED = /\saria-label(?:ledby)?=/;
const HIDDEN = /\saria-hidden=(?:"true"|\{true\})/;

/** Names this file imports from lucide-react (the app's icon set). */
function lucideIcons(src: string): Set<string> {
  const names = new Set<string>();
  const re = /import\s*\{([^}]*)\}\s*from\s*["']lucide-react["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    for (const part of m[1]!.split(',')) {
      const local = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (local && /^[A-Z]/.test(local)) names.add(local);
    }
  }
  return names;
}

/** True when the JSX between a button's tags is nothing but lucide icon elements. */
function iconOnly(body: string, icons: Set<string>): boolean {
  let rest = body.replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
  let sawIcon = false;
  // Self-closing icon elements, also inside a `{cond ? <A /> : <B />}` switch.
  rest = rest.replace(/<([A-Z]\w*)\b[^<>]*?\/>/g, (whole, tag: string) => {
    if (!icons.has(tag)) return whole;
    sawIcon = true;
    return '';
  });
  rest = rest.replace(/\{\s*[\w.!]+\s*\?\s*:\s*\}/g, '').replace(/\s+/g, '');
  return sawIcon && rest === '';
}

export function findUnnamedControls(src: string): Unnamed[] {
  const out: Unnamed[] = [];
  const icons = lucideIcons(src);

  for (const m of src.matchAll(/<button\b/g)) {
    if (inComment(src, m.index!)) continue;
    const tag = openingTag(src, m.index!);
    if (tag.endsWith('/>') || NAMED.test(tag) || HIDDEN.test(tag)) continue;
    const bodyStart = m.index! + tag.length;
    const end = src.indexOf('</button>', bodyStart);
    if (end < 0) continue;
    if (iconOnly(src.slice(bodyStart, end), icons)) out.push({ token: '<button> (icon only)', line: lineOf(src, m.index!) });
  }

  for (const m of src.matchAll(/<(Checkbox|Switch|input)\b/g)) {
    if (inComment(src, m.index!)) continue;
    const tag = openingTag(src, m.index!);
    const el = m[1]!;
    if (el === 'input' && !/type=["'{]?["']?(checkbox|radio)/.test(tag)) continue;
    if (NAMED.test(tag) || HIDDEN.test(tag) || /\sid=/.test(tag)) continue;
    // Wrapped in a <label> (or the kit <Label>) that is still open here.
    const before = src.slice(Math.max(0, m.index! - 600), m.index!);
    const open = Math.max(before.lastIndexOf('<label'), before.lastIndexOf('<Label'));
    const close = Math.max(before.lastIndexOf('</label>'), before.lastIndexOf('</Label>'));
    if (open > close) continue;
    out.push({ token: el === 'input' ? '<input type=checkbox|radio>' : `<${el}>`, line: lineOf(src, m.index!) });
  }
  return out;
}
