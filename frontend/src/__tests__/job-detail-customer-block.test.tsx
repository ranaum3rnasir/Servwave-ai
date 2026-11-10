/* =============================================================================
   Roles & Permissions, PRD 5, slice S05.1 - the job page's customer details under the contact display
   policy. Renders the ROUTED job page (pages/v2/jobs/JobDetailPage): its header and its Overview tab.

   The person's switches come from the "Me" answer, keyed by the catalog's own keys (read from the backend
   catalog file, never typed here). Every case is a custom switch set, never a built-in role name.
   ========================================================================== */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ALL_JOB_ACTIONS } from './helpers';
import { renderJobDetail, serveJobDetail, stubBrowser } from '@/__tests__/harness/jobDetailPage';
import { buildAbility } from '@/lib/ability';
import { requestCall } from '@/lib/communication/phoneTabHandoff';
import { CALL_NOT_SET_UP_MESSAGE } from '@/components/contact/contactDisplayPolicy';
import { catalogToggle } from './support/backendSwitchCatalog';

vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));
vi.mock('@/lib/communication/phoneTabHandoff', () => ({ requestCall: vi.fn() }));

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

// Whether the company has the phone service, toggled per test.
const phoneService = vi.hoisted(() => ({ value: true }));
vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => phoneService.value,
}));

const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

type Switches = { copyPhone: boolean; copyEmail: boolean; contact: boolean; view: boolean };
const EVERYTHING_ON: Switches = { copyPhone: true, copyEmail: true, contact: true, view: true };

/** The "Me" answer for a person holding exactly these four switches. */
function meAnswer(s: Switches) {
  return {
    admin_box: false,
    values: {
      [catalogToggle('Copy customer phone').key]: s.copyPhone,
      [catalogToggle('Copy customer email').key]: s.copyEmail,
      [catalogToggle('Contact customers').key]: s.contact,
      [catalogToggle('View customers').key]: s.view,
    },
  };
}

const JOB = {
  id: 'j0000000-0000-0000-0000-000000000001',
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
  customer: {
    id: 'c0000000-0000-0000-0000-000000000001',
    first_name: 'John',
    last_name: 'Doe',
    company_name: null,
    email: 'john@doe.com',
    phone: '5551234567',
    phones: [
      { phone: '5551234567', label: 'Mobile', extension: null, is_primary: true },
      { phone: '5559876543', label: "Wife's cell", extension: '12', is_primary: false },
    ],
    emails: [
      { email: 'john@doe.com', label: null, is_primary: true },
      { email: 'billing@doe.com', label: 'Billing', is_primary: false },
    ],
  },
  assignees: [],
  service_location: { id: 'l1', address_line1: '12 Main St', address_line2: null, city: 'Springfield', state: 'IL', zip: '62701' },
  estimate: null,
  invoices: [],
  linked_estimates: [],
  tags: [],
  source_plan_id: null,
  actions: ALL_JOB_ACTIONS,
  source_plan: null,
};

function renderJobPage(switches: Switches, opts: { service?: boolean } = {}) {
  phoneService.value = opts.service ?? true;
  serveJobDetail({
    job: JOB,
    routes: [
      { match: (url) => url === '/api/permission-switches/me', data: meAnswer(switches) },
    ],
  });
  return renderJobDetail({ ability: adminAbility });
}

/** The Overview tab's customer card, and whatever else on the page is outside it (the header). */
async function sections() {
  await screen.findAllByText('(555) 123-4567');
  const card = screen.getByText('Customer & Contact').closest('div[class*="rounded-card"]') as HTMLElement;
  return { card };
}

/** Elements matching a query that sit outside the Overview card: the header's own copy. */
const inHeader = (all: HTMLElement[], card: HTMLElement) => all.filter((el) => !card.contains(el));

beforeEach(() => {
  vi.clearAllMocks();
  // The shared reader keeps the last answer per person; a case starts without the previous case's.
  localStorage.clear();
  phoneService.value = true;
});

describe('the job page customer details with Copy customer phone off', () => {
  it('shows the digits with no copy control, no selection and no native link, in the header and on the Overview tab', async () => {
    renderJobPage({ ...EVERYTHING_ON, copyPhone: false }, { service: false });

    await screen.findAllByText('(555) 123-4567');
    expect(screen.queryByRole('button', { name: 'Copy phone number' })).not.toBeInTheDocument();
    expect(document.querySelector('a[href^="tel:"]')).toBeNull();
    expect(document.querySelector('a[href^="sms:"]')).toBeNull();
    for (const digits of screen.getAllByText('(555) 123-4567')) expect(digits.className).toContain('select-none');
    // The second number is listed too, extension included.
    expect(screen.getAllByText('(555) 987-6543 ext. 12').length).toBeGreaterThan(0);
  });

  it('shows the copy control and a device call link with it on, when the company has no phone service', async () => {
    renderJobPage(EVERYTHING_ON, { service: false });

    await screen.findAllByText('(555) 123-4567');
    expect((await screen.findAllByRole('button', { name: 'Copy phone number' })).length).toBeGreaterThan(0);
    expect(document.querySelector('a[href="tel:5551234567"]')).not.toBeNull();
  });

  it('shows the copy control for the person whose switch is on and for no one else', async () => {
    const { unmount } = renderJobPage({ ...EVERYTHING_ON, copyPhone: false });
    await screen.findAllByText('(555) 123-4567');
    expect(screen.queryByRole('button', { name: 'Copy phone number' })).not.toBeInTheDocument();
    unmount();

    renderJobPage({ ...EVERYTHING_ON, copyPhone: true });
    expect((await screen.findAllByRole('button', { name: 'Copy phone number' })).length).toBeGreaterThan(0);
  });
});

describe('the job page customer details with the phone service', () => {
  it('asks the in-app dialer for the number, with the job attached, when a phone is tapped', async () => {
    const user = userEvent.setup();
    renderJobPage({ ...EVERYTHING_ON, copyPhone: false });
    const { card } = await sections();

    const [headerPhone] = inHeader(screen.getAllByRole('button', { name: '(555) 123-4567' }), card);
    await user.click(headerPhone!);
    await user.click(await screen.findByRole('menuitem', { name: 'Call' }));

    expect(requestCall).toHaveBeenCalledWith('5551234567', {
      jobId: JOB.id,
      jobLabel: 'J00001',
      customerId: JOB.customer.id,
      customerName: 'John Doe',
    });
    expect(document.querySelector('a[href^="tel:"]')).toBeNull();
  });

  it('opens the in-app composer from the Overview Text action', async () => {
    const user = userEvent.setup();
    renderJobPage(EVERYTHING_ON);
    const { card } = await sections();

    await user.click(within(card).getByRole('button', { name: 'Text' }));

    // #3017: addressed to the number the job shows, with the job attached, so the text is filed on the job.
    expect(mockNavigate).toHaveBeenCalledWith(`/communication/text?to=5551234567&owner=customer&name=John+Doe&jobId=${JOB.id}`);
    expect(document.querySelector('a[href^="sms:"]')).toBeNull();
  });

  it('offers no Text action on the Overview tab with Contact customers off, even though the company has the phone service', async () => {
    renderJobPage({ ...EVERYTHING_ON, contact: false });
    const { card } = await sections();

    expect(within(card).queryByRole('button', { name: /^Text/ })).not.toBeInTheDocument();
    expect(within(card).queryByRole('link', { name: /^Text/ })).not.toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: /^Call/ })).not.toBeInTheDocument();
    // The digits are still there to dial by hand.
    expect(within(card).getAllByText('(555) 123-4567').length).toBeGreaterThan(0);
  });
});

describe('the job page without the phone service', () => {
  it('shows a disabled Call with the plain support message when the person may not copy the number', async () => {
    renderJobPage({ ...EVERYTHING_ON, copyPhone: false }, { service: false });
    const { card } = await sections();

    const call = within(card).getByRole('button', { name: /^Call/ });
    expect(call).toBeDisabled();
    expect(within(card).getByText(CALL_NOT_SET_UP_MESSAGE)).toBeInTheDocument();
    expect(CALL_NOT_SET_UP_MESSAGE).toBe("Calling from the app isn't set up for your company. Contact ServWave support.");
    // No message on the page names a vendor.
    expect(document.body.textContent).not.toMatch(/ctm|calltracking|twilio|supabase|render\b/i);
  });
});

describe('the customer name', () => {
  it('is plain text in the header and on the Overview tab with View customers off', async () => {
    renderJobPage({ ...EVERYTHING_ON, view: false });
    await sections();

    expect(screen.queryByRole('link', { name: 'John Doe' })).not.toBeInTheDocument();
    expect(screen.getAllByText('John Doe').length).toBeGreaterThanOrEqual(2);
  });

  it('is a link to the customer page in the header and on the Overview tab with View customers on', async () => {
    renderJobPage(EVERYTHING_ON);
    await sections();

    const links = screen.getAllByRole('link', { name: 'John Doe' });
    expect(links.length).toBeGreaterThanOrEqual(2);
    for (const link of links) expect(link.getAttribute('href')).toContain(`/customers/${JOB.customer.id}`);
  });
});

describe('the customer emails', () => {
  it('lists every email on the Overview tab; each is a mail link with Copy customer email on', async () => {
    renderJobPage(EVERYTHING_ON);
    const { card } = await sections();

    expect(within(card).getByRole('link', { name: 'billing@doe.com' })).toHaveAttribute('href', 'mailto:billing@doe.com');
    expect(within(card).getByText('Billing')).toBeInTheDocument();
  });

  it('shows the addresses as plain unselectable text with Copy customer email off', async () => {
    renderJobPage({ ...EVERYTHING_ON, copyEmail: false });
    const { card } = await sections();

    expect(document.querySelector('a[href^="mailto:"]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy email address' })).not.toBeInTheDocument();
    const address = within(card).getByText('billing@doe.com');
    expect(address.className).toContain('select-none');
  });
});

describe('the contact block at phone width', () => {
  it('wraps its rows instead of overflowing', async () => {
    renderJobPage(EVERYTHING_ON);
    const { card } = await sections();

    // Two phones and two emails, each on a row that wraps its label under the value.
    expect(card.querySelectorAll('p.flex-wrap')).toHaveLength(4);
  });
});

