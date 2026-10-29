/* =============================================================================
   Focus-indicator guard (mobile slice 14, rubric A11Y-06) - zero tolerance.

   A tablet with a keyboard, or switch control on a phone, moves focus between
   fields; a field that removes the browser's outline must draw something in
   its place. On a text entry element, `outline-none` passes only when the same
   class string also gives a focus ring, outline, coloured border or shadow.

   EXEMPT holds the fields whose indicator is drawn by their container (a
   `focus-within:` ring on the box around them), which a tag scan cannot see.
   ============================================================================= */
import { describe, it, expect } from 'vitest';
import { findUnreplacedOutlineRemovals, scanTree, sourceFiles, type EntryMap } from './scan';

const EXEMPT: Record<string, string> = {
  // The chip box around the tag input draws focus-within:border-brand + ring.
  'ui-kit/components/crm/tagInput.tsx': 'container draws a focus-within ring',
  // The title input only exists while editing (it opens focused) and always draws border-primary.
  'features/estimate-workspace/components/EstimateNameTitle.tsx': 'edit-only field with a permanent brand border',
};

const KNOWN: EntryMap = new Map([['Input', 'floored']]);
const tokens = (src: string) => findUnreplacedOutlineRemovals(src, KNOWN).map((o) => o.token);

describe('focus-indicator guard (mobile slice 14, A11Y-06)', () => {
  it('fires on a text field that removes its outline with nothing in its place', () => {
    expect(tokens('<input className="bg-transparent text-base outline-none" />')).toEqual(['<input> outline-none']);
    expect(tokens('<textarea className="resize-none outline-none focus:ring-0" />')).toEqual(['<textarea> outline-none']);
    // A focus border in ANOTHER literal does not count: the ghost literal removed the border.
    expect(
      tokens('<input className={cn("focus-visible:border-primary", ghost && "border-0 p-0 outline-none")} />'),
    ).toEqual(['<input> outline-none']);
    expect(tokens('<CommandPrimitive.Input className={cn("bg-transparent outline-none", className)} />')).toEqual([
      '<CommandPrimitive.Input> outline-none',
    ]);
  });

  it('stays quiet when the same class string draws a focus indicator', () => {
    expect(tokens('<input className="outline-none focus-visible:outline-2 focus-visible:outline-primary" />')).toEqual([]);
    expect(tokens('<Input className="focus-visible:ring-[3px] focus-visible:ring-ring/25 focus-visible:outline-none" />')).toEqual([]);
    expect(tokens('<textarea className="outline-none focus:border-primary" />')).toEqual([]);
    expect(tokens('<input className="outline-none focus-visible:shadow-[inset_0_-2px_0_0_red]" />')).toEqual([]);
    expect(tokens('<div className="outline-none" />')).toEqual([]);
  });

  it('no text field removes its focus outline without a replacement', () => {
    const offenders = scanTree(findUnreplacedOutlineRemovals, EXEMPT);
    expect(
      offenders,
      `Keyboard and switch-control users cannot see which field has focus. Add a focus-visible: outline, ring or border in the same class string:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('a deliberately added outline-none input is reported', () => {
    const planted = [...sourceFiles(), ['pages/Planted.tsx', '<input className="outline-none" />'] as const];
    expect(scanTree(findUnreplacedOutlineRemovals, EXEMPT, planted)).toContain('pages/Planted.tsx:1 <input> outline-none');
  });

  it('every exempt file exists', () => {
    const files = new Set(sourceFiles().map(([f]) => f));
    for (const f of Object.keys(EXEMPT)) expect(files.has(f), f).toBe(true);
  });
});
