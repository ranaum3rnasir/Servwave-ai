import type { ComponentProps } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import { requestCall } from '@/lib/communication/phoneTabHandoff';
import { JobCommunicationsTab } from '@/components/communication/JobCommunicationsTab';
import type { CommItem } from '@/lib/api/jobCommunications';
import { useAuthStore } from '@/stores/auth.store';

const mockApi = vi.mocked(api);
const mockRequestCall = vi.mocked(requestCall);

// Org-level comms access (E5): the composer + "Call customer" render only for
// comms-enabled orgs. Default true so the composer specs exercise the full
// surface; the gating specs flip it off.
const commAccess = vi.hoisted(() => ({ value: true }));
vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => commAccess.value,
}));

// Task B4 — "Call customer" routes through the cross-tab dial handoff into
// the /phone tab, not the legacy in-app GlobalDialer popup.
vi.mock('@/lib/communication/phoneTabHandoff', () => ({
  requestCall: vi.fn(),
}));

// The detail drawer fetches a CallSession + renders the hub CallDetailDrawer
// (CallsView/Dialer graph) — stub it so these specs stay on the tab's wiring.
vi.mock('@/components/communication/shared/EntityCallDrawer', () => ({
  EntityCallDrawer: ({ callId, onClose }: { callId: string; onClose: () => void }) => (
    <div data-testid="entity-call-drawer" data-call-id={callId}>
      <button type="button" onClick={onClose}>
        close-drawer
      </button>
    </div>
  ),
}));

// The SMS detail drawer re-sources off the row's own thread id (#2046 R1) — stub it so these
// specs stay on the tab's wiring (text row → drawer keyed by threadId).
vi.mock('@/components/communication/shared/EntitySmsDrawer', () => ({
  EntitySmsDrawer: ({ threadId, onClose }: { threadId: string; onClose: () => void }) => (
    <div data-testid="entity-sms-drawer" data-thread-id={threadId}>
      <button type="button" onClick={onClose}>
        close-sms-drawer
      </button>
    </div>
  ),
}));

// Communication ↔ Jobs Slice 1 — the job-page Communication tab renders the
// Variant-A unified timeline from GET /api/jobs/:id/communications and the
// compact composer stamps outgoing texts/emails with this job
// (attach-by-origin).

const JOB_ID = 'b0000000-0000-0000-0000-000000000001';
const CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000001';
const JOB_NUMBER = 'J00042';
const CUSTOMER_EMAIL = 'daniel@vaultcorp.com';
// #2046 (R1) - the row's own thread id, the drawer's new key.
const THREAD_ID = 'sms0000-0000-0000-0000-000000000099';

const ITEMS_FIXTURE: CommItem[] = [
  {
    id: 'call-0000-0000-0000-000000000001',
    channel: 'call',
    direction: 'in',
    who: 'Daniel Cohen',
    title: 'Inbound call · 4m 07s',
    preview: 'Confirmed Thursday 8am. Asked for COI before arrival.',
    at: '2026-06-01T14:32:00.000Z',
    jobId: JOB_ID,
    jobLabel: JOB_NUMBER,
    meta: 'Booked',
  },
  {
    id: 'email-0000-0000-0000-000000000001',
    channel: 'email',
    direction: 'out',
    who: 'Daniel Cohen',
    title: 'Estimate E00012 · Vault corridor re-key',
    preview: '14 cylinders, restricted keyway. Approve to schedule.',
    at: '2026-06-01T15:00:00.000Z',
    jobId: JOB_ID,
    jobLabel: JOB_NUMBER,
    transactional: true,
  },
  {
    id: 'sms-0000-0000-0000-000000000001',
    channel: 'sms',
    direction: 'out',
    who: 'Daniel Cohen',
    title: 'Text message',
    preview: 'Confirming Thursday 8am for the vault corridor re-key.',
    at: '2026-06-01T15:10:00.000Z',
    jobId: JOB_ID,
    jobLabel: JOB_NUMBER,
    threadId: THREAD_ID,
  },
  {
    // Cold inbound — no job attribution → muted "no job" badge.
    id: 'wa-0000-0000-0000-000000000001',
    channel: 'whatsapp',
    direction: 'in',
    who: 'Daniel Cohen',
    title: 'WhatsApp message',
    preview: 'Also — do you service our Newark branch?',
    at: '2026-06-02T09:30:00.000Z',
  },
];

// A hand-logged entry (manual communication log). Its channel is `call` - that is what the
// logger recorded - but its id belongs to manual_communication_logs, not call_sessions.
const LOGGED_CALL_ITEM: CommItem = {
  id: '11110000-0000-0000-0000-000000000011',
  channel: 'call',
  direction: 'out',
  who: 'Daniel Cohen',
  title: 'Outbound call',
  preview: 'Rang from my mobile to confirm the install window.',
  at: '2026-06-01T16:00:00.000Z',
  jobId: JOB_ID,
  jobLabel: JOB_NUMBER,
  manuallyLogged: true,
  loggedByName: 'Test Admin',
  // WHO TYPED IT, by id (slice 8) - what the row's edit affordance is decided from. The literal
  // is the auth-store fixture's own user (setup.ts), i.e. "the viewer logged this one".
  loggedById: '00000000-0000-0000-0000-000000000001',
};

// C6b - the same defect on a different channel: a logged TEXT's arm opens the customer's REAL
// SMS thread, a conversation this entry was never part of.
const LOGGED_TEXT_ITEM: CommItem = {
  id: '11110000-0000-0000-0000-000000000012',
  channel: 'sms',
  direction: 'out',
  who: 'Daniel Cohen',
  title: 'Outbound text',
  preview: 'Texted the arrival window from my phone.',
  at: '2026-06-01T16:10:00.000Z',
  jobId: JOB_ID,
  jobLabel: JOB_NUMBER,
  manuallyLogged: true,
  loggedByName: 'Test Admin',
};

const CUSTOMER_PHONE = '5551234567';

// The composer needs create:Communication (E5) — the tab itself renders behind
// the page's read gate, so the default spec ability carries both.
const ability = buildAbility([
  { action: 'read', subject: 'Communication' },
  { action: 'create', subject: 'Communication' },
]);
const readOnlyAbility = buildAbility([{ action: 'read', subject: 'Communication' }]);
// Attribution management (the attach/move/detach menu) gates on update, not create.
const manageAbility = buildAbility([
  { action: 'read', subject: 'Communication' },
  { action: 'update', subject: 'Communication' },
]);

function renderTab(
  props: Partial<ComponentProps<typeof JobCommunicationsTab>> = {},
  renderAbility = ability
) {
  return renderWithProviders(
    <JobCommunicationsTab
      jobId={JOB_ID}
      jobNumber={JOB_NUMBER}
      customerId={CUSTOMER_ID}
      customerName="Daniel Cohen"
      customerEmail={CUSTOMER_EMAIL}
      customerPhone={CUSTOMER_PHONE}
      {...props}
    />,
    { ability: renderAbility }
  );
}

describe('JobCommunicationsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    commAccess.value = true;
    mockApi.get.mockResolvedValue({ data: { items: ITEMS_FIXTURE } });
  });

  it('renders the unified timeline with one row per channel', async () => {
    renderTab();

    expect(await screen.findByText('Inbound call · 4m 07s')).toBeInTheDocument();
    expect(screen.getByText('Estimate E00012 · Vault corridor re-key')).toBeInTheDocument();
    expect(screen.getByText('Text message')).toBeInTheDocument();
    expect(screen.getByText('WhatsApp message')).toBeInTheDocument();
    expect(mockApi.get).toHaveBeenCalledWith(`/api/jobs/${JOB_ID}/communications`);
  });

  // THE ORDER THE TIMELINE READS IN. The endpoint returns rows ASCENDING (ITEMS_FIXTURE is in
  // exactly that order, oldest at index 0), and every surface that renders the stream reads
  // newest-first — this tab used to render the raw array and so put the most recent
  // communication at the BOTTOM. Asserted as the rendered sequence of <li> rows, so removing
  // the sort fails this spec rather than merely reordering some invisible array.
  it('renders the timeline newest-first', async () => {
    const { container } = renderTab();
    await screen.findByText('Inbound call · 4m 07s');

    const expectedTitles = [
      'WhatsApp message',
      'Text message',
      'Estimate E00012 · Vault corridor re-key',
      'Inbound call · 4m 07s',
    ];
    // Each row reduced to whichever fixture title it carries, so the assertion is about the
    // SEQUENCE of rows and not about any one row's markup.
    // Queried as raw <li> rather than by the listitem ROLE: a selectable row (call/sms) carries
    // role="button", so a role query silently drops exactly the rows this spec is about.
    const titles = Array.from(container.querySelectorAll('ol > li')).map((li) =>
      expectedTitles.find((t) => li.textContent?.includes(t)),
    );
    expect(titles).toEqual([
      'WhatsApp message', // 2026-06-02T09:30
      'Text message', // 2026-06-01T15:10
      'Estimate E00012 · Vault corridor re-key', // 2026-06-01T15:00
      'Inbound call · 4m 07s', // 2026-06-01T14:32
    ]);
  });

  it('shows job pills for attributed items and "no job" for unattributed ones', async () => {
    renderTab();
    await screen.findByText('Inbound call · 4m 07s');

    // Three items carry the job label pill; the cold WhatsApp inbound shows "no job".
    expect(screen.getAllByText(JOB_NUMBER)).toHaveLength(3);
    expect(screen.getByText('no job')).toBeInTheDocument();
  });

  it('marks transactional sends with the auto · transactional chip', async () => {
    renderTab();
    await screen.findByText('Estimate E00012 · Vault corridor re-key');

    expect(screen.getByText('auto · transactional')).toBeInTheDocument();
  });

  it('sends a job-stamped text from the composer and clears it on success', async () => {
    const user = userEvent.setup();
    mockApi.post.mockResolvedValue({ data: { ok: true } });
    renderTab();
    await screen.findByText('Inbound call · 4m 07s');

    const textarea = screen.getByPlaceholderText(/text daniel cohen/i);
    await user.type(textarea, 'On our way');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith('/api/communication/sms', {
        customerId: CUSTOMER_ID,
        body: 'On our way',
        jobId: JOB_ID,
      })
    );
    await waitFor(() => expect(textarea).toHaveValue(''));
  });

  it('invalidates the customer roll-up after a job-stamped text send', async () => {
    const user = userEvent.setup();
    mockApi.post.mockResolvedValue({ data: { ok: true } });
    const { queryClient } = renderTab();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    await screen.findByText('Inbound call · 4m 07s');

    await user.type(screen.getByPlaceholderText(/text daniel cohen/i), 'On our way');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    // ['customer-communications'] is a prefix — it matches every per-customer
    // roll-up query (['customer-communications', customerId]).
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['customer-communications'] })
    );
  });

  it('composes an email from the job: posts to /api/communication/emails with job_id + subject', async () => {
    const user = userEvent.setup();
    mockApi.post.mockResolvedValue({ data: { ok: true } });
    renderTab();
    await screen.findByText('Inbound call · 4m 07s');

    // Flip the channel toggle to Email — subject + body appear.
    await user.click(screen.getByRole('button', { name: 'Email' }));
    await user.type(screen.getByPlaceholderText(/subject/i), 'COI for Thursday');
    const bodyBox = screen.getByPlaceholderText(/email daniel cohen/i);
    await user.type(bodyBox, 'Attached is the COI you asked for.');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith('/api/communication/emails', {
        to: CUSTOMER_EMAIL,
        subject: 'COI for Thursday',
        body: ['Attached is the COI you asked for.'],
        job_id: JOB_ID,
      })
    );
    await waitFor(() => expect(bodyBox).toHaveValue(''));
  });

  it('keeps SMS mode unchanged when toggling to Email and back', async () => {
    const user = userEvent.setup();
    mockApi.post.mockResolvedValue({ data: { ok: true } });
    renderTab();
    await screen.findByText('Inbound call · 4m 07s');

    await user.click(screen.getByRole('button', { name: 'Email' }));
    await user.click(screen.getByRole('button', { name: 'Text' }));

    await user.type(screen.getByPlaceholderText(/text daniel cohen/i), 'Running 10 late');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith('/api/communication/sms', {
        customerId: CUSTOMER_ID,
        body: 'Running 10 late',
        jobId: JOB_ID,
      })
    );
  });

  it('disables Email mode with a muted hint when the customer has no email', async () => {
    renderTab({ customerEmail: undefined });
    await screen.findByText('Inbound call · 4m 07s');

    expect(screen.getByRole('button', { name: 'Email' })).toBeDisabled();
    expect(screen.getByText(/no email on file/i)).toBeInTheDocument();
  });

  it('shows the empty state when the job has no communication', async () => {
    mockApi.get.mockResolvedValue({ data: { items: [] } });
    renderTab();

    expect(
      await screen.findByText(/no communication on this job yet/i)
    ).toBeInTheDocument();
  });

  // ── E5: composer + call-entry gating ─────────────────────────────────────

  it('hides the composer without org comms access — the tab is a read-only timeline', async () => {
    commAccess.value = false;
    renderTab();

    // Timeline still renders…
    expect(await screen.findByText('Inbound call · 4m 07s')).toBeInTheDocument();
    // …but no composer affordance that would 403 on send.
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/text daniel cohen/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Email' })).not.toBeInTheDocument();
  });

  it('hides the composer without create:Communication (read-only user)', async () => {
    renderTab({}, readOnlyAbility);

    expect(await screen.findByText('Inbound call · 4m 07s')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/text daniel cohen/i)).not.toBeInTheDocument();
  });

  it('"Call customer" routes into the /phone tab with full job attribution', async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByText('Inbound call · 4m 07s');

    await user.click(screen.getByRole('button', { name: /call customer/i }));

    expect(mockRequestCall).toHaveBeenCalledWith(CUSTOMER_PHONE, {
      jobId: JOB_ID,
      jobLabel: JOB_NUMBER,
      customerId: CUSTOMER_ID,
      customerName: 'Daniel Cohen',
    });
  });

  it('hides "Call customer" without org comms access', async () => {
    commAccess.value = false;
    renderTab();
    await screen.findByText('Inbound call · 4m 07s');

    expect(screen.queryByRole('button', { name: /call customer/i })).not.toBeInTheDocument();
  });

  it('hides "Call customer" without create:Communication', async () => {
    renderTab({}, readOnlyAbility);
    await screen.findByText('Inbound call · 4m 07s');

    expect(screen.queryByRole('button', { name: /call customer/i })).not.toBeInTheDocument();
  });

  it('hides "Call customer" when the customer has no phone', async () => {
    renderTab({ customerPhone: undefined });
    await screen.findByText('Inbound call · 4m 07s');

    expect(screen.queryByRole('button', { name: /call customer/i })).not.toBeInTheDocument();
    // The composer still renders — only the call entry needs a phone.
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
  });

  // ── Row → call detail drawer ─────────────────────────────────────────────

  it('opens the call detail drawer when a call row is clicked', async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByText('Inbound call · 4m 07s');

    await user.click(screen.getByText('Inbound call · 4m 07s'));

    expect(screen.getByTestId('entity-call-drawer')).toHaveAttribute(
      'data-call-id',
      'call-0000-0000-0000-000000000001',
    );
  });

  it('closes the call detail drawer', async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByText('Inbound call · 4m 07s');

    await user.click(screen.getByText('Inbound call · 4m 07s'));
    expect(screen.getByTestId('entity-call-drawer')).toBeInTheDocument();

    await user.click(screen.getByText('close-drawer'));
    expect(screen.queryByTestId('entity-call-drawer')).not.toBeInTheDocument();
  });

  it('opens the SMS conversation drawer when a text row is clicked', async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByText('Text message');

    await user.click(screen.getByText('Text message'));

    expect(screen.getByTestId('entity-sms-drawer')).toHaveAttribute('data-thread-id', THREAD_ID);
    expect(screen.queryByTestId('entity-call-drawer')).not.toBeInTheDocument();
  });

  it('closes the SMS conversation drawer', async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByText('Text message');

    await user.click(screen.getByText('Text message'));
    expect(screen.getByTestId('entity-sms-drawer')).toBeInTheDocument();

    await user.click(screen.getByText('close-sms-drawer'));
    expect(screen.queryByTestId('entity-sms-drawer')).not.toBeInTheDocument();
  });

  // C6b - a logged TEXT must not open the customer's real SMS thread either. Same class as the
  // spec below, different channel, and what proves the gate is on provenance not on channel.
  it('does not open the SMS thread for a hand-logged text, while the platform text beside it still does', async () => {
    const user = userEvent.setup();
    mockApi.get.mockResolvedValue({ data: { items: [...ITEMS_FIXTURE, LOGGED_TEXT_ITEM] } });
    renderTab();
    await screen.findByText(LOGGED_TEXT_ITEM.title);

    await user.click(screen.getByText(LOGGED_TEXT_ITEM.title));
    expect(screen.queryByTestId('entity-sms-drawer')).not.toBeInTheDocument();

    await user.click(screen.getByText('Text message'));
    expect(screen.getByTestId('entity-sms-drawer')).toHaveAttribute('data-thread-id', THREAD_ID);
  });

  // Manual Communication Log - a logged entry opens NOTHING. EntityCallDrawer resolves a
  // CallSession by id and a logged entry's id belongs to another table entirely, so the click
  // would yield a dead-end drawer reading "Couldn't load this call". The platform call is clicked
  // in the SAME spec, so this is a gate on provenance and not a tab that stopped opening drawers.
  it('does not open the call drawer for a hand-logged entry, while the platform call beside it still does', async () => {
    const user = userEvent.setup();
    mockApi.get.mockResolvedValue({ data: { items: [...ITEMS_FIXTURE, LOGGED_CALL_ITEM] } });
    renderTab();
    await screen.findByText(LOGGED_CALL_ITEM.title);

    await user.click(screen.getByText(LOGGED_CALL_ITEM.title));
    expect(screen.queryByTestId('entity-call-drawer')).not.toBeInTheDocument();

    await user.click(screen.getByText('Inbound call · 4m 07s'));
    expect(screen.getByTestId('entity-call-drawer')).toHaveAttribute(
      'data-call-id',
      'call-0000-0000-0000-000000000001',
    );
  });

  it('does NOT open a drawer for email/whatsapp rows in this slice', async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByText('WhatsApp message');

    await user.click(screen.getByText('WhatsApp message'));
    await user.click(screen.getByText('Estimate E00012 · Vault corridor re-key'));

    expect(screen.queryByTestId('entity-sms-drawer')).not.toBeInTheDocument();
    expect(screen.queryByTestId('entity-call-drawer')).not.toBeInTheDocument();
  });

  it('call rows are not clickable-to-drawer without org comms access', async () => {
    commAccess.value = false;
    const user = userEvent.setup();
    renderTab();
    await screen.findByText('Inbound call · 4m 07s');

    await user.click(screen.getByText('Inbound call · 4m 07s'));
    expect(screen.queryByTestId('entity-call-drawer')).not.toBeInTheDocument();
  });

  it('text rows are not clickable-to-drawer without org comms access', async () => {
    commAccess.value = false;
    const user = userEvent.setup();
    renderTab();
    await screen.findByText('Text message');

    await user.click(screen.getByText('Text message'));
    expect(screen.queryByTestId('entity-sms-drawer')).not.toBeInTheDocument();
  });

  // Email joined call/sms on the per-row reassign seam. All three sibling
  // roll-ups must show it - including this one, where the row's job IS the
  // hosting page's job (a "move or detach", never a self-link).
  it('gives an email row the attach/move/detach menu when gated', async () => {
    mockApi.get.mockImplementation(async (url: string) => {
      if (url === `/api/jobs/${JOB_ID}/communications`) return { data: { items: ITEMS_FIXTURE } };
      if (url === `/api/customers/${CUSTOMER_ID}`) return { data: { customer: { jobs: [] } } };
      return { data: {} };
    });
    renderTab({}, manageAbility);

    const emailRow = (
      await screen.findByText('Estimate E00012 · Vault corridor re-key')
    ).closest('li')!;
    expect(
      within(emailRow).getByTitle(`Attached to ${JOB_NUMBER} — click to move or detach`)
    ).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Manual Communication Log (slice 5) — the Log communication entry point on the JOB tab.
//
// The same placement rule the lead tab established in slice 1, and it is the whole point: the
// composer's row here renders only when the org has the phone entitlement AND the user holds
// create:Communication. The Log button inherits NEITHER, or it disappears for exactly the
// organisations this feature exists for — the ones that never had ServWave Phone.
// ─────────────────────────────────────────────────────────────────────────────

const logAbility = buildAbility([
  { action: 'read', subject: 'Communication' },
  { action: 'create', subject: 'Communication' },
  { action: 'log_past', subject: 'Communication' },
]);
/** Holds the logging ability and nothing else that renders chrome — the non-phone org's user. */
const logOnlyAbility = buildAbility([
  { action: 'read', subject: 'Communication' },
  { action: 'log_past', subject: 'Communication' },
]);

const logButton = () => screen.queryByRole('button', { name: /log communication/i });

describe('JobCommunicationsTab — Log communication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    commAccess.value = true;
    mockApi.get.mockResolvedValue({ data: { items: ITEMS_FIXTURE } });
  });

  it('renders for a user holding the ability', async () => {
    renderTab({}, logAbility);
    await screen.findByText('Inbound call · 4m 07s');

    expect(logButton()).toBeInTheDocument();
  });

  it('does not render for a user without it, who keeps the composer', async () => {
    renderTab();
    await screen.findByText('Inbound call · 4m 07s');

    expect(logButton()).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
  });

  it('renders for an organisation WITHOUT the phone entitlement, where nothing else does', async () => {
    commAccess.value = false;
    renderTab({}, logOnlyAbility);
    await screen.findByText('Inbound call · 4m 07s');

    expect(logButton()).toBeInTheDocument();
    // Both composer conditions fail here; the Log row is unaffected by either.
    expect(screen.queryByRole('button', { name: /call customer/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
  });

  it('sits beside Call customer where that exists, equally reachable', async () => {
    renderTab({}, logAbility);
    await screen.findByText('Inbound call · 4m 07s');

    const callBtn = screen.getByRole('button', { name: /call customer/i });
    expect(logButton()).toBeInTheDocument();
    expect(logButton()!.parentElement).toBe(callBtn.parentElement);
  });

  it('tells a reader with the ability that past communications can be logged, on the empty state', async () => {
    mockApi.get.mockResolvedValue({ data: { items: [] } });
    renderTab({}, logAbility);

    expect(await screen.findByText(/no communication on this job yet/i)).toBeInTheDocument();
    expect(screen.getByText(/log a past call/i)).toBeInTheDocument();
  });

  it('leaves the empty state alone for a reader who cannot log', async () => {
    mockApi.get.mockResolvedValue({ data: { items: [] } });
    renderTab();

    expect(await screen.findByText(/no communication on this job yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/log a past call/i)).not.toBeInTheDocument();
  });
});

// The signed-in user, per the shared auth-store mock in __tests__/setup.ts.
const CURRENT_USER_ID = '00000000-0000-0000-0000-000000000001';
const ROSTER = [
  { id: CURRENT_USER_ID, first_name: 'Test', last_name: 'Admin', role: 'ADMIN', is_active: true, has_login: true, department: null },
];

describe('JobCommunicationsTab — the log drawer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    commAccess.value = true;
    // The drawer's performer picker reads its OWN capability-scoped roster - NOT `/api/users`,
    // which is gated on `read User` and 403s for a SALES user holding only `log_past`. The
    // timeline reads the job.
    mockApi.get.mockImplementation((url: string) =>
      url === '/api/communication/manual-log/performers'
        ? Promise.resolve({ data: { users: ROSTER } })
        : Promise.resolve({ data: { items: ITEMS_FIXTURE } })
    );
  });

  // THE ANCHOR. The same drawer serves both tabs, so the one thing that must differ here is
  // which entity the entry names — `job_id`, never `lead_id`. Get that wrong and the entry is
  // written against nothing the user was looking at.
  it('posts the entry against THIS JOB and refreshes the job timeline', async () => {
    const user = userEvent.setup();
    mockApi.post.mockResolvedValue({ data: { entry: { id: 'new' } } });
    renderTab({}, logAbility);
    await screen.findByText('Inbound call · 4m 07s');

    await user.click(logButton()!);
    await user.click(screen.getByRole('radio', { name: 'Outbound' }));
    await user.type(screen.getByPlaceholderText('MM/DD/YYYY'), '8/26/2026');
    await user.tab();
    const time = screen.getByPlaceholderText('Time');
    await user.clear(time);
    await user.type(time, '4p');
    await user.tab();
    await user.type(
      screen.getByPlaceholderText(/what was discussed/i),
      'Rang about the install window.'
    );
    await user.click(screen.getByRole('button', { name: /^log communication$/i }));

    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith('/api/communication/manual-log', {
        job_id: JOB_ID,
        // The channel picker's default (slice 6), sent explicitly: the entry's channel is a
        // stated fact of the record, not a column default the server should fall back on.
        channel: 'call',
        direction: 'out',
        // The zoneless wall clock the user picked, unconverted — the browser's zone is never
        // consulted, the server composes against the organisation's.
        occurred_at: '2026-08-26T16:00',
        notes: 'Rang about the install window.',
        performed_by: CURRENT_USER_ID,
      })
    );
    // Exactly one anchor reaches the wire.
    expect(mockApi.post.mock.calls[0][1]).not.toHaveProperty('lead_id');

    // The timeline reloads, so the new entry appears without a manual refresh.
    await waitFor(() =>
      expect(
        mockApi.get.mock.calls.filter((c) => c[0] === `/api/jobs/${JOB_ID}/communications`).length
      ).toBeGreaterThan(1)
    );
  });

  it('invalidates the customer roll-up too, where the entry also now appears', async () => {
    const user = userEvent.setup();
    mockApi.post.mockResolvedValue({ data: { entry: { id: 'new' } } });
    const { queryClient } = renderTab({}, logAbility);
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    await screen.findByText('Inbound call · 4m 07s');

    await user.click(logButton()!);
    await user.click(screen.getByRole('radio', { name: 'Outbound' }));
    await user.type(screen.getByPlaceholderText('MM/DD/YYYY'), '8/26/2026');
    await user.tab();
    await user.type(screen.getByPlaceholderText(/what was discussed/i), 'Rang about the window.');
    await user.click(screen.getByRole('button', { name: /^log communication$/i }));

    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['job-communications', JOB_ID] })
    );
    // A prefix match — every per-customer roll-up is stale, and the entry reaches the customer
    // through this job.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['customer-communications'] });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CORRECTING A LOGGED ENTRY FROM THE JOB TAB (slice 8).
//
// The job tab wires the same affordance as the lead tab, in its own copy of the onSelect branch —
// which is exactly why it is asserted here too rather than assumed from the lead suite. The
// detailed behaviour of the drawer itself (seeding, the org wall clock, the whole-record save,
// the move picker, the delete) lives in lead-communications-tab.test.tsx; this pins the WIRING:
// the click reaches the editor, and it never reaches the platform call drawer.
// ─────────────────────────────────────────────────────────────────────────────

const JOB_STORED_ENTRY = {
  id: LOGGED_CALL_ITEM.id,
  channel: 'call',
  direction: 'out',
  occurredAt: '2026-06-01T16:00:00.000Z',
  occurredAtLocal: '2026-06-01T12:00',
  notes: 'Rang from my mobile to confirm the install window, and he asked about the second door.',
  durationMinutes: null,
  outcome: null,
  subject: null,
  leadId: null,
  jobId: JOB_ID,
  performedBy: CURRENT_USER_ID,
  loggedBy: CURRENT_USER_ID,
  manuallyLogged: true,
};

/** A viewer who is neither an admin nor the logger — the third party in the row-level rule. */
const OTHER_USER_ID = '00000000-0000-0000-0000-000000000003';
function viewAsColleague() {
  vi.mocked(useAuthStore).mockImplementation((selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      user: {
        id: OTHER_USER_ID,
        email: 'sales@test.com',
        first_name: 'Test',
        last_name: 'Sales',
        role: 'SALES',
      },
      isAuthenticated: true,
      isLoading: false,
      error: null,
    }),
  );
}

describe('JobCommunicationsTab — correcting a logged entry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    commAccess.value = true;
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/api/communication/manual-log/performers') return Promise.resolve({ data: { users: ROSTER } });
      if (url === `/api/communication/manual-log/${LOGGED_CALL_ITEM.id}`) {
        return Promise.resolve({ data: { entry: JOB_STORED_ENTRY } });
      }
      if (url === `/api/customers/${CUSTOMER_ID}`) {
        return Promise.resolve({ data: { customer: { jobs: [] } } });
      }
      if (url === '/api/leads') return Promise.resolve({ data: { leads: [] } });
      return Promise.resolve({ data: { items: [...ITEMS_FIXTURE, LOGGED_CALL_ITEM] } });
    });
  });

  it('opens the editor on the entry, and never the platform call drawer', async () => {
    const user = userEvent.setup();
    renderTab({}, logAbility);
    await screen.findByText(LOGGED_CALL_ITEM.title);

    await user.click(screen.getByText(LOGGED_CALL_ITEM.title));

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /edit logged communication/i })).toBeInTheDocument(),
    );
    expect(screen.getByPlaceholderText(/what was discussed/i)).toHaveValue(JOB_STORED_ENTRY.notes);
    expect(screen.queryByTestId('entity-call-drawer')).not.toBeInTheDocument();
  });

  it('saves the correction against this job', async () => {
    const user = userEvent.setup();
    mockApi.put.mockResolvedValue({ data: { entry: JOB_STORED_ENTRY } });
    renderTab({}, logAbility);
    await screen.findByText(LOGGED_CALL_ITEM.title);
    await user.click(screen.getByText(LOGGED_CALL_ITEM.title));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /edit logged communication/i })).toBeInTheDocument(),
    );

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(mockApi.put).toHaveBeenCalled());
    const [url, body] = mockApi.put.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe(`/api/communication/manual-log/${LOGGED_CALL_ITEM.id}`);
    expect(body).toMatchObject({ job_id: JOB_ID, channel: 'call', direction: 'out' });
    expect(body).not.toHaveProperty('lead_id');
  });

  it('does not offer the editor to a user without the ability', async () => {
    const user = userEvent.setup();
    renderTab({}, ability); // read + create, no log_past
    await screen.findByText(LOGGED_CALL_ITEM.title);

    await user.click(screen.getByText(LOGGED_CALL_ITEM.title));

    expect(
      screen.queryByRole('heading', { name: /edit logged communication/i }),
    ).not.toBeInTheDocument();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // THE ROW HALF of the same gate, which the ability specs above do not reach: holding
  // `log_past` is not enough — the entry has to be YOURS, or you have to be the organisation's
  // admin. This tab carries its OWN copy of that branch, so the lead tab's coverage says nothing
  // about it; every job-tab fixture until now was the admin looking at their own entry, under
  // which dropping the check entirely changes no outcome.
  // ───────────────────────────────────────────────────────────────────────────
  it('does NOT offer it to another user holding the ability who did not log it', async () => {
    const user = userEvent.setup();
    viewAsColleague();
    renderTab({}, logAbility);
    await screen.findByText(LOGGED_CALL_ITEM.title);

    await user.click(screen.getByText(LOGGED_CALL_ITEM.title));

    expect(
      screen.queryByRole('heading', { name: /edit logged communication/i }),
    ).not.toBeInTheDocument();
    // …and it did not fall through to the platform drawer either, which is the slice 6 gate.
    expect(screen.queryByTestId('entity-call-drawer')).not.toBeInTheDocument();
  });

  it('DOES offer it to that same user for an entry they logged themselves', async () => {
    const user = userEvent.setup();
    viewAsColleague();
    const theirs = { ...LOGGED_CALL_ITEM, loggedById: OTHER_USER_ID };
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/api/communication/manual-log/performers') return Promise.resolve({ data: { users: ROSTER } });
      if (url === `/api/communication/manual-log/${LOGGED_CALL_ITEM.id}`) {
        return Promise.resolve({ data: { entry: { ...JOB_STORED_ENTRY, loggedBy: OTHER_USER_ID } } });
      }
      if (url === `/api/customers/${CUSTOMER_ID}`) {
        return Promise.resolve({ data: { customer: { jobs: [] } } });
      }
      if (url === '/api/leads') return Promise.resolve({ data: { leads: [] } });
      return Promise.resolve({ data: { items: [...ITEMS_FIXTURE, theirs] } });
    });
    renderTab({}, logAbility);
    await screen.findByText(theirs.title);

    await user.click(screen.getByText(theirs.title));

    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: /edit logged communication/i }),
      ).toBeInTheDocument(),
    );
  });

  // FAIL CLOSED. A payload that does not say who logged an entry cannot establish that this
  // viewer did, and an admin is not offered one either: offering an action on a record the
  // client cannot describe is how a 403 gets rendered as a button.
  it('does not offer it when the row does not say who logged it', async () => {
    const user = userEvent.setup();
    const { loggedById: _dropped, ...anonymous } = LOGGED_CALL_ITEM;
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/api/communication/manual-log/performers') return Promise.resolve({ data: { users: ROSTER } });
      if (url === `/api/communication/manual-log/${LOGGED_CALL_ITEM.id}`) {
        return Promise.resolve({ data: { entry: JOB_STORED_ENTRY } });
      }
      if (url === `/api/customers/${CUSTOMER_ID}`) {
        return Promise.resolve({ data: { customer: { jobs: [] } } });
      }
      if (url === '/api/leads') return Promise.resolve({ data: { leads: [] } });
      return Promise.resolve({ data: { items: [...ITEMS_FIXTURE, anonymous as CommItem] } });
    });
    renderTab({}, logAbility);
    await screen.findByText(anonymous.title);

    await user.click(screen.getByText(anonymous.title));

    expect(
      screen.queryByRole('heading', { name: /edit logged communication/i }),
    ).not.toBeInTheDocument();
  });
});
