import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { addDays, format, startOfWeek } from 'date-fns';
import api from '@/lib/axios';
import { toast } from '@/ui-kit/components/ui/sonner';
import { buildAbility } from '@/lib/ability';
import { GRID_EVENT_ID, GRID_EVENT_TYPE, FROM_MEMBER } from '@/components/schedule/dragChannels';
import { renderSchedule, serveSchedule } from '@/__tests__/harness/schedulePage';
import { useAuthStore } from '@/stores/auth.store';

vi.mock('@/ui-kit/components/ui/sonner', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  toast: vi.fn(),
}));

// Each test starts from the setup file's signed-in user and bare client calls: reset them here, so a test states its own user
// and answers in its own `beforeEach` (`clearAllMocks` keeps implementations).
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useAuthStore).mockReset();
  vi.mocked(api.get).mockReset();
  vi.mocked(api.post).mockReset();
  vi.mocked(api.patch).mockReset();
  vi.mocked(api.put).mockReset();
  vi.mocked(api.delete).mockReset();
});

/**
 * The board makes NO claim about the customer's email (SRVW-243 receipt, retired).
 *
 * Customer notifications come only from automations (scheduling-notifications slice 01 and its
 * follow-up f3). The RESCHEDULE confirm stopped offering a send in slice 01; the UNSCHEDULE
 * confirm followed in f3. Neither request carries a notify key, so whatever `notify` a response
 * happens to carry is not this page's to report: no receipt toast, no error toast. Announcing
 * one would be the old amber panel's false claim arriving one step later, about an email the
 * dispatcher was never asked about.
 */

// The page announces a successful send through sonner, which mounts no Toaster in this harness.

const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);
const mockApi = vi.mocked(api);
const mockToast = vi.mocked(toast);

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const WEEK_START = startOfWeek(new Date(), { weekStartsOn: 0 });
function dayAt(offset: number, hour = 14, minute = 0): string {
  const d = addDays(WEEK_START, offset);
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), hour, minute, 0)).toISOString();
}

const CREW = [{ user: { id: 'm-alice', first_name: 'Alice', last_name: 'Ng' } }];
const VISIT_CREW = [{ user_id: 'm-alice', user: { id: 'm-alice', first_name: 'Alice', last_name: 'Ng' } }];

/** One trip - the commonest shape on the board, and the branch /unassign owns. */
const JOB = {
  id: 'job-1',
  job_number: 'J00041',
  status: 'SCHEDULED',
  scope_notes: 'Rooftop Unit Swap',
  customer: { first_name: 'Ada', last_name: 'Byron', company_name: 'Acme', email: 'ada@acme.test' },
  assignees: CREW,
  tags: [],
  scheduled_start: dayAt(1),
  scheduled_end: dayAt(1, 16),
  visits: [
    {
      id: 'v1', visit_seq: 1, status: 'SCHEDULED', scheduled_at: dayAt(1),
      scheduled_end: dayAt(1, 16), is_all_day: false, assignees: VISIT_CREW,
    },
  ],
};

function mockBoard(jobs: Array<Record<string, unknown>>, leads: Array<Record<string, unknown>> = []) {
  serveSchedule({ jobs: jobs, bucketJobs: [], leads: (p) => (p.walkthrough_after ? leads : []), users: [{ id: 'm-alice', first_name: 'Alice', last_name: 'Ng', is_active: true, role: 'TECHNICIAN' }] });
}

const cellFor = (offset: number) => `week-cell-m-alice-${format(addDays(WEEK_START, offset), 'yyyy-MM-dd')}`;

async function mountBoard(
  jobs: Array<Record<string, unknown>>,
  leads: Array<Record<string, unknown>> = [],
  waitForText: RegExp = /J00041/,
) {
  mockBoard(jobs, leads);
  renderSchedule({ ability: ADMIN });
  await screen.findAllByText(waitForText);
  fireEvent.click(screen.getByRole('button', { name: 'Member' }));
}

async function dropOnDay(boardId: string, toOffset: number, type: 'job' | 'walkthrough' = 'job') {
  const cell = await screen.findByTestId(cellFor(toOffset));
  fireEvent.drop(cell, {
    dataTransfer: {
      getData: (k: string) =>
        k === GRID_EVENT_ID ? boardId : k === FROM_MEMBER ? 'm-alice' : k === GRID_EVENT_TYPE ? type : '',
      types: [GRID_EVENT_ID, FROM_MEMBER],
    },
  });
}

/** Drag the single trip to another day and confirm the move. */
async function dragAndConfirm() {
  await mountBoard([JOB]);
  await dropOnDay('jv-v1', 5);
  fireEvent.click(await screen.findByRole('button', { name: /Confirm reschedule/i }));
}

/** What the server said about the email, in the shape every notify-carrying route returns. */
const NOTIFY = {
  sent: { status: 'sent', providerMessageId: 'msg_1', fromAddress: 'ops@acme.test', fromName: 'Acme' },
  noRecipient: { status: 'skipped', reason: 'no_recipient' },
  suppressed: { status: 'skipped', reason: 'suppressed' },
  failed: { status: 'failed', error: 'provider rejected the message' },
} as const;

const toastText = () => mockToast.mock.calls.map((c) => String(c[0])).join(' | ');

describe('a reschedule makes no claim about the customer email (scheduling-notifications 01)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.patch.mockResolvedValue({ data: {} });
    mockApi.post.mockResolvedValue({ data: {} });
  });

  it('shows no receipt and no error after a move, even when the response carries an outcome', async () => {
    // The request asked for no send, so any `notify` on the response is not this dialog's to
    // report. Announcing one would be the old amber panel's false claim arriving one step later.
    mockApi.patch.mockResolvedValue({ data: { notify: NOTIFY.failed } });
    await dragAndConfirm();

    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledTimes(1));
    expect(mockApi.patch.mock.calls[0]?.[1]).not.toHaveProperty('notify');
    // Give any (wrong) toast a tick to land before asserting its absence.
    await new Promise((r) => setTimeout(r, 50));
    expect(toastText()).not.toMatch(/customer notified/i);
    expect(screen.queryByText(/customer email could not be sent/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/no email address on file/i)).not.toBeInTheDocument();
  });
});

describe('an unschedule makes no claim about the customer email (scheduling-notifications f3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.patch.mockResolvedValue({ data: {} });
    mockApi.post.mockResolvedValue({ data: {} });
  });

  it('shows no receipt and no error after an unschedule, even when the response carries an outcome', async () => {
    mockApi.post.mockImplementation((url: string) =>
      Promise.resolve(
        String(url).endsWith('/unassign') ? { data: { notify: NOTIFY.failed } } : { data: {} },
      ),
    );
    await mountBoard([JOB]);
    const [card] = await screen.findAllByText(/J00041/);
    if (!card) throw new Error('no card to unschedule');
    fireEvent.click(card);
    fireEvent.click(await screen.findByRole('button', { name: /Move to Unscheduled/ }));

    fireEvent.click(screen.getByRole('button', { name: /^Unschedule$/i }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    const call = mockApi.post.mock.calls.find(([url]) => String(url).endsWith('/unassign'));
    expect(call?.[1]).not.toHaveProperty('notify');
    // Give any (wrong) toast a tick to land before asserting its absence.
    await new Promise((r) => setTimeout(r, 50));
    expect(toastText()).not.toMatch(/customer notified/i);
    expect(screen.queryByText(/customer email could not be sent/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/no email address on file/i)).not.toBeInTheDocument();
  });
});
