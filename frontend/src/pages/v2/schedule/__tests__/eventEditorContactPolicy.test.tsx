/* =============================================================================
   Roles & Permissions, PRD 5, slice S05.3 - the schedule's visit editor draws the customer's primary phone and
   each crew member's phone through the contact display policy. Renders the ROUTED editor
   (pages/v2/schedule/components/eventEditor).

   The person's switches come from the "Me" answer, keyed by the catalog's own keys (read from the backend
   catalog file, never typed here). Every case is a custom switch set, never a built-in role name.
   ========================================================================== */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders, seedMySwitches } from '@/__tests__/helpers';
import { catalogToggle } from '@/__tests__/support/backendSwitchCatalog';
import { asWallClock } from '@/lib/schedule-tz';
import { formatPhone } from '@/lib/utils';
import type { SchedulableEvent } from '@/components/schedule/scheduleModel';
import type { AssignableUser } from '@/lib/api/users';
import api from '@/lib/axios';
import { requestCall } from '@/lib/communication/phoneTabHandoff';
import { CALL_NOT_SET_UP_MESSAGE } from '@/components/contact/contactDisplayPolicy';

import { EventEditor } from '../components/eventEditor';

const navigate = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));

vi.mock('@/lib/communication/phoneTabHandoff', () => ({ requestCall: vi.fn() }));

// Whether the company has the phone service, toggled per test.
const phoneService = vi.hoisted(() => ({ value: true }));
vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => phoneService.value,
}));

type Switches = { copyPhone: boolean; contact: boolean; view?: boolean };

/** The person's switches: drawn on the first paint from the last known answer, and confirmed by the "Me" request. */
function seed(s: Switches) {
  const values = {
    [catalogToggle('Copy customer phone').key]: s.copyPhone,
    [catalogToggle('Contact customers').key]: s.contact,
    [catalogToggle('View customers').key]: s.view === true,
  };
  seedMySwitches(values);
  vi.mocked(api.get).mockImplementation(async (url: string) =>
    url === '/api/permission-switches/me' ? { data: { admin_box: false, values } } : { data: MEMBERS },
  );
}

const MEMBERS: AssignableUser[] = [
  { id: 'u-alice', first_name: 'Alice', last_name: 'Ng', role: 'TECHNICIAN', department: null },
];

const CUSTOMER_PHONE = '5550199123';
const CREW_PHONE = '5550101234';

const job: SchedulableEvent = {
  boardId: 'job-1',
  parentId: 'job-1',
  type: 'job',
  number: 'J00043',
  title: 'Rooftop Unit Swap',
  customer: 'Acme Corp',
  crew: ['u-alice'],
  ownerId: null,
  start: asWallClock(new Date(2026, 5, 10, 9, 0)),
  end: asWallClock(new Date(2026, 5, 10, 11, 0)),
  raw: {
    status: 'SCHEDULED',
    // The schedule feed carries the customer's primary phone AND primary email; the editor shows the phone only.
    customer: { id: 'cust-1', phone: CUSTOMER_PHONE, email: 'ops@acme-example.test' },
    service_location: { address_line1: '12 Depot Way', city: 'Austin', state: 'TX' },
    assignees: [{ user: { id: 'u-alice', first_name: 'Alice', last_name: 'Ng', phone: CREW_PHONE } }],
  },
};

function renderEditor(event: SchedulableEvent = job, readOnly = false) {
  renderWithProviders(
    <EventEditor
      open
      event={event}
      members={MEMBERS}
      readOnly={readOnly}
      canAssignOthers
      canUnschedule
      onSaveCrew={vi.fn()}
      onSaveTime={vi.fn()}
      onUnschedule={vi.fn()}
      onComplete={vi.fn()}
      onClose={vi.fn()}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  phoneService.value = true;
  vi.mocked(api.get).mockResolvedValue({ data: MEMBERS });
});

const noNativeLinks = () => {
  expect(document.querySelector('a[href^="tel:"]')).toBeNull();
  expect(document.querySelector('a[href^="sms:"]')).toBeNull();
};

describe('the visit editor with the phone service and Contact customers on', () => {
  beforeEach(() => seed({ copyPhone: false, contact: true }));

  it('opens the in-app dialer for the customer, attributed to the visit and the customer, and Text opens that customer\'s thread', async () => {
    const user = userEvent.setup();
    seed({ copyPhone: false, contact: true, view: true });
    renderEditor();

    await user.click(await screen.findByRole('button', { name: 'Call Acme Corp' }));
    expect(requestCall).toHaveBeenCalledWith(CUSTOMER_PHONE, { jobId: 'job-1', customerId: 'cust-1', customerName: 'Acme Corp' });
    expect(screen.getByRole('link', { name: 'Text Acme Corp' })).toHaveAttribute('href', '/communication/text?customerId=cust-1');
  });

  it('sends Text to the composer by the tapped number, with the visit\'s job and the name, when the person may not view customers', async () => {
    renderEditor();

    const href = (await screen.findByRole('link', { name: 'Text Acme Corp' })).getAttribute('href')!;
    const target = new URL(href, 'https://app.test');
    expect(target.pathname).toBe('/communication/text');
    expect(Object.fromEntries(target.searchParams)).toEqual({
      to: CUSTOMER_PHONE,
      owner: 'customer',
      name: 'Acme Corp',
      jobId: 'job-1',
    });
  });

  it('opens the in-app dialer for a crew member with the visit attached, and Text goes by the number', async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.click(await screen.findByRole('button', { name: 'Call Alice Ng' }));
    expect(requestCall).toHaveBeenCalledWith(CREW_PHONE, { jobId: 'job-1' });
    expect(screen.getByRole('link', { name: 'Text Alice Ng' })).toHaveAttribute('href', `/communication/text?to=${CREW_PHONE}`);
  });

  it('renders no native phone or text link, and shows no email', async () => {
    renderEditor();
    await screen.findByRole('button', { name: 'Call Acme Corp' });

    noNativeLinks();
    expect(document.body.textContent).not.toContain('ops@acme-example.test');
    expect(document.querySelector('a[href^="mailto:"]')).toBeNull();
  });
});

describe('the visit editor with the phone service and Contact customers off', () => {
  beforeEach(() => seed({ copyPhone: false, contact: false }));

  it('offers no call or text on any phone, and no native link', async () => {
    renderEditor();
    await screen.findByText('Alice Ng', { selector: 'p' });

    expect(screen.queryByRole('button', { name: /^Call/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Text/ })).not.toBeInTheDocument();
    noNativeLinks();
  });

  it('shows the crew phone as plain selectable digits, and the customer phone as digits that cannot be selected', async () => {
    renderEditor();

    const crew = await screen.findByText(formatPhone(CREW_PHONE));
    expect(crew.className).not.toContain('select-none');
    const customer = screen.getByText(formatPhone(CUSTOMER_PHONE));
    expect(customer.className).toContain('select-none');
    expect(screen.queryByRole('button', { name: 'Copy phone number' })).not.toBeInTheDocument();
  });

  it('does not open the job page when the digits are clicked, double-clicked or selected to copy', async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.dblClick(await screen.findByText(formatPhone(CREW_PHONE)));
    await user.click(screen.getByText(formatPhone(CUSTOMER_PHONE)));
    expect(navigate).not.toHaveBeenCalled();
  });

  it('does not open the job page on a click that ends a text selection', async () => {
    renderEditor();
    const title = await screen.findByRole('heading', { name: /J00043/ });
    const range = document.createRange();
    range.selectNodeContents(title);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);

    // A drag-select ends in a click on the common ancestor; the mouse-down of a user-event click would collapse it.
    fireEvent.click(title);
    expect(navigate).not.toHaveBeenCalled();
    window.getSelection()?.removeAllRanges();
  });

  it('still opens the job page from dead space with nothing selected', async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.click(await screen.findByRole('heading', { name: /J00043/ }));
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('puts a copy control on the customer phone only when Copy customer phone is on', async () => {
    seed({ copyPhone: true, contact: false });
    renderEditor();

    const customer = await screen.findByText(formatPhone(CUSTOMER_PHONE));
    expect(customer.className).not.toContain('select-none');
    expect(screen.getAllByRole('button', { name: 'Copy phone number' })).toHaveLength(1);
  });
});

describe('the visit editor without the phone service', () => {
  beforeEach(() => {
    phoneService.value = false;
  });

  it('keeps the customer\'s native call and text links when Copy customer phone is on', async () => {
    seed({ copyPhone: true, contact: false });
    renderEditor();

    expect(await screen.findByRole('link', { name: 'Call Acme Corp' })).toHaveAttribute('href', `tel:${CUSTOMER_PHONE}`);
    expect(screen.getByRole('link', { name: 'Text Acme Corp' })).toHaveAttribute('href', `sms:${CUSTOMER_PHONE}`);
  });

  it('shows the customer\'s digits only, a disabled Call and the plain support message when Copy customer phone is off', async () => {
    seed({ copyPhone: false, contact: true });
    renderEditor();

    expect(await screen.findByRole('button', { name: 'Call Acme Corp' })).toBeDisabled();
    expect(screen.getByText(CALL_NOT_SET_UP_MESSAGE)).toBeInTheDocument();
    expect(screen.getByText(formatPhone(CUSTOMER_PHONE)).className).toContain('select-none');
    expect(screen.queryByRole('link', { name: 'Call Acme Corp' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Text Acme Corp' })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/ctm|calltracking|twilio|supabase|render\b/i);
  });

  it.each([
    { copyPhone: false, contact: false },
    { copyPhone: true, contact: true },
  ])('keeps native call and text links on a crew phone whatever the switches say (%o)', async (switches) => {
    seed(switches);
    renderEditor();

    expect(await screen.findByRole('link', { name: 'Call Alice Ng' })).toHaveAttribute('href', `tel:${CREW_PHONE}`);
    expect(screen.getByRole('link', { name: 'Text Alice Ng' })).toHaveAttribute('href', `sms:${CREW_PHONE}`);
  });
});

describe('the visit editor for a person who may not change the crew', () => {
  it('draws the saved crew phones through the same policy', async () => {
    seed({ copyPhone: false, contact: true });
    renderEditor(job, true);

    expect(await screen.findByRole('button', { name: 'Call Alice Ng' })).toBeInTheDocument();
    noNativeLinks();
  });
});
