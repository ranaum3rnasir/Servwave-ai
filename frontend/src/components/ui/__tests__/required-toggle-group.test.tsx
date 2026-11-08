/**
 * RequiredToggleGroup — the one rule it exists to encode, exercised through the DOM.
 *
 * Radix's single-select ToggleGroup emits `''` when the active item is re-clicked. A required
 * group must never transition a NON-EMPTY value to empty; a value that is ALREADY empty stays
 * allowed, because "not yet chosen" is a legitimate initial state.
 *
 * Both branches are asserted on what a user can see — which pill reads as selected — and never
 * on whether a handler fired. The guard is a one-line condition that type-checks whether or not
 * it is correct (`?? ''` is the version that looks right and does nothing), so only a test that
 * clicks the active pill and reads the result back can tell the two apart.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';

import { RequiredToggleGroup } from '@/components/ui/required-toggle-group';
import { ToggleGroupItem } from '@/components/ui/toggle-group';

/** A controlled host, because the rule is about what the PARENT is allowed to be told. */
function Harness({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <RequiredToggleGroup value={value} onValueChange={setValue} aria-label="Direction">
        <ToggleGroupItem value="out">Outbound</ToggleGroupItem>
        <ToggleGroupItem value="in">Inbound</ToggleGroupItem>
      </RequiredToggleGroup>
      <p data-testid="value">{value === '' ? '(none)' : value}</p>
    </>
  );
}

const chosen = () => screen.getByTestId('value').textContent;

describe('RequiredToggleGroup', () => {
  it('leaves the value unchanged when the already-active item is clicked again', async () => {
    const user = userEvent.setup();
    render(<Harness initial="" />);

    await user.click(screen.getByText('Outbound'));
    expect(chosen()).toBe('out');

    // The defect: Radix reports '' for this click, and an unguarded handler stores it.
    await user.click(screen.getByText('Outbound'));
    expect(chosen()).toBe('out');
    expect(screen.getByText('Outbound')).toHaveAttribute('data-state', 'on');
  });

  it('changes the value when a different item is clicked', async () => {
    const user = userEvent.setup();
    render(<Harness initial="out" />);

    await user.click(screen.getByText('Inbound'));
    expect(chosen()).toBe('in');
    expect(screen.getByText('Inbound')).toHaveAttribute('data-state', 'on');
    expect(screen.getByText('Outbound')).toHaveAttribute('data-state', 'off');
  });

  it('starts an empty group unchosen and still lets the first click choose', async () => {
    // "Not yet chosen" is a legitimate state for a required group - the form
    // must not answer the question on the user's behalf - but it has to stay
    // fillable. The guard is a transition guard for exactly this reason: a
    // blunter `if (value === '') return` would read as "required" and instead
    // strand the group empty for ever.
    const user = userEvent.setup();
    render(<Harness initial="" />);

    expect(chosen()).toBe('(none)');
    expect(screen.getByText('Outbound')).toHaveAttribute('data-state', 'off');
    expect(screen.getByText('Inbound')).toHaveAttribute('data-state', 'off');

    await user.click(screen.getByText('Inbound'));
    expect(chosen()).toBe('in');
    expect(screen.getByText('Inbound')).toHaveAttribute('data-state', 'on');
  });
});
