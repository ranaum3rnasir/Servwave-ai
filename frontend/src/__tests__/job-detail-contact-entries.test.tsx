/* =============================================================================
   Roles & Permissions, PRD 5, slices S05.7 to S05.9 - a job-only phone or email added with the pencil, a
   customer's phone or email replaced for this job only, and any entry corrected or removed whoever added it. Renders the ROUTED job page (pages/v2/jobs/JobDetailPage): its Overview tab holds the customer block.

   The person's switches come from the "Me" answer, keyed by the catalog's own keys (read from the backend
   catalog file, never typed here). Every case is a custom switch set, never a built-in role name.
   ========================================================================== */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { toast } from '@/components/ui/use-toast';
import { ALL_JOB_ACTIONS } from './helpers';
import { renderJobDetail, serveJobDetail, stubBrowser } from '@/__tests__/harness/jobDetailPage';
import { buildAbility } from '@/lib/ability';
import { requestCall } from '@/lib/communication/phoneTabHandoff';
import { catalogToggle } from './support/backendSwitchCatalog';

vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));
vi.mock('@/lib/communication/phoneTabHandoff', () => ({ requestCall: vi.fn() }));
vi.mock('@/components/ui/use-toast', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/ui/use-toast')>()),
  toast: vi.fn(),
}));

stubBrowser();

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: 'j0000000-0000-0000-0000-000000000001' }),
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

const label = (name: string) => catalogToggle(name).key;
type Holds = { contactDetails?: boolean; editJobs?: boolean; copyPhone?: boolean; contact?: boolean; editCustomers?: boolean };

/** The "Me" answer for a person holding exactly these switches. */
function meAnswer({ contactDetails = false, editJobs = false, copyPhone = true, contact = true, editCustomers = false }: Holds) {
  return {
    admin_box: false,
    values: {
      [label('Copy customer phone')]: copyPhone,
      [label('Copy customer email')]: true,
      [label('Contact customers')]: contact,
      [label('View customers')]: true,
      [label('Edit customers')]: editCustomers,
      [label('Edit job and lead contact details')]: contactDetails,
      [label('Edit jobs')]: editJobs,
    },
  };
}

const JOB_ID = 'j0000000-0000-0000-0000-000000000001';

const customer = {
  id: 'c0000000-0000-0000-0000-000000000001',
  first_name: 'John',
  last_name: 'Doe',
  company_name: null,
  email: 'john@doe.com',
  phone: '5551234567',
  phones: [{ phone: '5551234567', label: 'Mobile', extension: null, is_primary: true }],
  emails: [{ email: 'john@doe.com', label: null, is_primary: true }],
};

const ENTRY = {
  id: 'e0000000-0000-0000-0000-000000000001',
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

const jobWith = (over: Record<string, unknown> = {}) => ({
  id: JOB_ID,
  job_number: 'J00001',
  status: 'IN_PROGRESS',
  scope_notes: null,
  estimated_duration: null,
  completion_notes: null,
  scheduled_start: null,
  scheduled_end: null,
  started_at: null,
  completed_at: null,
  cancelled_at: null,
  cancelled_reason: null,
  created_at: '2026-02-01T00:00:00.000Z',
  updated_at: '2026-02-01T00:00:00.000Z',
  customer,
  contact_entries: [],
  assignees: [],
  service_location: { id: 'l1', address_line1: '12 Main St', address_line2: null, city: 'Springfield', state: 'IL', zip: '62701' },
  estimate: null,
  invoices: [],
  linked_estimates: [],
  tags: [],
  source_plan_id: null,
  actions: ALL_JOB_ACTIONS,
  source_plan: null,
  ...over,
});

function renderJobPage(holds: Holds, job = jobWith(), opts: { service?: boolean } = {}) {
  phoneService.value = opts.service ?? true;
  serveJobDetail({
    job,
    routes: [
      { match: (url) => url === '/api/permission-switches/me', data: meAnswer(holds) },
    ],
  });
  return renderJobDetail({ ability: adminAbility });
}

/** The Overview tab's customer card. */
async function card() {
  await screen.findAllByText('(555) 123-4567');
  return screen.getByText('Customer & Contact').closest('div[class*="rounded-card"]') as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  phoneService.value = true;
});

describe('the pencil on the customer block', () => {
  it('shows with Edit job and lead contact details alone', async () => {
    renderJobPage({ contactDetails: true });
    const c = await card();

    expect(await within(c).findByRole('button', { name: 'Change this phone for this job' })).toBeInTheDocument();
    expect(within(c).getByRole('button', { name: 'Change this email for this job' })).toBeInTheDocument();
  });

  it('shows with Edit jobs alone', async () => {
    renderJobPage({ editJobs: true });
    const c = await card();

    expect(await within(c).findByRole('button', { name: 'Change this phone for this job' })).toBeInTheDocument();
    expect(within(c).getByRole('button', { name: 'Change this email for this job' })).toBeInTheDocument();
  });

  it('does not show with neither switch', async () => {
    renderJobPage({});
    const c = await card();

    expect(within(c).queryByRole('button', { name: /for this job$/ })).not.toBeInTheDocument();
    expect(within(c).queryByText('No phone')).not.toBeInTheDocument();
  });
});

describe('adding a number or an email for this job', () => {
  it('adds another number from the existing line, saving through the endpoint and showing it at once', async () => {
    const user = userEvent.setup();
    mockApi.post.mockResolvedValue({ data: { entries: [ENTRY] } });
    renderJobPage({ contactDetails: true });
    const c = await card();

    await user.click(within(c).getByRole('button', { name: 'Change this phone for this job' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('This changes the job only. The office decides at review whether the customer record changes too.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('radio', { name: 'Add as another number for this job' }));
    expect(within(dialog).getByLabelText('Phone number')).toHaveValue('');
    await user.type(within(dialog).getByLabelText('Phone number'), '555 000 1111');
    await user.type(within(dialog).getByLabelText('Label (optional)'), "Wife's cell");
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith(`/api/jobs/${JOB_ID}/contact-entries`, {
      kind: 'PHONE', value: '(555) 000-1111', extension: undefined, label: "Wife's cell",
    }));
    expect(toast).toHaveBeenCalledWith({ title: 'Saved on this job only' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // The new line sits under the customer's own, marked as this job's, with who and when.
    expect(await within(c).findByText('(555) 000-1111')).toBeInTheDocument();
    expect(within(c).getByText('This job only')).toBeInTheDocument();
    expect(within(c).getByText("Wife's cell")).toBeInTheDocument();
    expect(within(c).getByText(/Dana Reyes/)).toBeInTheDocument();
  });

  it('adds the first phone from the empty "No phone" line, with no replace choice', async () => {
    const user = userEvent.setup();
    mockApi.post.mockResolvedValue({ data: { entries: [ENTRY] } });
    const noPhone = jobWith({ customer: { ...customer, phone: null, phones: [] } });
    renderJobPage({ editJobs: true }, noPhone);
    await screen.findAllByText('john@doe.com');
    const c = screen.getByText('Customer & Contact').closest('div[class*="rounded-card"]') as HTMLElement;

    expect(within(c).getByText('No phone')).toBeInTheDocument();
    await user.click(within(c).getByRole('button', { name: 'Add a phone for this job' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('radio')).not.toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Phone number'), '5550001111');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith(
      `/api/jobs/${JOB_ID}/contact-entries`,
      expect.objectContaining({ kind: 'PHONE', value: '(555) 000-1111' }),
    ));
  });

  it('adds an email, and shows the server\'s plain refusal when it is already on the customer', async () => {
    const user = userEvent.setup();
    mockApi.post.mockRejectedValue({ response: { status: 409, data: { error: 'That email is already on this customer' } } });
    renderJobPage({ contactDetails: true });
    const c = await card();

    await user.click(within(c).getByRole('button', { name: 'Change this email for this job' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('radio', { name: 'Add as another email for this job' }));
    await user.type(within(dialog).getByLabelText('Email address'), 'john@doe.com');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await within(dialog).findByText('That email is already on this customer')).toBeInTheDocument();
    expect(mockApi.post).toHaveBeenCalledWith(`/api/jobs/${JOB_ID}/contact-entries`, { kind: 'EMAIL', value: 'john@doe.com', label: undefined });
    expect(toast).not.toHaveBeenCalled();
  });
});

describe('a job-only entry on the block', () => {
  it('shows its marker, label, author and date beside the customer\'s own values', async () => {
    renderJobPage({}, jobWith({ contact_entries: [ENTRY] }));
    const c = await card();

    expect(within(c).getByText('(555) 000-1111')).toBeInTheDocument();
    expect(within(c).getByText('This job only')).toBeInTheDocument();
    expect(within(c).getByText("Wife's cell")).toBeInTheDocument();
    expect(within(c).getByText(/Dana Reyes/)).toBeInTheDocument();
    expect(within(c).getByText(/Oct 5, 2026/)).toBeInTheDocument();
  });

  it('shows to a person with neither switch, with no pencil', async () => {
    renderJobPage({}, jobWith({ contact_entries: [ENTRY] }));
    const c = await card();

    expect(within(c).getByText('(555) 000-1111')).toBeInTheDocument();
    expect(within(c).queryByRole('button', { name: /for this job$/ })).not.toBeInTheDocument();
  });

  it('follows the copy switch and opens the in-app dialer with the job attached', async () => {
    const user = userEvent.setup();
    renderJobPage({ copyPhone: false }, jobWith({ contact_entries: [ENTRY] }));
    const c = await card();

    // Copy customer phone off: digits only, no copy control, no device link.
    const digits = within(c).getByText('(555) 000-1111');
    expect(digits.className).toContain('select-none');
    expect(within(c).queryByRole('button', { name: 'Copy phone number' })).not.toBeInTheDocument();
    expect(document.querySelector('a[href^="tel:"]')).toBeNull();

    await user.click(within(c).getByRole('button', { name: '(555) 000-1111' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Call' }));

    expect(requestCall).toHaveBeenCalledWith('5550001111', expect.objectContaining({ jobId: JOB_ID, jobLabel: 'J00001' }));
  });

  it('opens the text composer by its number, not by the customer', async () => {
    const user = userEvent.setup();
    renderJobPage({}, jobWith({ contact_entries: [ENTRY] }));
    const c = await card();

    await user.click(within(c).getByRole('button', { name: '(555) 000-1111' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Text' }));

    // By the number, marked as the customer's so the composer draws it under the copy rule; no customer id, no job.
    const target = new URL(mockNavigate.mock.calls[0]![0] as string, 'https://app.test');
    expect(target.pathname).toBe('/communication/text');
    expect(Object.fromEntries(target.searchParams)).toEqual({ to: '5550001111', owner: 'customer', name: 'John Doe' });
  });
});


// ─── S05.8: replace a customer's phone or email on this job only ──────────────────────

const CHANGED_PHONE = {
  ...ENTRY,
  id: 'e0000000-0000-0000-0000-000000000002',
  intent: 'CHANGED',
  value: '5559876543',
  label: 'New cell',
  overridden_field: 'phone',
  customer_value_at_change: '5551234567',
};

const CHANGED_EMAIL = {
  ...ENTRY,
  id: 'e0000000-0000-0000-0000-000000000003',
  kind: 'EMAIL',
  intent: 'CHANGED',
  value: 'john@new.com',
  label: null,
  overridden_field: 'email',
  customer_value_at_change: 'john@doe.com',
};

describe('replacing a customer phone or email on this job', () => {
  it('opens the form on "Replace on this job" with the value filled in, beside the add choice', async () => {
    const user = userEvent.setup();
    renderJobPage({ contactDetails: true });
    const c = await card();

    await user.click(within(c).getByRole('button', { name: 'Change this phone for this job' }));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByRole('radio', { name: 'Replace on this job' })).toBeChecked();
    expect(within(dialog).getByRole('radio', { name: 'Add as another number for this job' })).not.toBeChecked();
    expect(within(dialog).getByLabelText('Phone number')).toHaveValue('(555) 123-4567');
    expect(within(dialog).getByLabelText('Label (optional)')).toHaveValue('Mobile');
  });

  it('saves a replaced phone through the change endpoint and shows it marked, with the customer\'s number one tap away', async () => {
    const user = userEvent.setup();
    mockApi.post.mockResolvedValue({ data: { entries: [CHANGED_PHONE] } });
    renderJobPage({ editJobs: true });
    const c = await card();

    await user.click(within(c).getByRole('button', { name: 'Change this phone for this job' }));
    const dialog = await screen.findByRole('dialog');
    const phone = within(dialog).getByLabelText('Phone number');
    await user.clear(phone);
    await user.type(phone, '5559876543');
    const label = within(dialog).getByLabelText('Label (optional)');
    await user.clear(label);
    await user.type(label, 'New cell');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith(`/api/jobs/${JOB_ID}/contact-entries/change`, {
      kind: 'PHONE', replaces: '5551234567', value: '(555) 987-6543', extension: undefined, label: 'New cell',
    }));
    expect(toast).toHaveBeenCalledWith({ title: 'Saved on this job only' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // The job's value stands where the customer's was, marked; the customer's number is hidden until asked for.
    expect(await within(c).findByText('(555) 987-6543')).toBeInTheDocument();
    expect(within(c).getByText('Changed on this job')).toBeInTheDocument();
    expect(within(c).queryByText('This job only')).not.toBeInTheDocument();
    expect(within(c).queryByText('(555) 123-4567')).not.toBeInTheDocument();

    await user.click(within(c).getByRole('button', { name: "Show the customer's phone" }));

    expect(within(c).getByText('(555) 123-4567')).toBeInTheDocument();
    expect(within(c).getByText(/Customer record/)).toBeInTheDocument();
  });

  it('saves a replaced email through the change endpoint', async () => {
    const user = userEvent.setup();
    mockApi.post.mockResolvedValue({ data: { entries: [CHANGED_EMAIL] } });
    renderJobPage({ contactDetails: true });
    const c = await card();

    await user.click(within(c).getByRole('button', { name: 'Change this email for this job' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Email address')).toHaveValue('john@doe.com');
    const email = within(dialog).getByLabelText('Email address');
    await user.clear(email);
    await user.type(email, 'john@new.com');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith(`/api/jobs/${JOB_ID}/contact-entries/change`, {
      kind: 'EMAIL', replaces: 'john@doe.com', value: 'john@new.com', label: undefined,
    }));
    expect(await within(c).findByText('john@new.com')).toBeInTheDocument();
    expect(within(c).getByText('Changed on this job')).toBeInTheDocument();
  });

  it('shows the server\'s plain "no change" refusal and keeps the form open', async () => {
    const user = userEvent.setup();
    mockApi.post.mockRejectedValue({ response: { status: 409, data: { error: "No change: that is already this customer's number" } } });
    renderJobPage({ contactDetails: true });
    const c = await card();

    await user.click(within(c).getByRole('button', { name: 'Change this phone for this job' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await within(dialog).findByText("No change: that is already this customer's number")).toBeInTheDocument();
    expect(toast).not.toHaveBeenCalled();
  });

  it('shows a changed phone from the job detail in place of the customer\'s, under the copy rules, and not as "This job only"', async () => {
    const user = userEvent.setup();
    renderJobPage({ copyPhone: false }, jobWith({ contact_entries: [CHANGED_PHONE, CHANGED_EMAIL] }));
    await screen.findAllByText('(555) 987-6543');
    const c = screen.getByText('Customer & Contact').closest('div[class*="rounded-card"]') as HTMLElement;

    const digits = within(c).getByText('(555) 987-6543');
    expect(digits.className).toContain('select-none');
    expect(within(c).queryByText('(555) 123-4567')).not.toBeInTheDocument();
    expect(within(c).queryByText('john@doe.com')).not.toBeInTheDocument();
    expect(within(c).getAllByText('Changed on this job')).toHaveLength(2);
    expect(within(c).queryByText('This job only')).not.toBeInTheDocument();
    // Dials the job's number, with the job attached.
    await user.click(within(c).getByRole('button', { name: '(555) 987-6543' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Call' }));
    expect(requestCall).toHaveBeenCalledWith('5559876543', expect.objectContaining({ jobId: JOB_ID }));

    // The customer's own email follows the customer's copy rule when asked for.
    await user.click(within(c).getByRole('button', { name: "Show the customer's email" }));
    expect(within(c).getByText('john@doe.com')).toBeInTheDocument();
  });

  it('keeps an unrelated customer phone as it was beside a changed one', async () => {
    const two = jobWith({
      customer: {
        ...customer,
        phones: [
          { phone: '5551234567', label: 'Mobile', extension: null, is_primary: true },
          { phone: '5552223333', label: 'Office', extension: null, is_primary: false },
        ],
      },
      contact_entries: [CHANGED_PHONE],
    });
    renderJobPage({}, two);
    await screen.findAllByText('(555) 222-3333');
    const c = screen.getByText('Customer & Contact').closest('div[class*="rounded-card"]') as HTMLElement;

    expect(within(c).getByText('(555) 222-3333')).toBeInTheDocument();
    expect(within(c).getByText('(555) 987-6543')).toBeInTheDocument();
    expect(within(c).queryByText('(555) 123-4567')).not.toBeInTheDocument();
  });
});


// ─── S05.9: correct and remove an entry, whoever added it ─────────────────────────────

describe('correcting and removing an entry made by someone else', () => {
  // ENTRY was added by Dana Reyes (u1); the person viewing is not her.
  const entryPencil = (c: HTMLElement) => within(c).getByRole('button', { name: 'Edit or remove this phone for this job' });

  it('shows the pencil on a colleague\'s entry to a holder of Edit job and lead contact details alone, and to a holder of Edit jobs alone', async () => {
    for (const holds of [{ contactDetails: true }, { editJobs: true }]) {
      const { unmount } = renderJobPage(holds, jobWith({ contact_entries: [ENTRY] }));
      const c = await card();
      expect(entryPencil(c)).toBeInTheDocument();
      unmount();
    }
  });

  it('shows no pencil on the entry to a person with neither switch', async () => {
    renderJobPage({}, jobWith({ contact_entries: [ENTRY] }));
    const c = await card();

    expect(within(c).queryByRole('button', { name: /Edit or remove/ })).not.toBeInTheDocument();
  });

  it('opens the form with Edit and Remove, the value and label filled in, and no replace choice', async () => {
    const user = userEvent.setup();
    renderJobPage({ contactDetails: true }, jobWith({ contact_entries: [ENTRY] }));
    const c = await card();

    await user.click(entryPencil(c));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByText('Edit this phone for this job')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Phone number')).toHaveValue('(555) 000-1111');
    expect(within(dialog).getByLabelText('Label (optional)')).toHaveValue("Wife's cell");
    expect(within(dialog).queryByRole('radio')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Remove' })).toBeInTheDocument();
  });

  it('corrects the entry through the endpoint and shows the corrected line at once', async () => {
    const user = userEvent.setup();
    const fixed = { ...ENTRY, value: '5550002222', label: 'Husband', updated_by: { id: 'u2', name: 'Sam Lee' } };
    mockApi.patch.mockResolvedValue({ data: { entries: [fixed] } });
    renderJobPage({ editJobs: true }, jobWith({ contact_entries: [ENTRY] }));
    const c = await card();

    await user.click(entryPencil(c));
    const dialog = await screen.findByRole('dialog');
    const phone = within(dialog).getByLabelText('Phone number');
    await user.clear(phone);
    await user.type(phone, '5550002222');
    const label = within(dialog).getByLabelText('Label (optional)');
    await user.clear(label);
    await user.type(label, 'Husband');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledWith(`/api/jobs/${JOB_ID}/contact-entries/${ENTRY.id}`, {
      value: '(555) 000-2222', extension: '', label: 'Husband',
    }));
    expect(toast).toHaveBeenCalledWith({ title: 'Saved on this job only' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await within(c).findByText('(555) 000-2222')).toBeInTheDocument();
    expect(within(c).getByText('Husband')).toBeInTheDocument();
    expect(within(c).queryByText('(555) 000-1111')).not.toBeInTheDocument();
  });

  it('shows the server\'s plain refusal of a correction and keeps the form open', async () => {
    const user = userEvent.setup();
    mockApi.patch.mockRejectedValue({ response: { status: 409, data: { error: 'That number is already on this customer' } } });
    renderJobPage({ contactDetails: true }, jobWith({ contact_entries: [ENTRY] }));
    const c = await card();

    await user.click(entryPencil(c));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await within(dialog).findByText('That number is already on this customer')).toBeInTheDocument();
    expect(toast).not.toHaveBeenCalled();
  });

  it('removes the entry through the endpoint and the line goes away', async () => {
    const user = userEvent.setup();
    mockApi.delete.mockResolvedValue({ data: { entries: [] } });
    renderJobPage({ contactDetails: true }, jobWith({ contact_entries: [ENTRY] }));
    const c = await card();

    await user.click(entryPencil(c));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(mockApi.delete).toHaveBeenCalledWith(`/api/jobs/${JOB_ID}/contact-entries/${ENTRY.id}`));
    expect(toast).toHaveBeenCalledWith({ title: 'Removed from this job' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(within(c).queryByText('(555) 000-1111')).not.toBeInTheDocument();
    expect(within(c).queryByText('This job only')).not.toBeInTheDocument();
  });

  it('undoes a change: removing it puts the customer\'s own number back, with its own pencil', async () => {
    const user = userEvent.setup();
    mockApi.delete.mockResolvedValue({ data: { entries: [] } });
    renderJobPage({ editJobs: true }, jobWith({ contact_entries: [CHANGED_PHONE] }));
    await screen.findAllByText('(555) 987-6543');
    const c = screen.getByText('Customer & Contact').closest('div[class*="rounded-card"]') as HTMLElement;
    expect(within(c).queryByText('(555) 123-4567')).not.toBeInTheDocument();

    await user.click(entryPencil(c));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText("Removing this puts the customer's number back on this job.")).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));

    expect(await within(c).findByText('(555) 123-4567')).toBeInTheDocument();
    expect(within(c).queryByText('(555) 987-6543')).not.toBeInTheDocument();
    expect(within(c).getByRole('button', { name: 'Change this phone for this job' })).toBeInTheDocument();
  });

  it('puts an email entry in the same form, with the email field', async () => {
    const user = userEvent.setup();
    renderJobPage({ contactDetails: true }, jobWith({ contact_entries: [CHANGED_EMAIL] }));
    await screen.findAllByText('john@new.com');
    const c = screen.getByText('Customer & Contact').closest('div[class*="rounded-card"]') as HTMLElement;

    await user.click(within(c).getByRole('button', { name: 'Edit or remove this email for this job' }));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByText('Edit this email for this job')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Email address')).toHaveValue('john@new.com');
  });
});


// ─── S05.10: change the customer's name or company on this job (Edit jobs) ──────────────

const NAME_ENTRY = {
  ...ENTRY,
  id: 'e0000000-0000-0000-0000-000000000010',
  kind: 'FIRST_NAME',
  intent: 'CHANGED',
  value: 'Johnny',
  extension: null,
  label: null,
  overridden_field: 'first_name',
  customer_value_at_change: 'John',
};

const COMPANY_ENTRY = {
  ...NAME_ENTRY,
  id: 'e0000000-0000-0000-0000-000000000011',
  kind: 'COMPANY_NAME',
  value: 'Doe Tile and Stone',
  overridden_field: 'company_name',
  customer_value_at_change: 'Doe Tile',
};

const withCompany = { ...customer, company_name: 'Doe Tile' };
const NAME_PATH = `/api/jobs/${JOB_ID}/contact-entries/name`;

describe('the pencil on the customer name and company', () => {
  it('shows on the name and company with Edit jobs alone, next to the phone and email pencils', async () => {
    renderJobPage({ editJobs: true }, jobWith({ customer: withCompany }));
    const c = await card();

    expect(await within(c).findByRole('button', { name: 'Change the name for this job' })).toBeInTheDocument();
    expect(within(c).getByRole('button', { name: 'Change the company name for this job' })).toBeInTheDocument();
    expect(within(c).getByRole('button', { name: 'Change this phone for this job' })).toBeInTheDocument();
    expect(within(c).getByRole('button', { name: 'Change this email for this job' })).toBeInTheDocument();
  });

  it('does not show with Edit job and lead contact details alone, which gives phones and emails only', async () => {
    renderJobPage({ contactDetails: true }, jobWith({ customer: withCompany }));
    const c = await card();

    expect(within(c).getByRole('button', { name: 'Change this phone for this job' })).toBeInTheDocument();
    expect(within(c).getByRole('button', { name: 'Change this email for this job' })).toBeInTheDocument();
    expect(within(c).queryByRole('button', { name: /name for this job/ })).not.toBeInTheDocument();
  });

  it('does not show with neither switch', async () => {
    renderJobPage({}, jobWith({ customer: withCompany }));
    const c = await card();

    expect(within(c).queryByRole('button', { name: /for this job$/ })).not.toBeInTheDocument();
  });

  it('gives a customer with no company an empty "No company" line with the pencil, for Edit jobs only', async () => {
    const { unmount } = renderJobPage({ editJobs: true });
    const c = await card();
    expect(within(c).getByText('No company')).toBeInTheDocument();
    expect(within(c).getByRole('button', { name: 'Add a company name for this job' })).toBeInTheDocument();
    unmount();

    renderJobPage({ contactDetails: true });
    const other = await card();
    expect(within(other).queryByText('No company')).not.toBeInTheDocument();
  });
});

describe('a changed name on the block', () => {
  it('shows the job\'s name in the customer\'s place, marked, with the customer\'s name one tap away', async () => {
    const user = userEvent.setup();
    renderJobPage({}, jobWith({ customer: withCompany, contact_entries: [NAME_ENTRY, COMPANY_ENTRY] }));
    const c = await card();

    expect(within(c).getByText('Johnny Doe')).toBeInTheDocument();
    expect(within(c).getByText('Doe Tile and Stone')).toBeInTheDocument();
    expect(within(c).queryByText('John Doe')).not.toBeInTheDocument();
    expect(within(c).queryByText('Doe Tile')).not.toBeInTheDocument();
    expect(within(c).getAllByText('Changed on this job')).toHaveLength(2);
    // No pencil for a person with neither switch.
    expect(within(c).queryByRole('button', { name: /for this job$/ })).not.toBeInTheDocument();

    await user.click(within(c).getByRole('button', { name: "Show the customer's name" }));
    expect(within(c).getByText('John Doe')).toBeInTheDocument();
    await user.click(within(c).getByRole('button', { name: "Show the customer's company name" }));
    expect(within(c).getByText('Doe Tile')).toBeInTheDocument();
  });

  it('keeps the customer\'s last name beside a changed first name, and the name link for a person who may open the customer', async () => {
    renderJobPage({}, jobWith({ contact_entries: [NAME_ENTRY] }));
    const c = await card();

    expect(within(c).getByRole('link', { name: 'Johnny Doe' })).toHaveAttribute('href', `/customers/${customer.id}`);
  });
});

describe('changing the name or company for this job', () => {
  it('saves only the part that changed through the name endpoint and shows the new name marked at once', async () => {
    const user = userEvent.setup();
    mockApi.post.mockResolvedValue({ data: { entries: [NAME_ENTRY] } });
    renderJobPage({ editJobs: true });
    const c = await card();

    await user.click(within(c).getByRole('button', { name: 'Change the name for this job' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('This changes the job only. The office decides at review whether the customer record changes too.')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('First name')).toHaveValue('John');
    expect(within(dialog).getByLabelText('Last name')).toHaveValue('Doe');
    const first = within(dialog).getByLabelText('First name');
    await user.clear(first);
    await user.type(first, ' Johnny ');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledTimes(1));
    expect(mockApi.post).toHaveBeenCalledWith(NAME_PATH, { kind: 'FIRST_NAME', value: 'Johnny' });
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith({ title: 'Saved on this job only' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await within(c).findByText('Johnny Doe')).toBeInTheDocument();
    expect(within(c).getByText('Changed on this job')).toBeInTheDocument();
  });

  it('saves both parts when both changed, one request each, and a single confirmation', async () => {
    const user = userEvent.setup();
    const last = { ...NAME_ENTRY, id: 'e0000000-0000-0000-0000-000000000012', kind: 'LAST_NAME', value: 'Doe-Smith', overridden_field: 'last_name', customer_value_at_change: 'Doe' };
    mockApi.post.mockResolvedValueOnce({ data: { entries: [NAME_ENTRY] } }).mockResolvedValueOnce({ data: { entries: [NAME_ENTRY, last] } });
    renderJobPage({ editJobs: true });
    const c = await card();

    await user.click(within(c).getByRole('button', { name: 'Change the name for this job' }));
    const dialog = await screen.findByRole('dialog');
    await user.clear(within(dialog).getByLabelText('First name'));
    await user.type(within(dialog).getByLabelText('First name'), 'Johnny');
    await user.clear(within(dialog).getByLabelText('Last name'));
    await user.type(within(dialog).getByLabelText('Last name'), 'Doe-Smith');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledTimes(2));
    expect(mockApi.post).toHaveBeenNthCalledWith(1, NAME_PATH, { kind: 'FIRST_NAME', value: 'Johnny' });
    expect(mockApi.post).toHaveBeenNthCalledWith(2, NAME_PATH, { kind: 'LAST_NAME', value: 'Doe-Smith' });
    expect(await within(c).findByText('Johnny Doe-Smith')).toBeInTheDocument();
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('changes the company name through the same endpoint, and sets one where the customer has none', async () => {
    const user = userEvent.setup();
    mockApi.post.mockResolvedValue({ data: { entries: [{ ...COMPANY_ENTRY, customer_value_at_change: '' }] } });
    renderJobPage({ editJobs: true });
    const c = await card();

    await user.click(within(c).getByRole('button', { name: 'Add a company name for this job' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Company name')).toHaveValue('');
    await user.type(within(dialog).getByLabelText('Company name'), 'Doe Tile and Stone');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith(NAME_PATH, { kind: 'COMPANY_NAME', value: 'Doe Tile and Stone' }));
    expect(await within(c).findByText('Doe Tile and Stone')).toBeInTheDocument();
    expect(within(c).getByText('Changed on this job')).toBeInTheDocument();
  });

  it('closes without a request when nothing was changed', async () => {
    const user = userEvent.setup();
    renderJobPage({ editJobs: true });
    const c = await card();

    await user.click(within(c).getByRole('button', { name: 'Change the name for this job' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mockApi.post).not.toHaveBeenCalled();
    expect(mockApi.patch).not.toHaveBeenCalled();
  });

  it('shows the server\'s plain refusal and keeps the form open', async () => {
    const user = userEvent.setup();
    mockApi.post.mockRejectedValue({ response: { status: 400, data: { error: 'Validation failed', details: [{ message: 'Enter a name' }] } } });
    renderJobPage({ editJobs: true });
    const c = await card();

    await user.click(within(c).getByRole('button', { name: 'Change the name for this job' }));
    const dialog = await screen.findByRole('dialog');
    await user.clear(within(dialog).getByLabelText('First name'));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await within(dialog).findByText('Enter a name')).toBeInTheDocument();
    expect(toast).not.toHaveBeenCalled();
  });
});

describe('correcting and removing a changed name', () => {
  it('opens the form on the job\'s value, corrects it through the entry endpoint', async () => {
    const user = userEvent.setup();
    const fixed = { ...NAME_ENTRY, value: 'Jon' };
    mockApi.patch.mockResolvedValue({ data: { entries: [fixed] } });
    renderJobPage({ editJobs: true }, jobWith({ contact_entries: [NAME_ENTRY] }));
    const c = await card();

    await user.click(within(c).getByRole('button', { name: 'Change the name for this job' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('First name')).toHaveValue('Johnny');
    expect(within(dialog).getByText("Removing this puts the customer's name back on this job.")).toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText('First name'));
    await user.type(within(dialog).getByLabelText('First name'), 'Jon');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledWith(`/api/jobs/${JOB_ID}/contact-entries/${NAME_ENTRY.id}`, { value: 'Jon' }));
    expect(await within(c).findByText('Jon Doe')).toBeInTheDocument();
  });

  it('removes the change from the form, and the customer\'s own name comes back', async () => {
    const user = userEvent.setup();
    mockApi.delete.mockResolvedValue({ data: { entries: [] } });
    renderJobPage({ editJobs: true }, jobWith({ contact_entries: [NAME_ENTRY] }));
    const c = await card();

    await user.click(within(c).getByRole('button', { name: 'Change the name for this job' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(mockApi.delete).toHaveBeenCalledWith(`/api/jobs/${JOB_ID}/contact-entries/${NAME_ENTRY.id}`));
    expect(toast).toHaveBeenCalledWith({ title: 'Removed from this job' });
    expect(await within(c).findByText('John Doe')).toBeInTheDocument();
    expect(within(c).queryByText('Changed on this job')).not.toBeInTheDocument();
  });

  it('treats typing the customer\'s own name back as removing the change', async () => {
    const user = userEvent.setup();
    mockApi.delete.mockResolvedValue({ data: { entries: [] } });
    renderJobPage({ editJobs: true }, jobWith({ contact_entries: [NAME_ENTRY] }));
    const c = await card();

    await user.click(within(c).getByRole('button', { name: 'Change the name for this job' }));
    const dialog = await screen.findByRole('dialog');
    await user.clear(within(dialog).getByLabelText('First name'));
    await user.type(within(dialog).getByLabelText('First name'), 'John');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockApi.delete).toHaveBeenCalledWith(`/api/jobs/${JOB_ID}/contact-entries/${NAME_ENTRY.id}`));
    expect(mockApi.patch).not.toHaveBeenCalled();
    expect(await within(c).findByText('John Doe')).toBeInTheDocument();
  });

  it('gives a holder of Edit job and lead contact details alone no way into a name entry', async () => {
    renderJobPage({ contactDetails: true }, jobWith({ contact_entries: [NAME_ENTRY, ENTRY] }));
    const c = await card();

    expect(within(c).getByText('Johnny Doe')).toBeInTheDocument();
    expect(within(c).queryByRole('button', { name: /name for this job/ })).not.toBeInTheDocument();
    // Their phone entry keeps its Edit and Remove.
    expect(within(c).getByRole('button', { name: 'Edit or remove this phone for this job' })).toBeInTheDocument();
  });
});

// S05.11: a Completed, Office review, Ready to close, Done or Cancelled job is locked for a person without Change locked
// jobs. The job detail says so per person (`locked`), and the customer block then has no pencil at all: hidden, not
// disabled. A holder of Change locked jobs gets `locked: false` from the server and the block as before.
describe('the pencil on a locked job', () => {
  const NAMED = jobWith({ customer: withCompany, contact_entries: [ENTRY] });
  const lockedJob = (over: Record<string, unknown> = {}) => ({ ...NAMED, status: 'DONE', locked: true, ...over });
  /** The person's switches have arrived and been applied, so a missing pencil is the lock's doing and not a late answer. */
  const settled = async () => {
    await waitFor(() => expect(mockApi.get).toHaveBeenCalledWith('/api/permission-switches/me'));
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  it('hides every pencil from a person who holds Edit jobs, and the Edit and Remove on a colleague\'s entry', async () => {
    renderJobPage({ editJobs: true, contactDetails: true }, lockedJob());
    const c = await card();
    await settled();

    expect(within(c).getByText('(555) 000-1111')).toBeInTheDocument();
    expect(within(c).queryByRole('button', { name: /for this job$/ })).not.toBeInTheDocument();
    expect(within(c).queryByRole('button', { name: /Edit or remove/ })).not.toBeInTheDocument();
    // The page says why, once, in the lock's own words.
    expect(screen.getByTestId('job-locked-notice')).toHaveTextContent(
      'This job is locked. Only someone who can change locked jobs can change it.',
    );
  });

  it('hides the empty-line pencils for a phone, an email and a company name, and the empty lines with them', async () => {
    renderJobPage({ editJobs: true }, lockedJob({ customer: { ...customer, phone: null, phones: [], email: null, emails: [] }, contact_entries: [] }));
    await screen.findByText('Customer & Contact');
    await settled();
    const c = screen.getByText('Customer & Contact').closest('div[class*="rounded-card"]') as HTMLElement;

    expect(within(c).queryByRole('button', { name: /for this job$/ })).not.toBeInTheDocument();
    expect(within(c).queryByText('No phone')).not.toBeInTheDocument();
    expect(within(c).queryByText('No email')).not.toBeInTheDocument();
  });

  it('shows the same job with every pencil to a person the server does not hold the lock against', async () => {
    renderJobPage({ editJobs: true }, lockedJob({ locked: false }));
    const c = await card();

    expect(await within(c).findByRole('button', { name: 'Change this phone for this job' })).toBeInTheDocument();
    expect(within(c).getByRole('button', { name: 'Change the name for this job' })).toBeInTheDocument();
    expect(within(c).getByRole('button', { name: 'Edit or remove this phone for this job' })).toBeInTheDocument();
  });

  // S06.9: in Office review the lock does not bind a holder of Office review for the customer details. The server says
  // so per person (`contact_locked`, apart from `locked`, which stays true for the job's details); the page never judges the status.
  it('draws the pencils on a job in Office review when the server does not hold the customer details against the person', async () => {
    renderJobPage({ editJobs: true, contactDetails: true }, lockedJob({ status: 'OFFICE_REVIEW', locked: true, contact_locked: false }));
    const c = await card();

    expect(await within(c).findByRole('button', { name: 'Change this phone for this job' })).toBeInTheDocument();
    expect(within(c).getByRole('button', { name: 'Change the name for this job' })).toBeInTheDocument();
    expect(within(c).getByRole('button', { name: 'Edit or remove this phone for this job' })).toBeInTheDocument();
  });

  it('hides the pencils on a job in Office review when the server holds the customer details against the person', async () => {
    renderJobPage({ editJobs: true, contactDetails: true }, lockedJob({ status: 'OFFICE_REVIEW', locked: true, contact_locked: true }));
    const c = await card();
    await settled();

    expect(within(c).getByText('(555) 000-1111')).toBeInTheDocument();
    expect(within(c).queryByRole('button', { name: /for this job$/ })).not.toBeInTheDocument();
  });

  it('hides the pencils once the review is finished, whoever holds Office review', async () => {
    renderJobPage({ editJobs: true, contactDetails: true }, lockedJob({ status: 'READY_TO_CLOSE', locked: true, contact_locked: true }));
    const c = await card();
    await settled();

    expect(within(c).queryByRole('button', { name: /for this job$/ })).not.toBeInTheDocument();
  });

  it('keeps the customer record\'s own "Edit customer" link while the job pencils go', async () => {
    renderJobPage({ editCustomers: true, editJobs: true }, lockedJob());
    const c = await card();
    await settled();

    expect(within(c).getByRole('link', { name: 'Edit customer' })).toHaveAttribute('href', `/customers/${customer.id}/edit`);
    expect(within(c).queryByRole('button', { name: /for this job$/ })).not.toBeInTheDocument();
  });
});

describe('entries carried onto the job from its lead (S05.15)', () => {
  // The server copies the lead's live entries onto the job at conversion: the same intent, value and author, plus the id of the lead entry.
  const LEAD_AUTHOR = { id: 'u2', name: 'Ana Lead' };
  const carried = (entry: typeof ENTRY, from: string) => ({ ...entry, created_by: LEAD_AUTHOR, updated_by: LEAD_AUTHOR, source_entry_id: from });

  it('shows a carried added number and a carried replaced email with their markers, the lead author and the lead entry\'s date', async () => {
    renderJobPage({}, jobWith({ contact_entries: [carried(ENTRY, 'a0000000-0000-0000-0000-000000000001'), carried(CHANGED_EMAIL, 'a0000000-0000-0000-0000-000000000002')] }));
    const c = await card();

    expect(within(c).getByText('(555) 000-1111')).toBeInTheDocument();
    expect(within(c).getByText('This job only')).toBeInTheDocument();
    expect(within(c).getByText('john@new.com')).toBeInTheDocument();
    expect(within(c).getByText('Changed on this job')).toBeInTheDocument();
    expect(within(c).getAllByText(/Ana Lead/)).toHaveLength(2);
    expect(within(c).getAllByText(/Oct 5, 2026/)).toHaveLength(2);
  });

  it('gives a carried entry the same pencil as any job entry, to a holder of the switch', async () => {
    renderJobPage({ contactDetails: true }, jobWith({ contact_entries: [carried(ENTRY, 'a0000000-0000-0000-0000-000000000001')] }));
    const c = await card();

    expect(await within(c).findByRole('button', { name: 'Edit or remove this phone for this job' })).toBeInTheDocument();
  });
});
