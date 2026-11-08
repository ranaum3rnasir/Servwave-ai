/**
 * Kit SelectTrigger - a long selected value truncates before the chevron.
 *
 * On a 375px phone the Caller ID "Organization default" trigger showed a long
 * number name running under and past its chevron: the value span Radix renders
 * (`SelectValue`) is a flex item with the default `min-width: auto`, so it never
 * shrank below its text, and nothing truncated it. The trigger now lets that
 * span shrink and truncates it with an ellipsis. jsdom has no layout, so this
 * pins the classes that do it; the real-browser check is a screenshot.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';

const LONG = '(555) 201-4410 · Main office line that rings the front desk first';

describe('kit SelectTrigger - a long selected value', () => {
  it('lets the value shrink and truncates it, so it never runs under the chevron', () => {
    render(
      <Select value="long">
        <SelectTrigger aria-label="Picker">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="long">{LONG}</SelectItem>
        </SelectContent>
      </Select>,
    );
    const trigger = screen.getByRole('combobox', { name: 'Picker' });
    const classes = (trigger.getAttribute('class') ?? '').split(/\s+/);
    // Radix renders the value as the trigger's one direct <span> child.
    expect(trigger.querySelector(':scope > span')).toHaveTextContent(LONG);
    expect(classes).toContain('[&>span]:min-w-0');
    expect(classes).toContain('[&>span]:truncate');
  });
});

/**
 * A label with no spaces (an email address) has a min-content width as wide as
 * the whole label, and a flex item never shrinks below its min-content width.
 * The item's text span (styled from the item) therefore needs `min-w-0` and
 * `overflow-wrap: anywhere` (`break-word` does not lower min-content) to wrap
 * inside the capped list rather than run past its edge and under the check
 * mark. The app's other Select (components/ui/__tests__/select.test.tsx) pins
 * the same pair and points back here.
 */
describe('kit SelectItem - an unbroken label wraps inside the list', () => {
  it('lets the item text shrink and break anywhere', () => {
    const UNBROKEN = 'dispatch.northeast.region.overflow.queue.longname@example-company.com';
    render(
      <Select defaultOpen>
        <SelectTrigger aria-label="Picker">
          <SelectValue placeholder="Pick one" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="unbroken">{UNBROKEN}</SelectItem>
        </SelectContent>
      </Select>,
    );
    // Radix drops a className given to ItemText, so the item styles its text
    // span (its direct <span> child) instead.
    const option = screen.getByRole('option');
    expect(option.querySelector(':scope > span[id]')).toHaveTextContent(UNBROKEN);
    const classes = (option.getAttribute('class') ?? '').split(/\s+/);
    expect(classes).toContain('[&>span]:min-w-0');
    expect(classes).toContain('[&>span]:[overflow-wrap:anywhere]');
  });
});
