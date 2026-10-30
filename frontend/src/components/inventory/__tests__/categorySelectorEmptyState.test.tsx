// The category picker's empty state points at its "Add category" button only when that button is drawn: a person
// without Create price book reads a plain "nothing here" instead of an instruction for a control that is absent.
import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/__tests__/helpers';
import { CategorySelector } from '../CategorySelector';

function renderEmpty(canAdd: boolean) {
  renderWithProviders(
    <CategorySelector
      categories={[]}
      items={[]}
      activeName="all"
      onChange={() => {}}
      onAddNew={() => {}}
      canAdd={canAdd}
    />,
  );
}

describe('CategorySelector empty state', () => {
  it('tells a person who can add a category to use the button below', async () => {
    renderEmpty(true);
    await userEvent.click(screen.getByRole('button', { name: /all categories/i }));
    expect(await screen.findByText(/use the button below to add one/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add category/i })).toBeInTheDocument();
  });

  it('names no button to a person who cannot add one', async () => {
    renderEmpty(false);
    await userEvent.click(screen.getByRole('button', { name: /all categories/i }));
    expect(await screen.findByText(/no categories configured yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/button below/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /add category/i })).toBeNull();
  });
});
