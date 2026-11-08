import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import api from '@/lib/axios';
import { ADD_NEW_LOCATION, type PickOrAccreteLocationValue } from '@/components/crm/PickOrAccreteLocation';
import { PlanBuilderDialog } from '@/pages/service-plans/ServicePlansPage';
import { resolveServiceLocationId } from '@/lib/service-plans/resolveServiceLocationId';

vi.mock('@/lib/axios', () => ({ default: { get: vi.fn(), post: vi.fn() } }));
vi.mock('@/lib/api/users', () => ({ useUsers: () => ({ data: [] }) }));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

// Stubbed so the builder's own submit path is what's under test, not the picker's internals.
vi.mock('@/components/crm/CustomerPickerWithCreate', () => ({
  CustomerPickerWithCreate: ({ onChange }: { onChange: (id: string, label: string) => void }) => (
    <button type="button" onClick={() => onChange('c1', 'Acme Co')}>pick customer</button>
  ),
}));

const newAddr = (): PickOrAccreteLocationValue => ({
  locationId: ADD_NEW_LOCATION,
  address: { address_line1: '9 King St', address_line2: '', city: 'Reno', state: 'NV', zip: '89501' },
});

describe('resolveServiceLocationId', () => {
  beforeEach(() => vi.clearAllMocks());

  it('passes an existing location id straight through (no POST)', async () => {
    const id = await resolveServiceLocationId('c1', { locationId: 'loc1', address: newAddr().address }, false);
    expect(id).toBe('loc1');
    expect(api.post).not.toHaveBeenCalled();
  });

  it('creates the location first for a new address and returns its id', async () => {
    (api.post as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { location: { id: 'loc9' } } });
    const id = await resolveServiceLocationId('c1', newAddr(), true);
    expect(api.post).toHaveBeenCalledWith('/api/customers/c1/locations', expect.objectContaining({
      address_line1: '9 King St', city: 'Reno', state: 'NV', zip: '89501', is_primary: true,
    }));
    expect(id).toBe('loc9');
  });
});

// The location POST is NOT idempotent: it accretes a row every time. Because the plan-create
// that follows it can fail independently (500/validation), the builder must pin the created
// location's id into its own state, or every retry orphans another duplicate address — and,
// while `hadZeroLocations` stays stale, re-sends is_primary:true and demotes the previous one.
describe('PlanBuilderDialog — location is created at most once across retries', () => {
  beforeEach(() => vi.clearAllMocks());

  const postCalls = (url: string) =>
    (api.post as ReturnType<typeof vi.fn>).mock.calls.filter(([u]) => u === url);

  async function fillAndRender() {
    const user = userEvent.setup();
    // The customer has ZERO existing locations — the scenario that makes is_primary
    // clobbering possible on a duplicate POST.
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { customer: { service_locations: [] } } });
    // Location POST always succeeds; the plan create always fails.
    (api.post as ReturnType<typeof vi.fn>).mockImplementation((url: string) =>
      url === '/api/customers/c1/locations'
        ? Promise.resolve({ data: { location: { id: 'loc9' } } })
        : Promise.reject(new Error('plan create exploded')),
    );

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <PlanBuilderDialog open onOpenChange={vi.fn()} />
      </QueryClientProvider>,
    );

    await user.click(screen.getByRole('button', { name: /pick customer/i }));

    // Author a brand-new address rather than picking an existing location. The trigger is
    // reached via its placeholder text because ARIA gives `combobox` no name-from-content,
    // and the page renders two other Selects (Sold by / interval unit).
    await user.click((await screen.findByText('Select a service location')).closest('button')!);
    await user.click(await screen.findByRole('option', { name: /add new location/i }));

    fireEvent.change(screen.getByLabelText(/^address/i), { target: { value: '9 King St' } });
    fireEvent.change(screen.getByLabelText(/city/i), { target: { value: 'Reno' } });
    fireEvent.change(screen.getByLabelText(/state/i), { target: { value: 'NV' } });
    fireEvent.change(screen.getByLabelText(/zip/i), { target: { value: '89501' } });

    fireEvent.change(screen.getByPlaceholderText(/annual hvac maintenance/i), { target: { value: 'Quarterly Tune-Up' } });
    fireEvent.change(screen.getByPlaceholderText('Description'), { target: { value: 'Tune-up visit' } });
    // Start date is a DatePicker now (typeable MM/DD/YYYY text field, not <input
    // type="date">) - it only commits to parent state on blur. Queried by its
    // FormField label, not placeholder - RecurrenceBuilder's own "On [date]" end-date
    // DatePicker shares the same default placeholder. Unit price carries no
    // label/placeholder to query by; the dialog is portalled to document.body, so it's
    // scoped to the document, not RTL's container.
    const startDateInput = screen.getByLabelText('Start date');
    fireEvent.change(startDateInput, { target: { value: '09/01/2026' } });
    fireEvent.blur(startDateInput);
    fireEvent.change(document.querySelector('input[step="0.01"]')!, { target: { value: '250' } });

    return { user };
  }

  it('POSTs the new location exactly once when the plan create fails and the user retries', async () => {
    const { user } = await fillAndRender();

    // Attempt 1: location is created, then the plan create blows up.
    await user.click(screen.getByRole('button', { name: /create draft/i }));
    await waitFor(() => expect(postCalls('/api/service-plans')).toHaveLength(1));
    expect(postCalls('/api/customers/c1/locations')).toHaveLength(1);

    // Attempt 2: the user just clicks "Create draft" again after the error toast.
    await user.click(screen.getByRole('button', { name: /create draft/i }));
    await waitFor(() => expect(postCalls('/api/service-plans')).toHaveLength(2));

    // The retry must reuse the location created on attempt 1 — not accrete a duplicate.
    expect(postCalls('/api/customers/c1/locations')).toHaveLength(1);
    expect(postCalls('/api/service-plans')[1]![1]).toMatchObject({ service_location_id: 'loc9' });
  });
});
