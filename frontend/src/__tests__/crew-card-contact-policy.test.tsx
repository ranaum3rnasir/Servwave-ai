/* =============================================================================
   Roles & Permissions, PRD 5, slice S05.3 - the job page's crew card (the Team card) draws each person's phone
   through the contact display policy. Renders the ROUTED job page (pages/v2/jobs/JobDetailPage), whose Overview
   tab holds the card.

   The person's switches come from the "Me" answer, keyed by the catalog's own keys (read from the backend
   catalog file, never typed here). Every case is a custom switch set, never a built-in role name.
   ========================================================================== */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders, ALL_JOB_ACTIONS } from './helpers';
import JobDetailPage from '@/pages/v2/jobs/JobDetailPage';
import { buildAbility } from '@/lib/ability';
import { requestCall } from '@/lib/communication/phoneTabHandoff';
import { formatPhone } from '@/lib/utils';
import { catalogToggle } from './support/backendSwitchCatalog';

vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));
vi.mock('@/lib/communication/phoneTabHandoff', () => ({ requestCall: vi.fn() }));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: 'j0000000-0000-0000-0000-000000000001' }) };
});

// Whether the company has the phone service, toggled per test.
const phoneService = vi.hoisted(() => ({ value: true }));
vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => phoneService.value,
}));

const mockApi = vi.mocked(api);
const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

type Switches = { copyPhone: boolean; contact: boolean };

/** The "Me" answer for a person holding exactly these two switches. */
function meAnswer(s: Switches) {
  return {
    admin_box: false,
    values: {
      [catalogToggle('Copy customer phone').key]: s.copyPhone,
      [catalogToggle('Contact customers').key]: s.contact,
      [catalogToggle('View customers').key]: true,
    },
  };
}

const JOB_ID = 'j0000000-0000-0000-0000-000000000001';
const DISPATCHER_PHONE = '5551230001';
const TECH_PHONE = '5551230002';

const JOB = {
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
  customer: {
    id: 'c0000000-0000-0000-0000-000000000001',
    first_name: 'John',
    last_name: 'Doe',
    company_name: null,
    email: 'john@doe.com',
    phone: '5551234567',
  },
  dispatcher: { id: 'u-dana', first_name: 'Dana', last_name: 'Brooks', phone: DISPATCHER_PHONE },
  salesperson: null,
  assignees: [{ user: { id: 'u-tess', first_name: 'Tess', last_name: 'Ward', role: 'TECHNICIAN', phone: TECH_PHONE } }],
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
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/permission-switches/me') return { data: meAnswer(switches) };
    if (url.includes('/api/jobs/')) return { data: { job: JOB } };
    return { data: {} };
  });
  return renderWithProviders(<JobDetailPage />, { ability: adminAbility });
}

/** The crew card, once the page has drawn it. */
async function crewCard() {
  const heading = await screen.findByText('Assigned Technicians');
  return heading.closest('div[class*="rounded-card"]') as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  // The shared reader keeps the last answer per person; a case starts without the previous case's.
  localStorage.clear();
  phoneService.value = true;
});

describe('the crew card in a company with the phone service', () => {
  it('opens the in-app dialer with the job attached when a crew member is called, and the in-app composer for Text', async () => {
    const user = userEvent.setup();
    renderJobPage({ copyPhone: false, contact: true });
    const card = await crewCard();

    await user.click(await within(card).findByRole('button', { name: 'Call Tess Ward' }));
    expect(requestCall).toHaveBeenCalledWith(TECH_PHONE, { jobId: JOB_ID, jobLabel: 'J00001' });

    // The crew member is not the customer: Text goes by the number, not by a customer.
    expect(within(card).getByRole('link', { name: 'Text Tess Ward' })).toHaveAttribute('href', `/communication/text?to=${TECH_PHONE}`);
    // The dispatcher on the same card is handled the same way.
    await user.click(within(card).getByRole('button', { name: 'Call Dana Brooks' }));
    expect(requestCall).toHaveBeenLastCalledWith(DISPATCHER_PHONE, { jobId: JOB_ID, jobLabel: 'J00001' });
  });

  it('leaves no native phone or text link on the page for a person who may contact customers', async () => {
    renderJobPage({ copyPhone: true, contact: true });
    const card = await crewCard();
    await within(card).findByRole('button', { name: 'Call Tess Ward' });

    expect(document.querySelector('a[href^="tel:"]')).toBeNull();
    expect(document.querySelector('a[href^="sms:"]')).toBeNull();
  });

  it('shows a crew phone as plain selectable digits, with no action and no native link, with Contact customers off', async () => {
    renderJobPage({ copyPhone: true, contact: false });
    const card = await crewCard();

    const digits = await within(card).findAllByText(formatPhone(TECH_PHONE));
    expect(digits.length).toBeGreaterThan(0);
    for (const el of digits) expect(el.className).not.toContain('select-none');
    expect(within(card).queryByRole('button', { name: /^Call/ })).not.toBeInTheDocument();
    expect(within(card).queryByRole('link', { name: /^Text/ })).not.toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: /^Text/ })).not.toBeInTheDocument();
    expect(card.querySelector('a[href^="tel:"]')).toBeNull();
    expect(card.querySelector('a[href^="sms:"]')).toBeNull();
    expect(document.querySelector('a[href^="tel:"]')).toBeNull();
    // A crew phone is not customer data: the customer copy switch does not put a copy control on it.
    expect(within(card).queryByRole('button', { name: 'Copy phone number' })).not.toBeInTheDocument();
  });

  it('keeps the crew phone selectable even when the person may not copy customer phones', async () => {
    renderJobPage({ copyPhone: false, contact: false });
    const card = await crewCard();

    const digits = await within(card).findAllByText(formatPhone(DISPATCHER_PHONE));
    for (const el of digits) expect(el.className).not.toContain('select-none');
  });
});

describe('the crew card in a company without the phone service', () => {
  it.each([
    { copyPhone: false, contact: false },
    { copyPhone: true, contact: true },
  ])('keeps native call and text links on a crew phone whatever the switches say (%o)', async (switches) => {
    renderJobPage(switches, { service: false });
    const card = await crewCard();

    expect(await within(card).findByRole('link', { name: 'Call Tess Ward' })).toHaveAttribute('href', `tel:${TECH_PHONE}`);
    expect(within(card).getByRole('link', { name: 'Text Tess Ward' })).toHaveAttribute('href', `sms:${TECH_PHONE}`);
    expect(requestCall).not.toHaveBeenCalled();
  });
});
