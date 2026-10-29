/* =============================================================================
   Keyboard-shortcut hints are not shown on touch (mobile slice 23, KB-05).

   "⌘↵ to send" means nothing on a phone or a tablet's on-screen keyboard. A
   hint for a modifier+Enter shortcut is hidden where the primary pointer is
   coarse: its element carries `touch:!hidden` (important, because `sm:` and
   `md:` display classes come later in the stylesheet and would win).

   The mobile gate checks the rendered result on its touch devices; this guard
   keeps every hint in the source on the rule.
   ============================================================================= */
import { describe, expect, it } from 'vitest';
import { sourceFiles } from './scan';

/** Visible copy for a modifier+Enter shortcut. */
const HINT = /⌘\s*↵|⌘\s*Enter|(Cmd|Ctrl)\s*\+\s*(Enter|↵)/;

function offenders(files: ReadonlyArray<readonly [string, string]>): string[] {
  const out: string[] = [];
  for (const [file, src] of files) {
    if (!file.endsWith('.tsx')) continue;
    src.split('\n').forEach((line, i) => {
      const code = line.trim();
      if (!HINT.test(code) || /^(\/\/|\/\*|\*|\{\s*\/\*)/.test(code)) return;
      // Only copy that renders: JSX text between tags, not an attribute or a string in logic.
      if (!/>[^<>{}]*(⌘|Cmd|Ctrl)[^<>{}]*</.test(code)) return;
      if (!/(^|\s|["'`])touch:!hidden(\s|["'`])/.test(code)) out.push(`${file}:${i + 1}`);
    });
  }
  return out;
}

describe('keyboard-shortcut hints on touch (mobile slice 23)', () => {
  it('fires on a visible ⌘↵ hint with no touch rule, and stays quiet on a hidden one or a comment', () => {
    expect(offenders([['a.tsx', '<span className="text-xs">⌘↵ to send</span>']])).toEqual(['a.tsx:1']);
    expect(offenders([['a.tsx', '<span className="text-[11px]">Cmd + Enter to add</span>']])).toEqual(['a.tsx:1']);
    expect(offenders([['a.tsx', '<span className="hidden sm:inline">⌘↵</span>']])).toEqual(['a.tsx:1']);
    expect(offenders([['a.tsx', '<span className="text-xs touch:!hidden">⌘↵ to send</span>']])).toEqual([]);
    expect(offenders([['a.tsx', '// ⌘↵ submits the note']])).toEqual([]);
    expect(offenders([['a.tsx', '<DropdownMenuShortcut>⌘T</DropdownMenuShortcut>']])).toEqual([]);
  });

  it('no ⌘↵ hint shows on a touch device, anywhere in the app', () => {
    const found = offenders(sourceFiles());
    expect(found, `Add "touch:!hidden" to these shortcut hints:\n${found.join('\n')}`).toEqual([]);
  });
});
