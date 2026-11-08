/**
 * #439: Select dropdown hover/selection highlight must use the ocean
 * primary-subtle tint, not the near-invisible shadcn slate-100 default.
 *
 * The shared SelectItem (components/ui/select.tsx) is the single primitive every
 * Select in the app renders through (Tax Rate dropdown, customer/job/inventory/
 * schedule forms, etc.). This is a regression guard so the highlight can't
 * silently revert to `focus:bg-slate-100`.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from './helpers';
import { Select, SelectContent, SelectItem } from '@/components/ui/select';

// Radix Select touches a few DOM APIs jsdom doesn't implement.
beforeAll(() => {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {};
  }
});

describe('SelectItem highlight (#439)', () => {
  it('uses the ocean primary-subtle tint for focus + checked, not slate-100', () => {
    renderWithProviders(
      <Select open value="UT">
        <SelectContent>
          <SelectItem value="UT">Utah</SelectItem>
        </SelectContent>
      </Select>
    );

    const option = screen.getByRole('option', { name: 'Utah' });
    const className = option.getAttribute('class') ?? '';

    expect(className).toContain('focus:bg-primary-subtle');
    expect(className).toContain('focus:text-primary');
    expect(className).toContain('data-[state=checked]:bg-primary-subtle');
    expect(className).not.toContain('focus:bg-slate-100');
  });
});
