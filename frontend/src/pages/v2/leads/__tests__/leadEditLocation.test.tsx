import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import LeadFormPage from '@/pages/v2/leads/LeadFormPage';
import { buildAbility } from '@/lib/ability';

/*
 * The lead's Edit form is now the ONLY place a lead's service location is read back and changed
 * (#1903 removed the detail card's pencil and its dialog). Everything below is about one rule the
 * form got wrong in four places at once: THE LEAD'S LOCATION IS ITS ANCHOR.
 *
 * The deprecated inline `service_*` columns are a legacy fallback, and the lead update path never
 * writes them - so on any lead created since the anchor arrived they are null. The form read them
 * first, which is why the fixture below is the discriminating one: anchored, with every deprecated
 * column null. 79 of 208 leads on staging are that shape.
 */

const LEAD_ID = 'e0000000-0000-0000-0000-000000000001';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate, useParams: () => ({ id: LEAD_ID }) };
});

vi.mock('@/lib/api/organization', () => ({
  useOrganization: () => ({ data: { job_type_options: [], source_options: [] } }),
  useUpdateOrganization: () => ({ mutate: vi.fn() }),
}));
vi.mock('@/lib/api/users', () => ({ useAssignableUsers: () => ({ data: [] }) }));

const mockApi = vi.mocked(api);
const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

const MIAMI = {
  id: 'l0000000-0000-0000-0000-0000000000f1',
  address_line1: '500 Ocean Drive',
  address_line2: null,
  city: 'Miami',
  state: 'FL',
  zip: '33139',
  is_primary: false,
};
// Stored lower-case on purpose: staging holds rows exactly like this, and a state is a code.
const LOWERCASE_NY = {
  id: 'l0000000-0000-0000-0000-0000000000f2',
  address_line1: '77 QA Test Way',
  address_line2: null,
  city: 'ashkelon',
  state: 'ny',
  zip: '78501',
  is_primary: true,
};

// Anchored to the NON-primary location, with every deprecated column null.
const ANCHORED_LEAD = {
  id: LEAD_ID,
  lead_number: 'L00263',
  service_request: 'Test lead',
  notes: null,
  job_type: null,
  scheduled_start: null,
  scheduled_end: null,
  status: 'NEW',
  estimates: [],
  service_location_id: MIAMI.id,
  service_location: MIAMI,
  service_address_line1: null,
  service_address_line2: null,
  service_city: null,
  service_state: null,
  service_zip: null,
  customer: {
    id: 'c0000000-0000-0000-0000-0000000000aa',
    first_name: 'Fork',
    last_name: 'Customer',
    ad_source: null,
    service_locations: [LOWERCASE_NY, MIAMI],
  },
};

/*
 * The picker is a Radix Select, so the chosen row is the TRIGGER'S TEXT, not an input value - and
 * the address also appears in the map panel beside it, so a bare getByText matches twice. Read the
 * trigger itself.
 */
const locationTrigger = () =>
  screen.getAllByRole('combobox').find((el) => /—/.test(el.textContent ?? ''));

const serve = (lead: unknown) => {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.includes(`/api/leads/${LEAD_ID}`)) return { data: { lead } };
    if (url.includes('/api/users')) return { data: { users: [] } };
    return { data: {} };
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.patch.mockResolvedValue({ data: { lead: ANCHORED_LEAD } });
});

describe("LeadFormPage (edit) - the lead's location is its anchor", () => {
  it('opens on the anchored address, not the customer\'s primary', async () => {
    serve(ANCHORED_LEAD);
    renderWithProviders(<LeadFormPage />, { ability: adminAbility, initialEntries: [`/leads/${LEAD_ID}/edit`] });

    // The anchor is Miami; the PRIMARY is the ashkelon row. Falling back to the primary is what
    // made an untouched save re-point the lead.
    // The picker is a Select: its trigger shows `formatLocationLabel` for the chosen row.
    await waitFor(() => expect(locationTrigger()).toBeDefined());
    expect(locationTrigger()!.textContent).toMatch(/500 Ocean Drive/);
    expect(locationTrigger()!.textContent).not.toMatch(/77 QA Test Way/);
  });

  it('saves an untouched form without moving the lead', async () => {
    const user = userEvent.setup();
    serve(ANCHORED_LEAD);
    renderWithProviders(<LeadFormPage />, { ability: adminAbility, initialEntries: [`/leads/${LEAD_ID}/edit`] });

    await waitFor(() => expect(locationTrigger()?.textContent).toMatch(/500 Ocean Drive/));
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    // The whole point: opening Edit and saving must not silently change where the work is.
    await waitFor(() => expect(mockApi.patch).toHaveBeenCalled());
    expect(mockApi.patch).toHaveBeenCalledWith(
      `/api/leads/${LEAD_ID}`,
      expect.objectContaining({ service_location_id: MIAMI.id }),
    );
  });

  it('does not call an unchanged location a state change', async () => {
    serve(ANCHORED_LEAD);
    renderWithProviders(<LeadFormPage />, { ability: adminAbility, initialEntries: [`/leads/${LEAD_ID}/edit`] });

    await waitFor(() => expect(locationTrigger()?.textContent).toMatch(/500 Ocean Drive/));
    // `leadState` used to read the null deprecated column, so ANY location read as a move into a
    // new state and fired the tax note on a form nobody had touched.
    expect(screen.queryByText(/will change the tax rate/i)).toBeNull();
  });
});

describe('LeadFormPage (edit) - a frozen lead still shows where the work is', () => {
  it('renders the anchored address in the locked box', async () => {
    serve({ ...ANCHORED_LEAD, estimates: [{ id: 'est-1' }] });
    renderWithProviders(<LeadFormPage />, { ability: adminAbility, initialEntries: [`/leads/${LEAD_ID}/edit`] });

    // Reading the deprecated columns here rendered a locked address of "-": the page hiding the
    // very thing the lock is about.
    const locked = await screen.findByText('500 Ocean Drive');
    expect(locked).toBeInTheDocument();
    expect(screen.getByText(/Miami, FL, 33139/)).toBeInTheDocument();
    expect(screen.getByText(/Locked - revise or duplicate the estimate/i)).toBeInTheDocument();
  });
});
