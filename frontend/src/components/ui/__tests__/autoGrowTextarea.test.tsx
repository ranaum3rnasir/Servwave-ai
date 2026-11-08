/**
 * `AutoGrowTextarea` (#2008) — a thin wrapper over the ui-kit's auto-growing
 * `Textarea` (`@/ui-kit/components/ui/textarea`, `[field-sizing:content]`) that adds a
 * growth-cap class so the box stops growing past ~40vh and scrolls internally instead of
 * running away unbounded. See `frontend/src/components/jobs/items/ScopeOfWorkCard.tsx` and
 * `AddLineDialog.tsx` for the four call sites this replaces the legacy
 * `@/components/ui/textarea` import at.
 */
import { createRef } from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AutoGrowTextarea } from '@/components/ui/autoGrowTextarea';

describe('AutoGrowTextarea', () => {
  it('emits the auto-grow marker and a default growth-cap class', () => {
    render(<AutoGrowTextarea aria-label="Description" />);
    const textarea = screen.getByLabelText('Description');
    expect(textarea.className).toMatch(/field-sizing:content/);
    expect(textarea.className).toMatch(/max-h-\[40vh\]/);
    expect(textarea.className).toMatch(/overflow-y-auto/);
  });

  it('pins a min-h-16 resting floor, never a fixed h-*', () => {
    render(<AutoGrowTextarea aria-label="Description" />);
    const textarea = screen.getByLabelText('Description');
    expect(textarea.className).toMatch(/min-h-16/);
    expect(textarea.className).not.toMatch(/\bmin-h-19\b/);
    expect(textarea.className).not.toMatch(/(?<!min-)\bh-\d/);
  });

  it("a caller's className merges without dropping the auto-grow marker or the cap", () => {
    render(<AutoGrowTextarea aria-label="Description" className="mb-3" />);
    const textarea = screen.getByLabelText('Description');
    expect(textarea.className).toMatch(/field-sizing:content/);
    expect(textarea.className).toMatch(/max-h-\[40vh\]/);
    expect(textarea.className).toMatch(/mb-3/);
  });

  it('passes arbitrary textarea props through untouched', () => {
    const onChange = vi.fn();
    const ref = createRef<HTMLTextAreaElement>();
    render(
      <AutoGrowTextarea
        id="edit-description"
        maxLength={50000}
        placeholder="Optional detail"
        aria-label="Description"
        onChange={onChange}
        ref={ref}
      />,
    );
    const textarea = screen.getByLabelText('Description') as HTMLTextAreaElement;
    expect(textarea.id).toBe('edit-description');
    expect(textarea.maxLength).toBe(50000);
    expect(textarea.placeholder).toBe('Optional detail');
    expect(ref.current).toBe(textarea);
  });
});
