import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { JobNotesPreview } from '@/components/jobs/overview/JobNotesPreview';
import { NoteEditor } from '@/ui-kit/components/crm/noteEditor';

/**
 * Mobile slice 23 staging fix. The note composers' keyboard-shortcut hint is hidden on touch
 * (`touch:!hidden`) and, in NoteEditor, below `sm`. Before the fix the submit button reached the
 * row's right edge only BECAUSE of the hint: `justify-between` spread hint + button, or the hint
 * carried the `ms-auto`. With the hint display:none the button fell to the row's left edge.
 *
 * jsdom has no layout, so this asserts the flex rule that keeps the edge without the hint. The
 * composer's bottom row is the outermost of the unbroken chain of `flex` containers above the
 * button. On the path from the button up to that row, some element must push itself to the end
 * (`ms-auto` / `ml-auto`), or the row must pack to the end (`justify-end`). An `ms-auto` on the
 * hint itself does not count: it is the element that disappears. The rendered right edge is
 * measured by the mobile gate (`field-kinds.spec.ts`, job-detail).
 */
function keepsRightEdgeWithoutHint(button: HTMLElement, hint: HTMLElement): boolean {
  let row: HTMLElement | null = null;
  for (let el = button.parentElement; el?.classList.contains('flex'); el = el.parentElement) row = el;
  if (!row || !row.contains(hint)) throw new Error('the hint and the button share no flex row');
  if (row.classList.contains('justify-end')) return true;
  for (let el: HTMLElement | null = button; el && el !== row; el = el.parentElement) {
    if (el.classList.contains('ms-auto') || el.classList.contains('ml-auto')) return true;
  }
  return false;
}

describe('a note composer keeps its submit button at the right edge when the hint is hidden', () => {
  it('JobNotesPreview (job overview): Add Note', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <JobNotesPreview jobId="job-1" notes={[]} addAffordance="inline-button" canAddNotes />,
    );
    await user.click(screen.getByRole('button', { name: 'Add note' }));
    const hint = screen.getByText('⌘↵ to add');
    expect(hint.className).toContain('touch:!hidden');
    expect(keepsRightEdgeWithoutHint(screen.getByRole('button', { name: 'Add Note' }), hint)).toBe(true);
  });

  it('NoteEditor (ui-kit): Post note', () => {
    render(<NoteEditor authorName="Zz Qa" onSubmit={() => undefined} />);
    const hint = screen.getByText('⌘↵');
    expect(hint.className).toContain('touch:!hidden');
    expect(keepsRightEdgeWithoutHint(screen.getByRole('button', { name: /post note/i }), hint)).toBe(true);
  });
});
