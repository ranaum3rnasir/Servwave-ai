/* =============================================================================
   Roles & Permissions, PRD 5, slice S05.13 - a lead's own phones, emails, name and company, added or changed with
   the pencil on the lead page's customer block. Renders the ROUTED lead page (pages/v2/leads/LeadDetailPage).

   The person's switches come from the "Me" answer, keyed by the catalog's own keys (read from the backend
   catalog file, never typed here); whether this person edits THIS lead (Edit leads, or the creator still on it) is
   the server's per-lead answer, the lead's `actions`. Every case is a custom switch set, never a built-in role name.
   ========================================================================== */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import api from '@/lib/axios';
import { toast } from '@/components/ui/use-toast';
import { buildAbility } from '@/lib/ability';
import { requestCall } from '@/lib/communication/phoneTabHandoff';
import { renderWithProviders, LEAD_FIXTURE } from '@/__tests__/helpers';
import { catalogToggle } from '@/__tests__/support/backendSwitchCatalog';

import LeadDetailPage from '../LeadDetailPage';

vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));
vi.mock('@/lib/communication/phoneTabHandoff', () => ({ requestCall: vi.fn() }));
vi.mock('@/components/ui/use-toast', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/ui/use-toast')>()),
  toast: vi.fn(),
}));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const LEAD_ID = 'e0000000-0000-0000-0000-000000000001';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: 'e0000000-0000-0000-0000-000000000001' }),
    useNavigate: () => mockNavigate,
  };
});

const phoneService = vi.hoisted(() => ({ value: true }));
vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => phoneService.value,
}));

const mockApi = vi.mocked(api);
const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

const key = (name: string) => catalogToggle(name).key;
type Holds = { contactDetails?: boolean; copyPhone?: boolean; contact?: boolean };

/** The "Me" answer for a person holding exactly these switches. */
function meAnswer({ contactDetails = false, copyPhone = true, contact = true }: Holds) {
  return {
    admin_box: false,
    values: {
      [key('Copy customer phone')]: copyPhone,
      [key('Copy customer email')]: true,
      [key('Contact customers')]: contact,
      [key('View customers')]: true,
      [key('Edit job and lead contact details')]: contactDetails,
    },
  };
}

const customer = {
  ...LEAD_FIXTURE.customer,
  first_name: 'John',
  last_name: 'Doe',
  company_name: 'Doe HVAC',
  phones: [{ phone: '5551234567', label: 'Mobile', extension: null, is_primary: true }],
  emails: [{ email: 'john@doe.com', label: null, is_primary: true }],
};

const ENTRY = {
  id: 'f0000000-0000-0000-0000-000000000001',
  kind: 'PHONE',
  intent: 'ADDED',
  value: '5550001111',
  extension: null,
  label: "Wife's cell",
  overridden_field: null,
  overridden_row_id: null,
  customer_value_at_change: null,
  created_by: { id: 'u1', name: 'Dana Reyes' },
  created_at: '2026-10-05T15:00:00.000Z',
  updated_by: { id: 'u1', name: 'Dana Reyes' },
  updated_at: '2026-10-05T15:00:00.000Z',
  source_entry_id: null,
};

const leadWith = (over: Record<string, unknown> = {}) => ({
  ...LEAD_FIXTURE,
  customer,
  contact_entries: [],
  // The server's per-lead answer; it lists "edit" for Edit leads and for the creator still on the lead.
  actions: [] as string[],
  ...over,
});

const EDITS_LEAD = ['edit', 'edit_address', 'edit_source', 'edit_schedule'];

function renderLeadPage(holds: Holds, lead = leadWith(), opts: { service?: boolean } = {}) {
  phoneService.value = opts.service ?? true;
  localStorage.clear();
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/permission-switches/me') return { data: meAnswer(holds) };
    if (url.includes('/api/leads/')) return { data: { lead } };
    if (url.includes('/api/users')) return { data: { users: [] } };
    if (url.includes('/api/tags')) return { data: { tags: [] } };
    return { data: {} };
  });
  return renderWithProviders(<LeadDetailPage />, { ability: adminAbility });
}

/** The page once the lead and the person's switches have both arrived. */
async function loaded() {
  await screen.findByText('(555) 123-4567');
  await waitFor(() => expect(mockApi.get).toHaveBeenCalledWith('/api/permission-switches/me'));
}

const BASE = `/api/leads/${LEAD_ID}/contact-entries`;
const NAME_PATH = `${BASE}/name`;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  phoneService.value = true;
});

describe('the pencil on the lead page', () => {
  it('shows on phones and emails with Edit job and lead contact details alone, and not on the name', async () => {
    renderLeadPage({ contactDetails: true });
    await loaded();

    expect(await screen.findByRole('button', { name: 'Change this phone for this lead' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change this email for this lead' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /name for this lead/ })).not.toBeInTheDocument();
  });

  it('shows on phones, emails, name and company when the server lists the lead as one this person edits', async () => {
    renderLeadPage({}, leadWith({ actions: EDITS_LEAD }));
    await loaded();

    expect(await screen.findByRole('button', { name: 'Change this phone for this lead' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change this email for this lead' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change the name for this lead' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change the company name for this lead' })).toBeInTheDocument();
  });

  it('does not show with neither, even for a person whose role could edit leads in general', async () => {
    renderLeadPage({}, leadWith({ actions: [] }));
    await loaded();

    expect(screen.queryByRole('button', { name: /for this lead$/ })).not.toBeInTheDocument();
    expect(screen.queryByText('No phone')).not.toBeInTheDocument();
  });

  it('puts a pencil on an empty No phone line so the first one can be added', async () => {
    const user = userEvent.setup();
    mockApi.post.mockResolvedValue({ data: { entries: [ENTRY] } });
    renderLeadPage({ contactDetails: true }, leadWith({ customer: { ...customer, phone: null, phones: [] } }));
    await screen.findByText('john@doe.com');

    expect(await screen.findByText('No phone')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add a phone for this lead' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('radio')).not.toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Phone number'), '5550001111');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith(BASE, expect.objectContaining({ kind: 'PHONE', value: '(555) 000-1111' })));
  });
});

describe('adding a number or an email for this lead', () => {
  it('saves through the lead endpoint, says it is this lead only, and shows the line marked at once', async () => {
    const user = userEvent.setup();
    mockApi.post.mockResolvedValue({ data: { entries: [ENTRY] } });
    renderLeadPage({ contactDetails: true });
    await loaded();

    await user.click(await screen.findByRole('button', { name: 'Change this phone for this lead' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('This changes the lead only.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('radio', { name: 'Add as another number for this lead' }));
    await user.type(within(dialog).getByLabelText('Phone number'), '555 000 1111');
    await user.type(within(dialog).getByLabelText('Label (optional)'), "Wife's cell");
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith(BASE, {
      kind: 'PHONE', value: '(555) 000-1111', extension: undefined, label: "Wife's cell",
    }));
    expect(toast).toHaveBeenCalledWith({ title: 'Saved on this lead only' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByText('(555) 000-1111')).toBeInTheDocument();
    expect(screen.getByText('This lead only')).toBeInTheDocument();
    expect(screen.getByText("Wife's cell")).toBeInTheDocument();
    expect(screen.getByText(/Dana Reyes/)).toBeInTheDocument();
  });

  it("shows the server's plain refusal in the form and keeps it open", async () => {
    const user = userEvent.setup();
    mockApi.post.mockRejectedValue({ response: { status: 409, data: { error: 'That email is already on this customer' } } });
    renderLeadPage({ contactDetails: true });
    await loaded();

    await user.click(await screen.findByRole('button', { name: 'Change this email for this lead' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('radio', { name: 'Add as another email for this lead' }));
    await user.type(within(dialog).getByLabelText('Email address'), 'john@doe.com');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await within(dialog).findByText('That email is already on this customer')).toBeInTheDocument();
    expect(toast).not.toHaveBeenCalled();
  });
});

describe("a lead's own entries on the block", () => {
  it('shows its marker, label, author and date, and reads to a person with neither switch with no pencil', async () => {
    renderLeadPage({}, leadWith({ contact_entries: [ENTRY] }));
    await loaded();

    expect(screen.getByText('(555) 000-1111')).toBeInTheDocument();
    expect(screen.getByText('This lead only')).toBeInTheDocument();
    expect(screen.getByText("Wife's cell")).toBeInTheDocument();
    expect(screen.getByText(/Dana Reyes/)).toBeInTheDocument();
    expect(screen.getByText(/Oct 5, 2026/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /for this lead$/ })).not.toBeInTheDocument();
  });

  it('follows the copy switch and opens the in-app dialer with the lead attached', async () => {
    const user = userEvent.setup();
    renderLeadPage({ copyPhone: false }, leadWith({ contact_entries: [ENTRY] }));
    await loaded();

    expect(screen.getByText('(555) 000-1111').className).toContain('select-none');
    expect(document.querySelector('a[href^="tel:"]')).toBeNull();

    await user.click(screen.getByRole('button', { name: '(555) 000-1111' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Call' }));

    expect(requestCall).toHaveBeenCalledWith('5550001111', expect.objectContaining({ leadId: LEAD_ID, leadLabel: 'L00001' }));
  });
});

describe("replacing a customer's phone or email on this lead", () => {
  const CHANGED_PHONE = {
    ...ENTRY,
    id: 'f0000000-0000-0000-0000-000000000002',
    intent: 'CHANGED',
    value: '5559876543',
    label: 'New cell',
    overridden_field: 'phone',
    customer_value_at_change: '5551234567',
  };

  it('saves through the change endpoint and shows the lead\'s value marked, with the customer\'s one tap away', async () => {
    const user = userEvent.setup();
    mockApi.post.mockResolvedValue({ data: { entries: [CHANGED_PHONE] } });
    renderLeadPage({ contactDetails: true });
    await loaded();

    await user.click(await screen.findByRole('button', { name: 'Change this phone for this lead' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('radio', { name: 'Replace on this lead' })).toBeChecked();
    const phone = within(dialog).getByLabelText('Phone number');
    await user.clear(phone);
    await user.type(phone, '5559876543');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith(`${BASE}/change`, expect.objectContaining({
      kind: 'PHONE', replaces: '5551234567', value: '(555) 987-6543',
    })));
    expect(await screen.findByText('(555) 987-6543')).toBeInTheDocument();
    expect(screen.getByText('Changed on this lead')).toBeInTheDocument();
    expect(screen.queryByText('(555) 123-4567')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: "Show the customer's phone" }));
    expect(screen.getByText('(555) 123-4567')).toBeInTheDocument();
  });
});

describe('correcting and removing an entry on the lead', () => {
  it('puts an existing entry in the same form with Edit and Remove, for a holder of the contact details switch', async () => {
    const user = userEvent.setup();
    mockApi.patch.mockResolvedValue({ data: { entries: [{ ...ENTRY, label: 'Cell' }] } });
    renderLeadPage({ contactDetails: true }, leadWith({ contact_entries: [ENTRY] }));
    await loaded();

    await user.click(await screen.findByRole('button', { name: 'Edit or remove this phone for this lead' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('radio')).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText('Label (optional)')).toHaveValue("Wife's cell");
    const label = within(dialog).getByLabelText('Label (optional)');
    await user.clear(label);
    await user.type(label, 'Cell');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledWith(`${BASE}/${ENTRY.id}`, expect.objectContaining({ label: 'Cell' })));
    expect(toast).toHaveBeenCalledWith({ title: 'Saved on this lead only' });
  });

  it('removes the entry through the endpoint and the line goes away', async () => {
    const user = userEvent.setup();
    mockApi.delete.mockResolvedValue({ data: { entries: [] } });
    renderLeadPage({ contactDetails: true }, leadWith({ contact_entries: [ENTRY] }));
    await loaded();

    await user.click(await screen.findByRole('button', { name: 'Edit or remove this phone for this lead' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(mockApi.delete).toHaveBeenCalledWith(`${BASE}/${ENTRY.id}`));
    expect(toast).toHaveBeenCalledWith({ title: 'Removed from this lead' });
    await waitFor(() => expect(screen.queryByText('(555) 000-1111')).not.toBeInTheDocument());
  });

  it('gives a holder of the contact details switch alone no way into a name entry', async () => {
    const nameEntry = {
      ...ENTRY, id: 'f0000000-0000-0000-0000-000000000003', kind: 'FIRST_NAME', intent: 'CHANGED', value: 'Johnny',
      label: null, overridden_field: 'first_name', customer_value_at_change: 'John',
    };
    renderLeadPage({ contactDetails: true }, leadWith({ contact_entries: [nameEntry] }));
    await loaded();

    expect(await screen.findByText('Johnny Doe')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /name for this lead/ })).not.toBeInTheDocument();
  });
});

describe("changing the customer's name or company for this lead", () => {
  const NAME_ENTRY = {
    ...ENTRY, id: 'f0000000-0000-0000-0000-000000000011', kind: 'FIRST_NAME', intent: 'CHANGED', value: 'Johnny',
    label: null, overridden_field: 'first_name', customer_value_at_change: 'John',
  };

  it('saves only the part that changed through the name endpoint and shows the new name marked at once', async () => {
    const user = userEvent.setup();
    mockApi.post.mockResolvedValue({ data: { entries: [NAME_ENTRY] } });
    renderLeadPage({}, leadWith({ actions: EDITS_LEAD }));
    await loaded();

    await user.click(await screen.findByRole('button', { name: 'Change the name for this lead' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('This changes the lead only.')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('First name')).toHaveValue('John');
    const first = within(dialog).getByLabelText('First name');
    await user.clear(first);
    await user.type(first, ' Johnny ');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledTimes(1));
    expect(mockApi.post).toHaveBeenCalledWith(NAME_PATH, { kind: 'FIRST_NAME', value: 'Johnny' });
    expect(toast).toHaveBeenCalledWith({ title: 'Saved on this lead only' });
    expect(await screen.findByText('Johnny Doe')).toBeInTheDocument();
    expect(screen.getByText('Changed on this lead')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: "Show the customer's name" }));
    expect(screen.getByText('John Doe')).toBeInTheDocument();
  });

  it("changes the company name through the same endpoint", async () => {
    const user = userEvent.setup();
    const company = { ...NAME_ENTRY, kind: 'COMPANY_NAME', value: 'Doe Heating', overridden_field: 'company_name', customer_value_at_change: 'Doe HVAC' };
    mockApi.post.mockResolvedValue({ data: { entries: [company] } });
    renderLeadPage({}, leadWith({ actions: EDITS_LEAD }));
    await loaded();

    await user.click(await screen.findByRole('button', { name: 'Change the company name for this lead' }));
    const dialog = await screen.findByRole('dialog');
    const name = within(dialog).getByLabelText('Company name');
    await user.clear(name);
    await user.type(name, 'Doe Heating');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith(NAME_PATH, { kind: 'COMPANY_NAME', value: 'Doe Heating' }));
    expect(await screen.findByText('Doe Heating')).toBeInTheDocument();
  });

  it('removes a name change from the form, and the customer\'s own name comes back', async () => {
    const user = userEvent.setup();
    mockApi.delete.mockResolvedValue({ data: { entries: [] } });
    renderLeadPage({}, leadWith({ actions: EDITS_LEAD, contact_entries: [NAME_ENTRY] }));
    await loaded();

    await user.click(await screen.findByRole('button', { name: 'Change the name for this lead' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(mockApi.delete).toHaveBeenCalledWith(`${BASE}/${NAME_ENTRY.id}`));
    expect(toast).toHaveBeenCalledWith({ title: 'Removed from this lead' });
    expect(await screen.findByText('John Doe')).toBeInTheDocument();
  });
});

describe('a closed lead', () => {
  // The line the PRD gives, written out here rather than read from the component.
  const CLOSED_LINE = 'This lead is closed. Reopen it to change its details.';
  const ANYTHING_EDITABLE = /for this lead$|^Edit or remove|Add a (phone|email) for this lead/;

  it.each(['WON', 'LOST'])('shows no pencil, Edit or Remove on a %s lead, whatever the person holds, and says why', async (status) => {
    const edited = { ...ENTRY, id: 'f0000000-0000-0000-0000-0000000000a1' };
    renderLeadPage({ contactDetails: true }, leadWith({ status, actions: EDITS_LEAD, contact_entries: [edited] }));
    await loaded();

    expect(await screen.findByText(CLOSED_LINE)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: ANYTHING_EDITABLE })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /name for this lead/ })).not.toBeInTheDocument();
    // The lead's own entries still read.
    expect(screen.getByText('(555) 000-1111')).toBeInTheDocument();
    expect(screen.getByText('This lead only')).toBeInTheDocument();
  });

  it('shows no "No phone" pencil on a closed lead whose customer has no phone', async () => {
    renderLeadPage({ contactDetails: true }, leadWith({ status: 'LOST', customer: { ...customer, phone: null, phones: [] } }));
    await screen.findByText('john@doe.com');

    expect(await screen.findByText(CLOSED_LINE)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add a phone for this lead/ })).not.toBeInTheDocument();
  });

  it.each(['NEW', 'CONTACTED', 'WALKTHROUGH_SCHEDULED', 'WALKTHROUGH_COMPLETED', 'ESTIMATED'])(
    'keeps the pencils and shows no closed line on a %s lead',
    async (status) => {
      renderLeadPage({ contactDetails: true }, leadWith({ status, actions: EDITS_LEAD, contact_entries: [ENTRY] }));
      await loaded();

      expect(await screen.findByRole('button', { name: 'Change this phone for this lead' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Edit or remove this phone for this lead' })).toBeInTheDocument();
      expect(screen.queryByText(CLOSED_LINE)).not.toBeInTheDocument();
    },
  );
});
