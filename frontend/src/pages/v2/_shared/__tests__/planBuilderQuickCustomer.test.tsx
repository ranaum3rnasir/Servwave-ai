import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';

import api from '@/lib/axios';
import { buildAbility, type AbilityRule } from '@/lib/ability';
import { AbilityProvider } from '@/contexts/AbilityContext';
import { PlanBuilderDialog } from '../planBuilderDialog';
import { CustomerPickerWithCreate } from '@/components/crm/CustomerPickerWithCreate';
import { ParticipantsField } from '@/pages/v2/schedule/components/participantsField';

/**
 * Roles & Permissions S02.28: the service plan builder's customer picker offers a quick customer
 * create to anyone who can create a service plan, whatever Create customers and Show Customers
 * page say. The save goes through the plan route (accepted on Create service plans), the address
 * typed into the form becomes the plan's Service location, and the duplicate check still runs.
 * The schedule's event participants field stays pick-only.
 */

vi.mock('@/lib/axios', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock('@/lib/api/users', () => ({
  usePeople: () => ({ data: [] }),
  useAssignableUsers: () => ({ data: [] }),
}));

const NEW_CUSTOMER = {
  id: 'new-1',
  first_name: 'Quick',
  last_name: 'Planner',
  company_name: null,
  email: 'quick@example.test',
  customer_number: 'C0042',
  service_locations: [
    { id: 'loc-new', address_line1: '1 Main St', address_line2: null, city: 'Austin', state: 'TX', zip: '78701', is_primary: true },
  ],
};

/** A custom role with Create service plans on and the Customers switches off. */
const planOnly: AbilityRule[] = [
  { action: 'read', subject: 'ServicePlan' },
  { action: 'create', subject: 'ServicePlan' },
];
const customersOnly: AbilityRule[] = [
  { action: 'read', subject: 'Customer' },
  { action: 'create', subject: 'Customer' },
];

function renderWith(rules: AbilityRule[], ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AbilityProvider ability={buildAbility(rules)}>{ui}</AbilityProvider>
    </QueryClientProvider>,
  );
}

async function openPicker(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /select customer/i }));
}

async function fillQuickForm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/first name/i), 'Quick');
  await user.type(screen.getByLabelText(/last name/i), 'Planner');
  await user.type(screen.getByLabelText(/^email/i), 'quick@example.test');
  await user.type(screen.getByLabelText(/^address/i), '1 Main St');
  await user.type(screen.getByLabelText(/city/i), 'Austin');
  await user.type(screen.getByLabelText(/state/i), 'TX');
  await user.type(screen.getByLabelText(/zip/i), '78701');
}

beforeEach(() => {
  vi.clearAllMocks();
  (api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
    if (url === '/api/customers') return Promise.resolve({ data: { customers: [] } });
    // A person without View customers cannot open the customer record they just made.
    return Promise.reject({ response: { status: 403, data: { error: 'Insufficient permissions' } } });
  });
});

describe('v2 PlanBuilderDialog - quick customer create follows Create service plans', () => {
  it('offers the quick create to a role with Create service plans on and the Customers switches off', async () => {
    const user = userEvent.setup();
    renderWith(planOnly, <PlanBuilderDialog open onOpenChange={() => {}} />);

    await openPicker(user);

    expect(await screen.findByRole('button', { name: /create new customer/i })).toBeInTheDocument();
  });

  it('saves through the plan route, not the standalone customer create, and asks the form fields the plan needs', async () => {
    const user = userEvent.setup();
    (api.post as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { customer: NEW_CUSTOMER } });
    renderWith(planOnly, <PlanBuilderDialog open onOpenChange={() => {}} />);

    await openPicker(user);
    await user.click(await screen.findByRole('button', { name: /create new customer/i }));

    for (const field of [/first name/i, /last name/i, /company/i, /phone/i, /^email/i, /^address/i]) {
      expect(screen.getByLabelText(field)).toBeInTheDocument();
    }
    await fillQuickForm(user);
    await user.click(screen.getByRole('button', { name: /create & select/i }));

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post).toHaveBeenCalledWith(
      '/api/service-plans/customers',
      expect.objectContaining({
        first_name: 'Quick',
        last_name: 'Planner',
        email: 'quick@example.test',
        locations: [expect.objectContaining({ address_line1: '1 Main St', city: 'Austin', state: 'TX', zip: '78701', is_primary: true })],
      }),
    );
    expect(api.post).not.toHaveBeenCalledWith('/api/customers', expect.anything());
  });

  it('makes the typed service address the plan\'s Service location, even when the new customer cannot be read back', async () => {
    const user = userEvent.setup();
    (api.post as ReturnType<typeof vi.fn>).mockImplementation((url: string) =>
      url === '/api/service-plans/customers'
        ? Promise.resolve({ data: { customer: NEW_CUSTOMER } })
        : Promise.resolve({ data: { plan: { id: 'plan-1' } } }),
    );
    renderWith(planOnly, <PlanBuilderDialog open onOpenChange={() => {}} />);

    await openPicker(user);
    await user.click(await screen.findByRole('button', { name: /create new customer/i }));
    await fillQuickForm(user);
    await user.click(screen.getByRole('button', { name: /create & select/i }));

    // The customer is chosen and the service location is already answered: the builder is not
    // waiting for a location (the customer read-back is refused in this scenario).
    expect(await screen.findByRole('button', { name: /quick planner/i })).toBeInTheDocument();
    await waitFor(() => {
      const needed = screen.queryByText(/still needed/i);
      expect(needed?.textContent ?? '').not.toMatch(/a customer|a service location/i);
    });
    expect(screen.getByText(/1 Main St - Austin, TX 78701/)).toBeInTheDocument();

    // And it is the id the plan is created with.
    await user.type(screen.getByPlaceholderText(/annual hvac maintenance/i), 'Comfort Club');
    const startDate = document.querySelector('#v2-plan-start-date') as HTMLInputElement;
    await user.type(startDate, '08/20/2026');
    await user.tab();
    const description = screen.getByPlaceholderText('Description');
    const row = description.closest('div') as HTMLElement;
    await user.type(description, 'Spring tune-up');
    const unitPrice = within(row).getByRole('textbox', { name: /line item 1 price/i });
    await user.clear(unitPrice);
    await user.type(unitPrice, '250');
    await user.click(await screen.findByRole('button', { name: /create draft/i }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/api/service-plans',
      expect.objectContaining({ customer_id: 'new-1', service_location_id: 'loc-new' }),
    ));
  });

  it('still runs the duplicate-customer check on that save', async () => {
    const user = userEvent.setup();
    (api.post as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      response: { status: 409, data: { error: 'duplicate', existing: { id: 'dupe', customer_number: 'C0001', first_name: 'Dup', last_name: null, company_name: null, email: null, phone: null } } },
    }).mockResolvedValueOnce({ data: { customer: NEW_CUSTOMER } });
    renderWith(planOnly, <PlanBuilderDialog open onOpenChange={() => {}} />);

    await openPicker(user);
    await user.click(await screen.findByRole('button', { name: /create new customer/i }));
    await fillQuickForm(user);
    await user.click(screen.getByRole('button', { name: /create & select/i }));

    await user.click(await screen.findByRole('button', { name: /create anyway/i }));
    await waitFor(() => expect(api.post).toHaveBeenLastCalledWith('/api/service-plans/customers?override=true', expect.any(Object)));
  });
});

describe('the quick create does not leak to the other customer pickers', () => {
  it('shows no create row in the builder picker to a person who can create customers but not service plans', async () => {
    const user = userEvent.setup();
    renderWith(customersOnly, <PlanBuilderDialog open onOpenChange={() => {}} />);

    await openPicker(user);
    await screen.findByText('No matches');

    expect(screen.queryByRole('button', { name: /create new customer/i })).toBeNull();
  });

  it('keeps the standalone create row tied to Create customers: Create service plans alone does not open it', async () => {
    const user = userEvent.setup();
    renderWith(planOnly, <CustomerPickerWithCreate value="" valueLabel="" onChange={() => {}} />);

    await openPicker(user);
    await screen.findByText('No matches');

    expect(screen.queryByRole('button', { name: /create new customer/i })).toBeNull();
  });

  it('keeps the schedule participants field pick-only, whatever the person can create', async () => {
    const user = userEvent.setup();
    renderWith([...planOnly, ...customersOnly], <ParticipantsField value={[]} onChange={() => {}} />);

    await openPicker(user);
    await screen.findByText('No matches');

    expect(screen.queryByRole('button', { name: /create/i })).toBeNull();
  });
});
