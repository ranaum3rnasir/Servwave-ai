/* =============================================================================
   Autofocus guard (mobile slice 24, rubric KB-08) - zero tolerance.

   A field that focuses itself on a phone or tablet opens the on-screen keyboard
   over the dialog, popover or page it sits in. Every JSX `autoFocus` therefore
   goes through `canAutoFocus()` (src/ui-kit/lib/autoFocus.ts), which is false on
   a coarse primary pointer:

     <Input autoFocus />                                   FAIL
     <Input autoFocus={open} />                            FAIL
     <Input autoFocus={canAutoFocus()} />                  pass
     <Input autoFocus={editing === 'name' && canAutoFocus()} />   pass

   The overlay primitives' own "focus the first field on open" is gated in the
   primitives (touchSafeOpenAutoFocus) and tested in touch-autofocus.test.tsx.
   ============================================================================= */
import { describe, it, expect } from 'vitest';
import { sourceFiles } from './scan';

/** Files the guard does not read, each with the reason. Keep this short. */
const EXEMPT: Record<string, string> = {
  'components/copilot/Composer.tsx': 'copilot is out of scope for the mobile programme',
  'components/copilot/CopilotPanel.tsx': 'copilot is out of scope for the mobile programme',
  'components/copilot/CopilotSheet.tsx': 'copilot is out of scope for the mobile programme',
};

/**
 * Every JSX `autoFocus` attribute that is not gated by `canAutoFocus()`.
 * A prop declaration (`autoFocus?: boolean`) or a destructuring default
 * (`autoFocus = true,`) is not an attribute and is skipped.
 */
export function findUngatedAutoFocus(src: string): Array<{ line: number; token: string }> {
  const out: Array<{ line: number; token: string }> = [];
  const re = /(?<![\w.?/])autoFocus\b(?!\s*\??:)(?!\s*=\s*(?:true|false)\s*[,}])/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const at = m.index;
    const lineStart = src.lastIndexOf('\n', at - 1) + 1;
    const head = src.slice(lineStart, at).trimStart();
    if (/^(\/\/|\/\*|\*)/.test(head)) continue;
    // A destructured or shorthand prop name (`{ autoFocus }`, `autoFocus,`) is not an attribute.
    const after = src.slice(at + 'autoFocus'.length);
    if (/^\s*[,}]/.test(after)) continue;
    let value = '';
    const eq = /^\s*=\s*\{/.exec(after);
    if (eq) {
      let depth = 1;
      let i = eq[0].length;
      for (; i < after.length && depth > 0; i++) {
        if (after[i] === '{') depth++;
        else if (after[i] === '}') depth--;
      }
      value = after.slice(eq[0].length, i - 1);
      // Resume after the value, so a prop named autoFocus inside it is not read as an attribute.
      re.lastIndex = at + 'autoFocus'.length + i;
    }
    if (value.includes('canAutoFocus()')) continue;
    const line = src.slice(0, at).split('\n').length;
    out.push({ line, token: value ? `autoFocus={${value.trim()}}` : 'autoFocus' });
  }
  return out;
}

const tokens = (src: string) => findUngatedAutoFocus(src).map((o) => o.token);

function scan(): string[] {
  const out: string[] = [];
  for (const [file, src] of sourceFiles()) {
    if (!file.endsWith('.tsx') || file in EXEMPT) continue;
    for (const o of findUngatedAutoFocus(src)) out.push(`${file}:${o.line} ${o.token}`);
  }
  return out;
}

describe('autofocus guard (mobile slice 24, KB-08)', () => {
  it('fires on a bare or condition-only autoFocus', () => {
    expect(tokens('<Input autoFocus />')).toEqual(['autoFocus']);
    expect(tokens('<input\n  autoFocus\n  value={v}\n/>')).toEqual(['autoFocus']);
    expect(tokens('<Input autoFocus={open} />')).toEqual(['autoFocus={open}']);
    expect(tokens("<Input autoFocus={editField === 'name'} />")).toEqual(["autoFocus={editField === 'name'}"]);
    expect(tokens('<Composer autoFocus />')).toEqual(['autoFocus']);
  });

  it('stays quiet on a gated autoFocus, a prop type and a destructuring default', () => {
    expect(tokens('<Input autoFocus={canAutoFocus()} />')).toEqual([]);
    expect(tokens("<Input autoFocus={editField === 'name' && canAutoFocus()} />")).toEqual([]);
    expect(tokens('type P = { autoFocus?: boolean };')).toEqual([]);
    expect(tokens('function F({ autoFocus = true, label }: P) {}')).toEqual([]);
    expect(tokens('// an <Input autoFocus /> in a comment')).toEqual([]);
  });

  it('no field in the app focuses itself on a coarse pointer', () => {
    expect(scan()).toEqual([]);
  });
});
