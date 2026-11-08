// Communication ↔ Jobs — Variant A job pills on the SMS center.
//
// Contract under test (locked design):
//   • Every message bubble in a CUSTOMER thread carries a job pill — the
//     tagged job number (ocean) or the muted "no job" pill.
//   • The per-customer Unrouted tray lists inbound messages with no jobId
//     and shows their count.
//   • TEAM and GROUP threads (MessageThread.kind 'team' / 'group') NEVER show
//     job pills — internal lanes are walled off from job attribution. Only
//     kind === 'customer' (incl. kind-less vendor threads) gets job UI.
//   • The right-rail "Jobs · navigation" list renders job_number · service
//     location — never raw UUIDs.
//   • One-click reassign PATCHes /api/communication/sms/:id/job and commits
//     the pill only after the server confirms; a failed PATCH leaves the
//     pill untouched and surfaces an error toast.
//
// The communication seam is real-API only (#229 dropped the mock mode), so the
// reassign flow exercises the actual axios calls — the directory endpoints are
// served from the global @/lib/axios mock below.
import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { SmsInboxView } from '@/components/communication/phone/SmsInboxView';
import type { MessageThread, PhoneCustomer } from '@/lib/api/communication';

const mockApi = vi.mocked(api);

// Radix dropdown-menu internals touch scrollIntoView, which jsdom lacks.
window.HTMLElement.prototype.scrollIntoView = vi.fn();

// floating-ui (under Radix popper) does `new ResizeObserver(...)`; the global
// arrow-fn mock from setup.ts is not constructible, so override with a class.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000077';
const OPEN_JOB_UUID = 'b0000000-0000-0000-0000-000000000042';
const CLOSED_JOB_UUID = 'b0000000-0000-0000-0000-000000000017';
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const CONTACTS_FIXTURE: PhoneCustomer[] = [
  {
    id: CUSTOMER_ID,
    name: 'Rolex 5th Ave',
    type: 'commercial',
    site: '665 Fifth Ave, NY · Vault corridor',
    contacts: [
      {
        id: 'ct_rolex_fm',
        name: 'Daniel Cohen',
        role: 'Facilities Manager',
        preferredLang: 'en',
        channels: [
          { id: 'ch_rolex_s', kind: 'sms', value: '+12125551042', consented: true },
        ],
      },
    ],
  },
];

// Prod shape of GET /api/customers/:id → customer.jobs (UUID ids, human
// job_number, service_location). The UI must surface number · location only.
const CUSTOMER_JOBS_FIXTURE = [
  {
    id: OPEN_JOB_UUID,
    job_number: 'J00042',
    status: 'SCHEDULED',
    service_location: { address_line1: '665 Fifth Ave' },
  },
  {
    id: CLOSED_JOB_UUID,
    job_number: 'J00017',
    status: 'CANCELLED',
    service_location: { address_line1: '30 Rockefeller Plaza' },
  },
];

const CUSTOMER_THREAD: MessageThread = {
  id: 'thr_test_customer',
  customerId: CUSTOMER_ID,
  channel: 'sms',
  campaignType: 'customer_care',
  unread: 0,
  messages: [
    {
      id: 'mt1',
      direction: 'out',
      body: 'Confirmed: Thu 8:00 AM, vault corridor re-key.',
      ts: '2026-06-09T14:00:00Z',
      status: 'delivered',
      jobId: 'b0000000-0000-0000-0000-000000000041',
      jobLabel: 'J00041',
    },
    {
      id: 'mt2',
      direction: 'in',
      body: 'Also, the lobby door is sticking again.',
      ts: '2026-06-09T14:05:00Z',
      status: 'received',
    },
  ],
};

const TEAM_THREAD: MessageThread = {
  id: 'thr_test_team',
  customerId: '',
  channel: 'sms',
  campaignType: 'tech_ops',
  kind: 'team',
  unread: 0,
  title: 'Mike Reyes',
  subtitle: 'Field tech · Manhattan',
  messages: [
    { id: 'tt1', direction: 'in', body: 'On site at Equinox, reader swapped.', ts: '2026-06-09T13:00:00Z' },
    { id: 'tt2', direction: 'out', body: 'Copy — close it out after the lobby test.', ts: '2026-06-09T13:05:00Z' },
  ],
};

// Internal crew lane — like team, NEVER job-attached.
const GROUP_THREAD: MessageThread = {
  id: 'thr_test_group',
  customerId: '',
  channel: 'sms',
  campaignType: 'tech_ops',
  kind: 'group',
  unread: 0,
  title: 'Manhattan locks crew',
  subtitle: '4 members',
  messages: [
    { id: 'gt1', direction: 'in', body: 'Van 3 is loaded for tomorrow.', ts: '2026-06-09T12:00:00Z' },
    { id: 'gt2', direction: 'out', body: 'Great — stage the restricted keyway stock too.', ts: '2026-06-09T12:05:00Z' },
  ],
};

const freshThread = (t: MessageThread): MessageThread => structuredClone(t);

/** Stateful harness so SmsInboxView's setThreads commits are observable. */
function Harness({ initial, onToast = () => {} }: { initial: MessageThread[]; onToast?: (m: string) => void }) {
  const [threads, setThreads] = useState(initial);
  return <SmsInboxView threads={threads} setThreads={setThreads} onToast={onToast} />;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/communication/contacts') return { data: { contacts: CONTACTS_FIXTURE } };
    if (url === '/api/communication/agents') return { data: { agents: [] } };
    if (url === '/api/communication/threads') return { data: { threads: [] } };
    if (url === `/api/customers/${CUSTOMER_ID}`)
      return { data: { customer: { jobs: CUSTOMER_JOBS_FIXTURE } } };
    return { data: {} };
  });
  mockApi.patch.mockResolvedValue({ data: { message: {} } });
});

describe('SmsInboxView — Variant A job pills', () => {
  it('renders the job pill and the muted "no job" pill under customer-thread bubbles', async () => {
    renderWithProviders(
      <SmsInboxView threads={[freshThread(CUSTOMER_THREAD)]} setThreads={vi.fn()} onToast={vi.fn()} />,
    );

    // Tagged outbound message → ocean job pill with the human job number.
    expect((await screen.findAllByText('J00041')).length).toBeGreaterThan(0);
    // Untagged inbound message → muted "no job" pill (badge it, don't hide it).
    expect(screen.getByText('no job')).toBeInTheDocument();
  });

  it('shows the Unrouted tray with the count of inbound no-job messages', async () => {
    renderWithProviders(
      <SmsInboxView threads={[freshThread(CUSTOMER_THREAD)]} setThreads={vi.fn()} onToast={vi.fn()} />,
    );

    // The context panel renders once the customer directory resolves.
    const header = await screen.findByText('Unrouted');
    // Count pill lives in the tray header row.
    expect(within(header.parentElement as HTMLElement).getByText('1')).toBeInTheDocument();
    // The unrouted inbound's snippet is listed with an assign control.
    expect(screen.getAllByText('Also, the lobby door is sticking again.').length).toBeGreaterThan(0);
    expect(screen.getByText('Assign')).toBeInTheDocument();
  });

  it('never renders job pills or the Unrouted tray on a TEAM thread', async () => {
    renderWithProviders(
      <SmsInboxView threads={[freshThread(TEAM_THREAD)]} setThreads={vi.fn()} onToast={vi.fn()} />,
    );

    // Let the async directory settle so the side panel has rendered.
    await screen.findByText('Internal team thread');
    // The team thread's messages render…
    expect(screen.getByText('On site at Equinox, reader swapped.')).toBeInTheDocument();
    // …but the internal lane is walled off: no pills, no tray.
    expect(screen.queryByText('no job')).not.toBeInTheDocument();
    expect(screen.queryByText('J00041')).not.toBeInTheDocument();
    expect(screen.queryByText('Unrouted')).not.toBeInTheDocument();
  });

  it('never renders job pills, assign menus, or the Unrouted tray on a GROUP (crew) thread', async () => {
    renderWithProviders(
      <SmsInboxView threads={[freshThread(GROUP_THREAD)]} setThreads={vi.fn()} onToast={vi.fn()} />,
    );

    // The group conversation renders…
    expect(await screen.findByText('Van 3 is loaded for tomorrow.')).toBeInTheDocument();
    // …but internal lanes (team AND group) get no job attribution UI at all.
    expect(screen.queryByText('no job')).not.toBeInTheDocument();
    expect(screen.queryByText('Unrouted')).not.toBeInTheDocument();
    expect(screen.queryByText('Assign')).not.toBeInTheDocument();
    expect(screen.queryByText('Jobs · navigation')).not.toBeInTheDocument();
  });
});

describe('SmsInboxView — right-rail job navigation', () => {
  it('renders entries as job_number · service location with no raw UUID fragments', async () => {
    renderWithProviders(
      <SmsInboxView threads={[freshThread(CUSTOMER_THREAD)]} setThreads={vi.fn()} onToast={vi.fn()} />,
    );

    const header = await screen.findByText('Jobs · navigation');
    const rail = header.parentElement as HTMLElement;
    const entries = within(rail).getAllByRole('button');
    expect(entries).toHaveLength(2);
    expect(entries[0]).toHaveTextContent('J00042 · 665 Fifth Ave');
    expect(entries[1]).toHaveTextContent('J00017 · 30 Rockefeller Plaza');
    for (const entry of entries) {
      const text = entry.textContent ?? '';
      expect(text).not.toMatch(UUID_RE);
      expect(text).not.toContain(OPEN_JOB_UUID.slice(0, 8));
      expect(text).not.toContain(CLOSED_JOB_UUID.slice(0, 8));
    }
  });
});

describe('SmsInboxView — one-click reassign', () => {
  it('PATCHes /api/communication/sms/:id/job with { job_id } and updates the pill on success', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const onToast = vi.fn();
    const { queryClient } = renderWithProviders(
      <Harness initial={[freshThread(CUSTOMER_THREAD)]} onToast={onToast} />,
    );
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    // Open the assign menu from the untagged inbound's "no job" pill.
    const noJobPill = await screen.findByTitle('No job — click to assign');
    await user.click(noJobPill);

    // The menu lists OPEN (non-cancelled) jobs only, as number · location.
    const menuItem = await screen.findByRole('menuitem', { name: /J00042/ });
    expect(menuItem).toHaveTextContent('J00042 · 665 Fifth Ave');
    expect(screen.queryByRole('menuitem', { name: /J00017/ })).not.toBeInTheDocument();
    await user.click(menuItem);

    await waitFor(() =>
      expect(mockApi.patch).toHaveBeenCalledWith('/api/communication/sms/mt2/job', {
        job_id: OPEN_JOB_UUID,
      }),
    );
    // The pill commits once the server confirms.
    expect(await screen.findByTitle('Tagged to J00042 — click to reassign')).toBeInTheDocument();
    expect(screen.queryByText('no job')).not.toBeInTheDocument();
    expect(onToast).toHaveBeenCalledWith('Tagged to J00042');

    // Cross-surface sync: the job tab + customer roll-up caches refetch too
    // (prefix invalidation — matches every ['job-communications', jobId]).
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['job-communications'] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['customer-communications'] });
    });
  });

  it('keeps the pill untouched and surfaces an error toast when the PATCH fails', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const onToast = vi.fn();
    mockApi.patch.mockRejectedValue(new Error('500'));
    renderWithProviders(<Harness initial={[freshThread(CUSTOMER_THREAD)]} onToast={onToast} />);

    const noJobPill = await screen.findByTitle('No job — click to assign');
    await user.click(noJobPill);
    await user.click(await screen.findByRole('menuitem', { name: /J00042/ }));

    await waitFor(() => expect(mockApi.patch).toHaveBeenCalled());
    // Server said no → no local commit, no false success.
    await waitFor(() =>
      expect(onToast).toHaveBeenCalledWith(expect.stringMatching(/couldn.t|try again/i)),
    );
    expect(screen.getByText('no job')).toBeInTheDocument();
    expect(screen.queryByTitle('Tagged to J00042 — click to reassign')).not.toBeInTheDocument();
    expect(onToast).not.toHaveBeenCalledWith('Tagged to J00042');
  });
});
