/// <reference types="@testing-library/jest-dom/vitest" />
import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import type { WorkflowCatalog } from '@/lib/api/workflows';

import MergeFieldChips from '../components/mergeFieldChips';

/**
 * "If empty, fill with" on the ROUTED merge-field chips.
 *
 * Spec: md_files/specs/scheduling/2026-09-13-customer-scheduling-notifications-and-visit-milestones.md
 * Each chip keeps its tap-to-insert behaviour and gains a small trailing icon. Clicking the icon
 * opens a compact popover with the header "If empty, fill with" and one single-line text field,
 * nothing else. The chip's own click still inserts the field and never opens the popover.
 */

const CATALOG = {
  merge_field_labels: {
    'job.number': 'Job number',
    'technician.names': 'Technician name(s)',
  },
} as unknown as WorkflowCatalog;

/** The forms own the fallback map and re-render the chips with it, so the harness does too. */
function Harness({
  initial,
  onInsert,
  onFallbackChange,
}: {
  initial: Record<string, string>;
  onInsert: (field: string) => void;
  onFallbackChange: (field: string, value: string) => void;
}) {
  const [fallbacks, setFallbacks] = useState(initial);
  return (
    <MergeFieldChips
      fields={['job.number', 'technician.names']}
      used={new Set()}
      catalog={CATALOG}
      onInsert={onInsert}
      fallbacks={fallbacks}
      onFallbackChange={(field, value) => {
        setFallbacks((prev) => ({ ...prev, [field]: value }));
        onFallbackChange(field, value);
      }}
    />
  );
}

function setup(fallbacks: Record<string, string> = {}) {
  const onInsert = vi.fn();
  const onFallbackChange = vi.fn();
  renderWithProviders(<Harness initial={fallbacks} onInsert={onInsert} onFallbackChange={onFallbackChange} />);
  return { onInsert, onFallbackChange };
}

describe('mergeFieldChips (v2) - "If empty, fill with"', () => {
  it('gives every chip a trailing icon that opens the popover with the header and one text field', async () => {
    const user = userEvent.setup();
    setup({ 'technician.names': 'Our team' });

    // One icon per chip, named after the chip it belongs to.
    expect(screen.getByRole('button', { name: 'Job number: if empty, fill with' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Technician name(s): if empty, fill with' }));

    const popover = await screen.findByRole('dialog');
    expect(within(popover).getByText('If empty, fill with')).toBeInTheDocument();
    const field = within(popover).getByRole('textbox');
    expect(field).toHaveValue('Our team');
    // Nothing else: one text field, no buttons, no second line of copy.
    expect(within(popover).getAllByRole('textbox')).toHaveLength(1);
    expect(within(popover).queryAllByRole('button')).toHaveLength(0);
  });

  it('reports each keystroke as the field key and the new text', async () => {
    const user = userEvent.setup();
    const { onFallbackChange } = setup({ 'technician.names': '' });

    await user.click(screen.getByRole('button', { name: 'Technician name(s): if empty, fill with' }));
    await user.type(await screen.findByRole('textbox'), 'the crew');

    expect(onFallbackChange).toHaveBeenLastCalledWith('technician.names', 'the crew');
  });

  it('keeps the chip itself as an insert: clicking the label inserts and opens nothing', async () => {
    const user = userEvent.setup();
    const { onInsert } = setup();

    await user.click(screen.getByRole('button', { name: /^Technician name\(s\)$/ }));

    expect(onInsert).toHaveBeenCalledWith('technician.names');
    expect(screen.queryByRole('dialog')).toBeNull();

    // The popover is right there behind the chip's own icon, so "opens nothing" above is the
    // label declining to open it, not a chip that has no popover to open.
    await user.click(screen.getByRole('button', { name: 'Technician name(s): if empty, fill with' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(onInsert).toHaveBeenCalledTimes(1);
  });

  it('clicking the icon never inserts the field', async () => {
    const user = userEvent.setup();
    const { onInsert } = setup();

    await user.click(screen.getByRole('button', { name: 'Job number: if empty, fill with' }));

    expect(onInsert).not.toHaveBeenCalled();
  });
});
