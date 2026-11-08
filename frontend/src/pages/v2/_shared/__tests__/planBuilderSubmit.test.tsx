import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';

import api from '@/lib/axios';
import { PlanBuilderDialog } from '../planBuilderDialog';

/**
 * Reproduction for "I cannot create a service plan even with the form fully
 * answered". No POST /api/service-plans reached the API in the reporter's
 * session, so the submit is gated client-side rather than failing server-side.
 */

vi.mock('@/lib/axios', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

vi.mock('@/lib/api/users', () => ({
  useUsers: () => ({ data: [{ id: 'u1', first_name: 'Ada', last_name: 'K', email: 'a@b.test' }] }),
}));

const CUSTOMER_ID = 'cus-1';
const LOCATION = {
  id: 'loc-1',
  address_line1: '1 Main St',
  address_line2: '',
  city: 'Austin',
  state: 'TX',
  zip: '78701',
};

function renderDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PlanBuilderDialog
        open
        onOpenChange={() => {}}
        presetCustomerId={CUSTOMER_ID}
        presetCustomerLabel="Acme Co"
      />
    </QueryClientProvider>,
  );
}

/** Fill every field a user fills for the simplest valid plan. */
async function fillForm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByPlaceholderText(/annual hvac maintenance/i), 'Comfort Club');

  const startDate = document.querySelector('#v2-plan-start-date') as HTMLInputElement;
  await user.type(startDate, '08/20/2026');
  await user.tab(); // the ported DatePicker commits on blur

  // Scope to the line-item row: the recurrence block also renders spinbuttons,
  // and one of those is disabled, which is not the field we mean.
  const description = screen.getByPlaceholderText('Description');
  const row = description.closest('div') as HTMLElement;
  const numbers = within(row).getAllByRole("spinbutton") as HTMLInputElement[];
  const quantity = numbers[0]!;
  const unitPrice = numbers[1]!;
  await user.type(description, 'Spring tune-up');
  await user.clear(unitPrice);
  await user.type(unitPrice, '250');

  return { startDate, quantity, unitPrice };
}

describe('v2 PlanBuilderDialog - the create button unlocks on a complete form', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The dialog fetches the customer to learn its service locations. One
    // location means the auto-select effect pins it, the common case.
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { customer: { service_locations: [LOCATION] } },
    });
  });

  it('enables Create draft once name, start date and a priced line item are filled', async () => {
    const user = userEvent.setup();
    renderDialog();

    const createButton = await screen.findByRole('button', { name: /create draft/i });
    expect(createButton).toBeDisabled();

    const { startDate, quantity, unitPrice } = await fillForm(user);

    // Surface the real field state when this fails, so the failure names the
    // unsatisfied gate instead of just saying "still disabled".
    const state = {
      startDate: startDate.value,
      quantity: quantity.value,
      unitPrice: unitPrice.value,
    };

    await waitFor(() => {
      expect(createButton, `Create draft still disabled with ${JSON.stringify(state)}`).toBeEnabled();
    });

    // Nothing outstanding, so the dialog says nothing.
    expect(screen.queryByText(/still needed/i)).toBeNull();
  });

  it('names what is missing instead of just greying the button out', async () => {
    const user = userEvent.setup();
    renderDialog();
    await screen.findByRole('button', { name: /create draft/i });

    // An untouched form is missing several things, and says so.
    const hint = await screen.findByText(/still needed/i);
    expect(hint).toHaveTextContent(/a plan name/i);
    expect(hint).toHaveTextContent(/a start date/i);

    await fillForm(user);

    await waitFor(() => {
      expect(screen.queryByText(/still needed/i)).toBeNull();
    });
  });

  it('marks every mandatory field, and only those, with a required asterisk', async () => {
    renderDialog();
    await screen.findByRole('button', { name: /create draft/i });

    // The two optional fields are the whole point of the rule, so they are
    // asserted as NOT marked rather than merely left out of the required list.
    const required = ['Customer', 'Service location', 'Plan name', 'Start date', 'Recurrence', 'Line items'];
    const optional = ['Sold by', 'Default materials'];

    for (const text of required) {
      const label = screen.getAllByText((_, el) => el?.tagName.toLowerCase() === 'label'
        && (el.textContent ?? '').startsWith(text))[0] as HTMLElement;
      expect(label, `${text} should have a label`).toBeTruthy();
      expect(label.textContent, `${text} should be marked required`).toContain('*');
    }

    for (const text of optional) {
      const label = screen.getAllByText((_, el) => el?.tagName.toLowerCase() === 'label'
        && (el.textContent ?? '').startsWith(text))[0] as HTMLElement;
      expect(label, `${text} should have a label`).toBeTruthy();
      expect(label.textContent, `${text} is optional and must NOT be marked`).not.toContain('*');
    }
  });

  it('shows an unpriced line item as blank, not as a filled-in zero', async () => {
    renderDialog();
    await screen.findByRole('button', { name: /create draft/i });

    // The row used to render price 0, which reads as "priced" and was the most
    // common reason the dialog refused to submit while looking complete.
    const price = screen.getByRole('spinbutton', { name: /line item 1 price/i }) as HTMLInputElement;
    expect(price.value, 'an unpriced row must look unfinished').toBe('');

    // The two blocking columns are marked; quantity ships valid at 1 and is not.
    const header = screen.getByText((_, el) => (el?.textContent ?? '').startsWith('Description')
      && el?.tagName.toLowerCase() === 'span');
    expect(header.textContent).toContain('*');
    expect(
      screen.getByText((_, el) => (el?.textContent ?? '').startsWith('Price') && el?.tagName.toLowerCase() === 'span').textContent,
    ).toContain('*');
  });

  it('explains the invisible gate when "Ends on a date" has no date', async () => {
    const user = userEvent.setup();
    renderDialog();
    await screen.findByRole('button', { name: /create draft/i });
    await fillForm(user);
    await waitFor(() => expect(screen.queryByText(/still needed/i)).toBeNull());

    // Choosing the terminator without picking a date locks submit, and used to
    // do so with no explanation anywhere on screen.
    await user.click(screen.getByRole('radio', { name: /ends on a date/i }));

    const hint = await screen.findByText(/still needed/i);
    expect(hint).toHaveTextContent(/an end date/i);
    expect(screen.getByRole('button', { name: /create draft/i })).toBeDisabled();
  });
});
