// LO-5 — the service-plan "Default materials" template (spec §15 UI).
//
// Contract under test:
//   • PlanBuilderDialog gains a "Default materials" section: a tracked-item search adds a
//     row (item snapshot + qty); rows are freely removable; qty must be positive.
//   • The create payload carries material_lines: [{ item_id, qty }] (the backend snapshots
//     sku/name from item_id — the client never sends them).
//   • PlanDetailSheet renders a read-only materials block, and flags any line whose catalog
//     item was later removed (item_id === null, snapshot name still shown).
//
// Seam hooks are mocked with stable resolved data (jsdom seed-loop landmine). The builder's
// useCreateServicePlan stays REAL so the POST body it assembles is what's asserted; only the
// detail sheet's read/lifecycle hooks are stubbed.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { PlanBuilderDialog, PlanDetailSheet } from '@/pages/service-plans/ServicePlansPage';
import type { ServicePlan, ServicePlanMaterialLine } from '@/lib/api/service-plans';

const h = vi.hoisted(() => ({
  ITEM1: 'bbbbbbb1-0000-4000-8000-000000000001',
  ITEM2: 'bbbbbbb2-0000-4000-8000-000000000002',
  detailPlan: null as unknown as ServicePlan | null,
}));

vi.mock('@/lib/axios', () => ({ default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() } }));
vi.mock('@/lib/api/users', () => ({ useUsers: () => ({ data: [] }) }));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

// Stubbed so the builder's own submit path is what's under test, not the picker's internals.
vi.mock('@/components/crm/CustomerPickerWithCreate', () => ({
  CustomerPickerWithCreate: ({ onChange }: { onChange: (id: string, label: string) => void }) => (
    <button type="button" onClick={() => onChange('c1', 'Acme Co')}>pick customer</button>
  ),
}));

vi.mock('@/lib/api/invoices', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/invoices')>();
  return {
    ...actual,
    listPriceBookItems: vi.fn().mockResolvedValue([
      { id: h.ITEM1, name: 'Filter 20x20', sku: 'FIL-2020', type: 'MATERIAL', track_inventory: true },
      { id: h.ITEM2, name: 'Belt A32', sku: 'BLT-A32', type: 'MATERIAL', track_inventory: true },
    ]),
  };
});

// PlanDetailSheet's read + lifecycle hooks are stubbed; useCreateServicePlan stays REAL so the
// builder's POST payload is exercised over the setup-mocked axios.
vi.mock('@/lib/api/service-plans', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/service-plans')>();
  const noopMutation = () => ({ mutate: vi.fn(), isPending: false });
  return {
    ...actual,
    useServicePlan: () => ({ data: h.detailPlan }),
    useActivateServicePlan: noopMutation,
    useRenewServicePlan: noopMutation,
    useCancelServicePlan: noopMutation,
    useDeleteServicePlan: noopMutation,
    useScheduleVisit: noopMutation,
  };
});

const mockApi = vi.mocked(api);

// ─── Builder — Default materials section ──────────────────────────────────────

async function renderBuilder() {
  const user = userEvent.setup();
  // Exactly ONE location → the builder auto-selects it, so we never drive the location picker.
  mockApi.get.mockResolvedValue({
    data: { customer: { service_locations: [
      { id: 'loc1', address_line1: '1 A St', address_line2: '', city: 'Reno', state: 'NV', zip: '89501' },
    ] } },
  });
  mockApi.post.mockResolvedValue({ data: { servicePlan: { id: 'p1' } } });
  renderWithProviders(<PlanBuilderDialog open onOpenChange={vi.fn()} />);
  await user.click(screen.getByRole('button', { name: /pick customer/i }));
  return { user };
}

// Fill every non-materials field to a valid state. Runs BEFORE any material is added, so the
// single input[step="0.01"] on the page is unambiguously the line-item unit price.
function fillValidBase() {
  fireEvent.change(screen.getByPlaceholderText(/annual hvac maintenance/i), { target: { value: 'Quarterly Tune-Up' } });
  fireEvent.change(screen.getByPlaceholderText('Description'), { target: { value: 'Tune-up visit' } });
  // Start date is a DatePicker now (typeable MM/DD/YYYY text field, not <input
  // type="date">) - it only commits to parent state on blur. Queried by its
  // FormField label, not placeholder - RecurrenceBuilder's own "On [date]" end-date
  // DatePicker shares the same default placeholder.
  const startDateInput = screen.getByLabelText('Start date');
  fireEvent.change(startDateInput, { target: { value: '09/01/2026' } });
  fireEvent.blur(startDateInput);
  fireEvent.change(document.querySelector('input[step="0.01"]')!, { target: { value: '250' } });
}

async function addMaterial(user: ReturnType<typeof userEvent.setup>, name: RegExp = /Filter 20x20/) {
  await user.type(screen.getByLabelText('Search tracked items'), 'fil');
  await user.click(await screen.findByRole('button', { name }));
}

describe('PlanBuilderDialog — Default materials', () => {
  beforeEach(() => vi.clearAllMocks());

  it('adds a tracked item as a material row and removes it again', async () => {
    const { user } = await renderBuilder();
    await addMaterial(user);

    // The row shows the item snapshot (name + sku); the search box cleared after the pick.
    expect(await screen.findByText('Filter 20x20')).toBeInTheDocument();
    expect(screen.getByText('FIL-2020')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Remove Filter 20x20/i }));
    await waitFor(() => expect(screen.queryByText('Filter 20x20')).toBeNull());
  });

  it('carries material_lines: [{ item_id, qty }] in the create payload', async () => {
    const { user } = await renderBuilder();
    fillValidBase();
    await addMaterial(user);
    fireEvent.change(screen.getByLabelText('Quantity for Filter 20x20'), { target: { value: '3' } });

    await waitFor(() => expect(screen.getByRole('button', { name: /create draft/i })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: /create draft/i }));

    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith(
        '/api/service-plans',
        expect.objectContaining({ material_lines: [{ item_id: h.ITEM1, qty: 3 }] }),
      ),
    );
  });

  it('sends an empty material_lines array when none were added', async () => {
    const { user } = await renderBuilder();
    fillValidBase();

    await waitFor(() => expect(screen.getByRole('button', { name: /create draft/i })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: /create draft/i }));

    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith(
        '/api/service-plans',
        expect.objectContaining({ material_lines: [] }),
      ),
    );
  });

  it('blocks submit while a material qty is not positive', async () => {
    const { user } = await renderBuilder();
    fillValidBase();
    await addMaterial(user);

    await waitFor(() => expect(screen.getByRole('button', { name: /create draft/i })).toBeEnabled());
    fireEvent.change(screen.getByLabelText('Quantity for Filter 20x20'), { target: { value: '0' } });
    expect(screen.getByRole('button', { name: /create draft/i })).toBeDisabled();

    // Restoring a positive qty re-enables submit.
    fireEvent.change(screen.getByLabelText('Quantity for Filter 20x20'), { target: { value: '2' } });
    await waitFor(() => expect(screen.getByRole('button', { name: /create draft/i })).toBeEnabled());
  });
});

// ─── Detail sheet — read-only materials block ─────────────────────────────────

function makeDetailPlan(materialLines: ServicePlanMaterialLine[]): ServicePlan {
  return {
    id: 'p1',
    service_plan_number: 'SP-0001',
    customer_id: 'c1',
    service_location_id: 'loc1',
    name: 'Quarterly Tune-Up',
    status: 'ACTIVE',
    visit_cadence: 'QUARTERLY',
    interval_unit: null,
    interval_count: null,
    byweekday: [],
    occurrence_count: null,
    start_date: '2026-01-01T00:00:00.000Z',
    end_date: null,
    contract_price: 250,
    sold_by: null,
    renewals_count: 0,
    template_id: null,
    line_items: [],
    material_lines: materialLines,
    visits: [],
    invoices: [],
    planned_visit_count: null,
    visits_remaining: null,
    next_due: '2026-04-01T00:00:00.000Z',
    due_soon: false,
    overdue: false,
    emphasized: false,
    effective_status: 'ACTIVE',
  } as ServicePlan;
}

describe('PlanDetailSheet — Default materials read block', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists each material with its snapshot name and quantity', async () => {
    h.detailPlan = makeDetailPlan([
      { id: 'm1', item_id: h.ITEM1, item_sku: 'FIL-2020', item_name: 'Filter 20x20', qty: '2', position: 0 },
    ]);
    renderWithProviders(<PlanDetailSheet id="p1" onClose={vi.fn()} />);

    expect(await screen.findByText('Default materials')).toBeInTheDocument();
    expect(screen.getByText('Filter 20x20')).toBeInTheDocument();
    expect(screen.getByText(/×\s*2/)).toBeInTheDocument();
  });

  it('flags a material whose catalog item was removed', async () => {
    h.detailPlan = makeDetailPlan([
      { id: 'm1', item_id: null, item_sku: 'OLD-1', item_name: 'Discontinued part', qty: '1', position: 0 },
    ]);
    renderWithProviders(<PlanDetailSheet id="p1" onClose={vi.fn()} />);

    expect(await screen.findByText('Discontinued part')).toBeInTheDocument();
    expect(screen.getByText(/removed from catalog/i)).toBeInTheDocument();
  });

  it('shows an empty-state message (not nothing) when there are none, so the Edit affordance is still discoverable', async () => {
    h.detailPlan = makeDetailPlan([]);
    renderWithProviders(<PlanDetailSheet id="p1" onClose={vi.fn()} />);

    // The block itself must still render — an empty plan is exactly the case where a
    // dispatcher needs to find the Edit button to ADD a first material.
    expect(await screen.findByText('Default materials')).toBeInTheDocument();
    expect(screen.getByText(/no default materials/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^edit$/i })).toBeInTheDocument();
  });
});

// ─── Detail sheet — materials are editable regardless of plan status ──────────
//
// The whole point of this section: on an ACTIVE plan, editing every other structural field
// (line_items, cadence, price) is locked — only name/sold_by/materials may change. Materials
// carve out of that lock because a Logistic Order never touches invoice pricing. These tests
// exercise the ACTUAL update path (useUpdateServicePlan is NOT stubbed in this file's mock —
// only the read/lifecycle hooks are), so a regression that re-locks materials on ACTIVE would
// show up here as the PATCH body assertion failing, not just a UI-visibility check.

describe('PlanDetailSheet — materials are editable on an ACTIVE plan', () => {
  beforeEach(() => vi.clearAllMocks());

  it('opens an editor, adds a tracked item, and PATCHes material_lines — reachable on ACTIVE, not just DRAFT', async () => {
    const user = userEvent.setup();
    h.detailPlan = makeDetailPlan([
      { id: 'm1', item_id: h.ITEM1, item_sku: 'FIL-2020', item_name: 'Filter 20x20', qty: '2', position: 0 },
    ]);
    expect(h.detailPlan.status).toBe('ACTIVE'); // guards the premise of this test
    mockApi.patch.mockResolvedValue({ data: { servicePlan: { ...h.detailPlan, material_lines: [] } } });

    renderWithProviders(<PlanDetailSheet id="p1" onClose={vi.fn()} />);
    await screen.findByText('Default materials');

    await user.click(screen.getByRole('button', { name: /^edit$/i }));

    // The existing live line seeds into the editable draft…
    expect(screen.getByText('Filter 20x20')).toBeInTheDocument();
    // …and a second tracked item can be added via the same search used at create time.
    await user.type(screen.getByLabelText('Search tracked items'), 'bel');
    await user.click(await screen.findByRole('button', { name: /Belt A32/ }));
    fireEvent.change(screen.getByLabelText('Quantity for Belt A32'), { target: { value: '4' } });

    await user.click(screen.getByRole('button', { name: /save materials/i }));

    await waitFor(() =>
      expect(mockApi.patch).toHaveBeenCalledWith(
        '/api/service-plans/p1',
        expect.objectContaining({
          material_lines: [
            { item_id: h.ITEM1, qty: 2 },
            { item_id: h.ITEM2, qty: 4 },
          ],
        }),
      ),
    );
  });

  it('Cancel discards the draft without calling the API', async () => {
    const user = userEvent.setup();
    h.detailPlan = makeDetailPlan([
      { id: 'm1', item_id: h.ITEM1, item_sku: 'FIL-2020', item_name: 'Filter 20x20', qty: '2', position: 0 },
    ]);
    renderWithProviders(<PlanDetailSheet id="p1" onClose={vi.fn()} />);
    await screen.findByText('Default materials');

    await user.click(screen.getByRole('button', { name: /^edit$/i }));
    await user.click(screen.getByRole('button', { name: /^cancel$/i }));

    // Back to the read view; nothing was sent.
    expect(await screen.findByRole('button', { name: /^edit$/i })).toBeInTheDocument();
    expect(mockApi.patch).not.toHaveBeenCalled();
  });

  it('a dead-catalog-ref line (item_id: null) drops out of the editable draft — nothing invalid to resend', async () => {
    const user = userEvent.setup();
    h.detailPlan = makeDetailPlan([
      { id: 'm1', item_id: null, item_sku: 'OLD-1', item_name: 'Discontinued part', qty: '1', position: 0 },
    ]);
    mockApi.patch.mockResolvedValue({ data: { servicePlan: h.detailPlan } });
    renderWithProviders(<PlanDetailSheet id="p1" onClose={vi.fn()} />);
    await screen.findByText('Default materials');

    await user.click(screen.getByRole('button', { name: /^edit$/i }));
    expect(screen.queryByText('Discontinued part')).toBeNull();

    await user.click(screen.getByRole('button', { name: /save materials/i }));
    await waitFor(() =>
      expect(mockApi.patch).toHaveBeenCalledWith('/api/service-plans/p1', expect.objectContaining({ material_lines: [] })),
    );
  });
});
