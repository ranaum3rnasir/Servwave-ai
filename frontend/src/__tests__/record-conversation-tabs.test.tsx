/**
 * Roles & Permissions, PRD 10, S10.5 - record conversations and their replies on the routed job page's and lead page's
 * Communication tab.
 *
 * The server works the tie out and decides who sees what: an estimate's email and the customer's reply to it come back on
 * the tab of the estimate's job (or lead), a lead-era conversation comes back on both the lead and the job made from it,
 * and a conversation about an invoice the person cannot open is simply not in the answer. The page draws what the answer
 * holds and nothing more, and asks for nothing else that could bring the missing conversation back.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { LEAD_FIXTURE } from './helpers';
import { renderJobDetail, serveJobDetail } from '@/__tests__/harness/jobDetailPage';
import { renderLeadDetail, serveLeadDetail } from '@/__tests__/harness/leadDetailPage';
import type { CommItem } from '@/lib/api/jobCommunications';

const mockApi = vi.mocked(api);

vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => true,
}));
vi.mock('@/lib/communication/phoneTabHandoff', () => ({ requestCall: vi.fn() }));
vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));

const JOB_ID = 'b0000000-0000-0000-0000-000000000042';
const LEAD_ID = LEAD_FIXTURE.id;
const CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000001';
const route = vi.hoisted(() => ({ id: '' }));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: route.id }), useNavigate: () => vi.fn() };
});

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const ability = buildAbility([
  { action: 'manage', subject: 'all' },
]);

const ESTIMATE_EMAIL: CommItem = {
  id: 'ac000000-0000-0000-0000-000000000001', channel: 'email', direction: 'out', who: 'Daniel Cohen', title: 'Estimate E-0042 from Acme',
  preview: 'Here is your estimate.', at: '2026-06-01T14:32:00.000Z', jobId: JOB_ID, jobLabel: 'J00042', transactional: true,
};
const CUSTOMER_REPLY: CommItem = {
  id: 'ac000000-0000-0000-0000-000000000002', channel: 'email', direction: 'in', who: 'Daniel Cohen', title: 'Re: Estimate E-0042 from Acme',
  preview: 'Looks good, please go ahead.', at: '2026-06-01T15:10:00.000Z', jobId: JOB_ID, jobLabel: 'J00042',
};
const LEAD_ERA_EMAIL: CommItem = {
  id: 'ac000000-0000-0000-0000-000000000003', channel: 'email', direction: 'out', who: 'Daniel Cohen', title: 'Estimate E-0007 from Acme',
  preview: 'Sent while this was a lead.', at: '2026-05-20T10:00:00.000Z', leadId: LEAD_ID, leadLabel: 'L00001', transactional: true,
};
const LEAD_ERA_REPLY: CommItem = {
  id: 'ac000000-0000-0000-0000-000000000004', channel: 'email', direction: 'in', who: 'Daniel Cohen', title: 'Re: Estimate E-0007 from Acme',
  preview: 'Sounds fair.', at: '2026-05-20T11:00:00.000Z', leadId: LEAD_ID, leadLabel: 'L00001',
};
const INVOICE_EMAIL_TITLE = 'Invoice INV-0042 from Acme';

/** What the person sees of the lead's and the job's tabs depends on the answer alone; these are the answers. */
function stubJob(items: CommItem[]) {
  const job = {
    id: JOB_ID, job_number: 'J00042', status: 'SCHEDULED', scope_notes: null, estimated_duration: null, completion_notes: null,
    scheduled_start: '2026-10-02T13:00:00.000Z', scheduled_end: '2026-10-02T15:00:00.000Z', started_at: null, completed_at: null,
    created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z',
    customer: { id: CUSTOMER_ID, first_name: 'Daniel', last_name: 'Cohen', company_name: null, email: 'daniel@example.com', phone: '5551234567' },
    assignees: [], visits: [], service_location: null, estimate: null, invoices: [], linked_estimates: [], tags: [],
    source_plan_id: null, source_plan: null, locked: false, locked_actions: [], actions: [], ready_to_close: null,
  };
  serveJobDetail({
    jobId: JOB_ID,
    job,
    routes: [{ match: (url) => url === `/api/jobs/${JOB_ID}/communications`, data: { items } }],
  });
}

function stubLead(items: CommItem[]) {
  serveLeadDetail({
    lead: LEAD_FIXTURE,
    routes: [{ match: (url) => url === `/api/leads/${LEAD_ID}/communications`, data: { items } }],
  });
}

async function openCommunicationTab() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('tab', { name: 'Communication' }));
}

const rowOf = (title: string) => screen.getByText(title).closest('li') as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

describe('the routed job page\'s Communication tab', () => {
  beforeEach(() => { route.id = JOB_ID; });

  it('shows the estimate email and the customer\'s reply to it, the reply as a message from the customer', async () => {
    stubJob([ESTIMATE_EMAIL, CUSTOMER_REPLY]);
    renderJobDetail({ ability });
    await openCommunicationTab();

    expect(await screen.findByText(ESTIMATE_EMAIL.title)).toBeInTheDocument();
    const reply = rowOf(CUSTOMER_REPLY.title);
    expect(within(reply).getByText('Looks good, please go ahead.')).toBeInTheDocument();
    expect(within(reply).getByText(/Inbound/)).toBeInTheDocument();
  });

  it('shows a conversation started while the record was a lead, beside the lead chip it came with', async () => {
    stubJob([LEAD_ERA_EMAIL, LEAD_ERA_REPLY, ESTIMATE_EMAIL]);
    renderJobDetail({ ability });
    await openCommunicationTab();

    const reply = rowOf(LEAD_ERA_REPLY.title);
    expect(within(reply).getByText('Sounds fair.')).toBeInTheDocument();
    expect(within(reply).getByText('L00001')).toBeInTheDocument();
    expect(rowOf(LEAD_ERA_EMAIL.title)).toBeInTheDocument();
  });

  it('draws nothing for an invoice conversation the server left out, and asks for nothing that could bring it back', async () => {
    stubJob([ESTIMATE_EMAIL]);
    renderJobDetail({ ability });
    await openCommunicationTab();
    await screen.findByText(ESTIMATE_EMAIL.title);

    expect(screen.queryByText(INVOICE_EMAIL_TITLE)).not.toBeInTheDocument();
    expect(screen.queryByText(/Re: Invoice/)).not.toBeInTheDocument();
    const asked = mockApi.get.mock.calls.map(([url]) => String(url));
    // The text box's number line (#3023) reads which numbers a text would go between; it carries no conversation.
    expect([...new Set(asked.filter((url) => url.includes('/communication')))].sort()).toEqual([
      '/api/communication/sms/numbers',
      `/api/jobs/${JOB_ID}/communications`,
    ]);
  });
});

describe('the routed lead page\'s Communication tab', () => {
  beforeEach(() => { route.id = LEAD_ID; });

  it('shows the lead\'s estimate email and the customer\'s reply to it', async () => {
    stubLead([LEAD_ERA_EMAIL, LEAD_ERA_REPLY]);
    renderLeadDetail({ ability });
    await openCommunicationTab();

    expect(await screen.findByText(LEAD_ERA_EMAIL.title)).toBeInTheDocument();
    expect(within(rowOf(LEAD_ERA_REPLY.title)).getByText('Sounds fair.')).toBeInTheDocument();
  });

  it('keeps showing the conversations of the job made from the lead, with the job chip they came with', async () => {
    stubLead([LEAD_ERA_EMAIL, { ...CUSTOMER_REPLY, leadId: LEAD_ID, leadLabel: 'L00001' }, ESTIMATE_EMAIL]);
    renderLeadDetail({ ability });
    await openCommunicationTab();

    const reply = rowOf(CUSTOMER_REPLY.title);
    expect(within(reply).getByText('J00042')).toBeInTheDocument();
    expect(rowOf(LEAD_ERA_EMAIL.title)).toBeInTheDocument();
  });

  it('draws nothing for an invoice conversation the server left out', async () => {
    stubLead([LEAD_ERA_EMAIL]);
    renderLeadDetail({ ability });
    await openCommunicationTab();
    await screen.findByText(LEAD_ERA_EMAIL.title);

    expect(screen.queryByText(INVOICE_EMAIL_TITLE)).not.toBeInTheDocument();
    const asked = mockApi.get.mock.calls.map(([url]) => String(url));
    // The text box's number line (#3023) reads which numbers a text would go between; it carries no conversation.
    expect([...new Set(asked.filter((url) => url.includes('/communication')))].sort()).toEqual([
      '/api/communication/sms/numbers',
      `/api/leads/${LEAD_ID}/communications`,
    ]);
  });
});
