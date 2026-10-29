/**
 * The Add line item dialog stops an over-long description itself (#1604).
 *
 * The item name and the description are stored in ONE field (`name\ndetail`), so the budget has
 * to be measured on the combined string. Before this, the only feedback was the API bouncing the
 * POST and the dialog printing the raw Zod string `description: String must contain at most
 * 5000 character(s)` - after the user had already written the whole scope of work.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import { AddLineDialog } from '@/components/jobs/items/AddLineDialog';
import { LINE_DESCRIPTION_MAX, combineDescription } from '@/lib/lineItems';

vi.mock('@/lib/api/invoices', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/invoices')>('@/lib/api/invoices');
  return { ...actual, searchPriceBookItems: vi.fn().mockResolvedValue([]) };
});

/** Types the create form without userEvent replaying 50,000 keystrokes. */
async function fillCreateForm(user: ReturnType<typeof userEvent.setup>, description: string) {
  // `initialQuery` opens the dialog straight on the create form (PriceBookPicker's
  // "Add new item: <query>" handoff), so there is no search step to click through.
  const name = await screen.findByLabelText('Name');
  await user.clear(name);
  await user.type(name, 'LABOR.');
  const detail = screen.getByLabelText('Description');
  await user.click(detail);
  await user.paste(description);
  const price = screen.getByLabelText('Price ($)');
  await user.clear(price);
  await user.type(price, '225');
}

describe('line description cap in the Add line item dialog', () => {
  const onAdd = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    onAdd.mockClear();
  });

  function render() {
    return renderWithProviders(
      <AddLineDialog open onOpenChange={() => {}} onAdd={onAdd} initialQuery="LABOR." canSeePricing />,
    );
  }

  it('blocks submit and names the real length when the combined field is over the cap', async () => {
    const user = userEvent.setup();
    render();
    // One character over once the name and its newline are counted.
    const detail = 'x'.repeat(LINE_DESCRIPTION_MAX + 1 - 'LABOR.\n'.length);
    expect(combineDescription('LABOR.', detail).length).toBe(LINE_DESCRIPTION_MAX + 1);

    await fillCreateForm(user, detail);
    await user.click(screen.getByRole('button', { name: /add item/i }));

    expect(onAdd).not.toHaveBeenCalled();
    expect(await screen.findByText(/description is too long/i)).toBeInTheDocument();
    expect(screen.getByText(/the item name counts toward this limit/i)).toBeInTheDocument();
  });

  it('submits a description that sits exactly at the cap', async () => {
    const user = userEvent.setup();
    render();
    const detail = 'x'.repeat(LINE_DESCRIPTION_MAX - 'LABOR.\n'.length);

    await fillCreateForm(user, detail);
    await user.click(screen.getByRole('button', { name: /add item/i }));

    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd.mock.calls[0][0].description).toHaveLength(LINE_DESCRIPTION_MAX);
  });
});
