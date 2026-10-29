/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';

import AddStepButton from '../components/addStepButton';

/**
 * The routed v2 twin of components/workflows/AddStepButton.test.tsx.
 *
 * The in-app channel is retired, so the picker an admin actually sees must not
 * offer it. The unrouted v1 picker is asserted separately: both compile, both
 * run, and leaving either one offering the step would keep the retirement
 * cosmetic.
 */

async function openPicker() {
  await userEvent.click(screen.getByRole('button', { name: 'Add a step' }));
  return screen.findByRole('menu', { name: 'Add a step' });
}

describe('addStepButton (v2) - the in-app step is not offered', () => {
  it('offers no in-app option', async () => {
    renderWithProviders(<AddStepButton onPick={vi.fn()} variant="block" />);
    const menu = await openPicker();

    expect(within(menu).queryByText('Notify team')).toBeNull();
    expect(within(menu).queryByText('In-app alert to your staff')).toBeNull();
  });

  // Spec C slice 8: the picker described the text step as "Text the customer", which was the
  // customer-only assumption written down in the first place an admin reads. A text now
  // reaches whoever an email reaches, so the description stops naming a single audience.
  it('does not describe the text step as a message to the customer', async () => {
    renderWithProviders(<AddStepButton onPick={vi.fn()} variant="block" />);
    const menu = await openPicker();

    expect(within(menu).queryByText('Text the customer')).toBeNull();
    expect(within(menu).getByText('Text a customer or your team')).toBeInTheDocument();
  });

  it('offers exactly wait, send text, send email and stop if', async () => {
    renderWithProviders(<AddStepButton onPick={vi.fn()} variant="block" />);
    const menu = await openPicker();

    expect(within(menu).getAllByRole('menuitem')).toHaveLength(4);
    for (const label of ['Wait', 'Send text', 'Send email']) {
      expect(within(menu).getByText(label)).toBeInTheDocument();
    }
  });
});
