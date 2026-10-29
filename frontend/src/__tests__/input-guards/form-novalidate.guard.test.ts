import { describe, it, expect } from 'vitest';
import { sourceFiles } from './scan';

/**
 * Mobile slice F23a (follow-up to slice 23). Every app <form> carries `noValidate`.
 *
 * The app's schemas own validation and render their messages inline. Without
 * `noValidate`, a `type="email"` field (any field of kind "email") makes the browser
 * check the form first: it shows its own "Please include an '@'" popup, never fires
 * onSubmit, and the inline message never appears (the #260 trap the invoice form
 * guards). Email fields also arrive through shared components (customer pickers,
 * recipient chips), so a per-field rule cannot see them from the form's file; the rule
 * is therefore on the form itself.
 *
 * Reads each `<form ...>` opening tag (to its closing `>` at brace depth 0) and fails
 * when `noValidate` is not among its attributes.
 */
function openingTag(src: string, start: number): string {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0 && src[i - 1] !== '=') return src.slice(start, i + 1);
  }
  return src.slice(start);
}

export function findFormsWithoutNoValidate(files: Array<readonly [string, string]>): string[] {
  const out: string[] = [];
  for (const [path, src] of files) {
    if (!path.endsWith('.tsx')) continue;
    for (const m of src.matchAll(/<form(?=[\s>])/g)) {
      const lineStart = src.lastIndexOf('\n', m.index - 1) + 1;
      if (/^\s*(\/\/|\/?\*)/.test(src.slice(lineStart, m.index))) continue; // a doc comment's example
      const tag = openingTag(src, m.index);
      if (!/\bnoValidate\b/.test(tag)) out.push(`${path}:${src.slice(0, m.index).split('\n').length}`);
    }
  }
  return out;
}

describe('every app <form> leaves validation to the app (noValidate)', () => {
  it('the scanner reports a bare form and accepts a noValidate one', () => {
    const bare = [['a.tsx', 'const x = <form onSubmit={() => (1 > 0)} className="a">\n</form>;'] as const];
    const ok = [['b.tsx', 'const x = (\n  <form\n    noValidate\n    onSubmit={go}\n  >\n  </form>\n);'] as const];
    expect(findFormsWithoutNoValidate(bare)).toEqual(['a.tsx:1']);
    expect(findFormsWithoutNoValidate(ok)).toEqual([]);
  });

  it('no form in src/ is missing noValidate', () => {
    // The copilot's composer is out of scope: the copilot is not live and is not changed by
    // this programme. Its form holds one plain textarea, so it has no browser check to trip.
    const files = sourceFiles().filter(([path]) => !path.startsWith('components/copilot/'));
    expect(findFormsWithoutNoValidate(files)).toEqual([]);
  });
});
