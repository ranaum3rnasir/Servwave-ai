/**
 * Spider (#2619; the contractor's click, Ran 15 Oct D4) - a lead opened from a Spider alert card
 * opens the tab the card named; at New, its text box starts with his draft. Editable, capped at 500
 * characters, never sent without Send, and offered only from a Spider alert at a company that
 * passes the Spider gate.
 *
 * SPEC-6 (D1, Ran 20 Oct): nothing on the lead page marks a Spider alert read. The server ends it once
 * a real contact moves the lead on, so a text that was recorded but never went out clears nothing,
 * and the text box says so.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { useAuthStore } from '@/stores/auth.store';
import { LEAD_FIXTURE, NOTES_FIXTURE, renderWithProviders } from './helpers';
import { renderLeadDetail, serveLeadDetail, stubBrowser } from '@/__tests__/harness/leadDetailPage';
import { SPIDER_FOLLOW_UP_MAX_CHARS, spiderDraftFrom, spiderLeadLink } from '@/lib/spider/followUp';
import { useSpiderUnreadAlerts } from '@/lib/api/spider';

vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => true,
}));
vi.mock('@/lib/communication/phoneTabHandoff', () => ({ requestCall: vi.fn() }));
vi.mock('@/components/communication/shared/EntityCallDrawer', () => ({ EntityCallDrawer: () => null }));
vi.mock('@/components/communication/shared/EntitySmsDrawer', () => ({ EntitySmsDrawer: () => null }));
vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));
vi.mock('react-router-dom', async () => ({
  ...(await vi.importActual<typeof import('react-router-dom')>('react-router-dom')),
  useParams: () => ({ id: 'e0000000-0000-0000-0000-000000000001' }),
}));

stubBrowser();

const mockApi = vi.mocked(api);
const admin = buildAbility([{ action: 'manage', subject: 'all' }]);
const SPIDER_USER = { id: 'u1', role: 'SALES', organization_id: 'o1', org_is_demo: true, org_features: ['leads', 'phone', 'spider'] };
const LEAD_ID = 'e0000000-0000-0000-0000-000000000001';
const DRAFT = 'Hello Jane Doe, following up regarding your Door repair (Stage: New).';

/** The 201 of POST /api/communication/sms, for a text the server settled as `delivery`. */
function smsSent(delivery: 'sent' | 'skipped' | 'failed', statusReason?: string) {
  return {
    data: {
      message: { id: 'm1', direction: 'out', status: delivery, ...(statusReason ? { statusReason } : {}) },
      delivery,
    },
  };
}
const NOT_CONNECTED_LINE = 'Recorded but not sent - the phone system is not connected yet';
const PROVIDER_REJECTED_LINE = 'Not delivered - the provider rejected it';

function signIn(user: Record<string, unknown>) {
  vi.mocked(useAuthStore).mockImplementation(((selector: (s: Record<string, unknown>) => unknown) =>
    selector({ user, isAuthenticated: true })) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  signIn(SPIDER_USER);
  serveLeadDetail({
    lead: LEAD_FIXTURE,
    notes: NOTES_FIXTURE,
    routes: [{ match: (url) => url.includes('/communications'), data: { items: [] } }],
  });
  mockApi.post.mockResolvedValue({ data: { ok: true } });
  mockApi.patch.mockResolvedValue({ data: { ok: true } });
});

describe('the link and the draft', () => {
  it("names the lead and the tab, and nothing about the customer", () => {
    expect(spiderLeadLink('lead-1', 'communication')).toBe('/leads/lead-1?tab=communication');
  });

  it('reads the draft from the router state, cut to 500 characters', () => {
    expect(spiderDraftFrom({ spiderDraft: DRAFT })).toBe(DRAFT);
    expect(spiderDraftFrom({ spiderDraft: 'x'.repeat(900) })).toHaveLength(SPIDER_FOLLOW_UP_MAX_CHARS);
    expect(spiderDraftFrom(null)).toBeUndefined();
    expect(spiderDraftFrom({ spiderDraft: 7 })).toBeUndefined();
  });
});

describe("the lead's text box", () => {
  async function renderTab(initialMessage?: string, onSent?: () => void) {
    const { LeadCommunicationsTab } = await import('@/components/communication/LeadCommunicationsTab');
    return renderWithProviders(
      <LeadCommunicationsTab
        leadId="lead-1" leadLabel="L00001" customerId="cust-1" customerName="Jane Doe"
        initialMessage={initialMessage} onSent={onSent}
      />,
      { ability: admin },
    );
  }

  it('starts with the draft, which can be edited, and sends nothing until Send', async () => {
    const user = userEvent.setup();
    const onSent = vi.fn();
    mockApi.post.mockResolvedValue(smsSent('sent'));
    await renderTab('Hello Jane, checking in.', onSent);
    const box = await screen.findByRole('textbox');
    expect(box).toHaveValue('Hello Jane, checking in.');
    await user.type(box, ' Thanks!');
    expect(box).toHaveValue('Hello Jane, checking in. Thanks!');
    expect(mockApi.post).not.toHaveBeenCalled();
    expect(onSent).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith(
        '/api/communication/sms',
        expect.objectContaining({ body: 'Hello Jane, checking in. Thanks!' }),
      ),
    );
    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));
  });

  it('a text recorded but not sent calls nothing, empties the box and says why', async () => {
    const user = userEvent.setup();
    const onSent = vi.fn();
    mockApi.post.mockResolvedValue(smsSent('skipped', 'NOT_CONNECTED'));
    await renderTab('Hello Jane, checking in.', onSent);
    await user.click(await screen.findByRole('button', { name: 'Send' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(NOT_CONNECTED_LINE));
    expect(screen.getByRole('textbox')).toHaveValue('');
    expect(onSent).not.toHaveBeenCalled();
  });

  it('a text the provider rejected calls nothing and says so', async () => {
    const user = userEvent.setup();
    const onSent = vi.fn();
    mockApi.post.mockResolvedValue(smsSent('failed', 'PROVIDER_ERROR'));
    await renderTab('Hello Jane, checking in.', onSent);
    await user.click(await screen.findByRole('button', { name: 'Send' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(PROVIDER_REJECTED_LINE));
    expect(onSent).not.toHaveBeenCalled();
  });

  it('the not-sent line goes once you start typing again', async () => {
    const user = userEvent.setup();
    mockApi.post.mockResolvedValue(smsSent('skipped', 'NOT_CONNECTED'));
    await renderTab('Hello Jane, checking in.', vi.fn());
    await user.click(await screen.findByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(NOT_CONNECTED_LINE));

    await user.type(screen.getByRole('textbox'), 'T');
    expect(screen.queryByText(NOT_CONNECTED_LINE)).toBeNull();
  });

  // Screen readers often skip a live region that is mounted already filled, so the region is
  // mounted empty from the start and only its text changes (SPEC-6 6.3).
  it('the not-sent line is announced: an empty status region is there before the send, and the same one fills', async () => {
    const user = userEvent.setup();
    mockApi.post.mockResolvedValue(smsSent('skipped', 'NOT_CONNECTED'));
    await renderTab('Hello Jane, checking in.', vi.fn());
    const region = await screen.findByRole('status');
    expect(region).toBeEmptyDOMElement();

    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(region).toHaveTextContent(NOT_CONNECTED_LINE));
    expect(screen.getByRole('status')).toBe(region);

    await user.type(screen.getByRole('textbox'), 'T');
    expect(region).toBeInTheDocument();
    expect(region).toBeEmptyDOMElement();
  });

  it('a text blocked before it is recorded shows the error and keeps the words, as today', async () => {
    const user = userEvent.setup();
    const onSent = vi.fn();
    mockApi.post.mockRejectedValue({
      response: { status: 409, data: { error: 'This number has opted out of texts', code: 'RECIPIENT_OPTED_OUT' } },
    });
    await renderTab('Hello Jane, checking in.', onSent);
    await user.click(await screen.findByRole('button', { name: 'Send' }));

    expect(await screen.findByText('This number has opted out of texts')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('Hello Jane, checking in.');
    expect(onSent).not.toHaveBeenCalled();
  });

  it('cuts an initial message longer than 500 characters', async () => {
    await renderTab('y'.repeat(800));
    expect(((await screen.findByRole('textbox')) as HTMLTextAreaElement).value).toHaveLength(500);
  });

  it('starts empty without one, as today', async () => {
    await renderTab();
    expect(await screen.findByRole('textbox')).toHaveValue('');
  });
});

describe('the lead page', () => {
  /** Stands in for a Spider card clicked while the lead page is already open. */
  function CardLink({ to, state }: { to: string; state?: unknown }) {
    const navigate = useNavigate();
    return <button type="button" onClick={() => navigate(to, { state })}>card</button>;
  }

  /** Stands in for the Spider button in the app shell: it keeps the unread list mounted. */
  function SpiderButtonProbe() {
    useSpiderUnreadAlerts();
    return null;
  }

  /** What a reload would start from: the address and the router state. */
  function LocationProbe() {
    const loc = useLocation();
    return <div data-testid="location">{JSON.stringify(loc.state)}</div>;
  }

  const UNREAD_URL = '/api/ai-farm/spider/alerts/unread';
  const unreadFetches = () => mockApi.get.mock.calls.filter(([url]) => url === UNREAD_URL).length;
  const markReadCalls = () => mockApi.patch.mock.calls.filter(([url]) => String(url).startsWith('/api/notifications/'));

  function openLead(search = '', state?: unknown, card?: { to: string; state?: unknown }) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    renderLeadDetail({
      entry: { pathname: `/leads/${LEAD_ID}`, search, state },
      wrap: (page) => <QueryClientProvider client={qc}>{page}</QueryClientProvider>,
      beside: (
        <>
          <SpiderButtonProbe />
          <LocationProbe />
          {card && <CardLink {...card} />}
        </>
      ),
    });
  }

  // The 10 s waits below are deliberately longer than the 5 s default: the Communication tab is a lazy
  // chunk whose first transform is slow on a loaded machine, and the textbox only exists after it.
  it('opens Communication with his draft when a Spider card at New opened it', async () => {
    await openLead('?tab=communication', { spiderAlertId: 'nr-1', spiderDraft: DRAFT });
    expect(await screen.findByRole('tab', { name: /Communication/, selected: true })).toBeInTheDocument();
    expect(await screen.findByRole('textbox', {}, { timeout: 10_000 })).toHaveValue(DRAFT);
    expect(mockApi.post).not.toHaveBeenCalled();
    expect(mockApi.patch).not.toHaveBeenCalled();
  });

  it('a text that went out from a Spider card marks nothing read; the Spider list is fetched again', async () => {
    const user = userEvent.setup();
    mockApi.post.mockResolvedValue(smsSent('sent'));
    await openLead('?tab=communication', { spiderAlertId: 'nr-1', spiderDraft: DRAFT });
    await screen.findByRole('textbox', {}, { timeout: 10_000 });
    await waitFor(() => expect(unreadFetches()).toBe(1));

    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(unreadFetches()).toBe(2));
    // The draft is used up: the router state is reset, and the remounted box starts empty.
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('null'));
    expect(await screen.findByRole('textbox')).toHaveValue('');
    expect(markReadCalls()).toEqual([]);
  });

  it('a text recorded but not sent from a Spider card marks nothing read and keeps the draft for a reload', async () => {
    const user = userEvent.setup();
    mockApi.post.mockResolvedValue(smsSent('skipped', 'NOT_CONNECTED'));
    await openLead('?tab=communication', { spiderAlertId: 'nr-1', spiderDraft: DRAFT });
    await screen.findByRole('textbox', {}, { timeout: 10_000 });

    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(NOT_CONNECTED_LINE));
    expect(JSON.parse(screen.getByTestId('location').textContent ?? 'null')).toEqual({ spiderAlertId: 'nr-1', spiderDraft: DRAFT });
    expect(markReadCalls()).toEqual([]);
  });

  it('a text the provider rejected from a Spider card marks nothing read', async () => {
    const user = userEvent.setup();
    mockApi.post.mockResolvedValue(smsSent('failed', 'PROVIDER_ERROR'));
    await openLead('?tab=communication', { spiderAlertId: 'nr-1', spiderDraft: DRAFT });
    await screen.findByRole('textbox', {}, { timeout: 10_000 });

    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(PROVIDER_REJECTED_LINE));
    expect(markReadCalls()).toEqual([]);
  });

  it('a text that went out from a Contacted card marks nothing read (a text never ends Contacted)', async () => {
    const user = userEvent.setup();
    mockApi.post.mockResolvedValue(smsSent('sent'));
    await openLead('?tab=communication', { spiderAlertId: 'nr-2' });
    const box = await screen.findByRole('textbox', {}, { timeout: 10_000 });
    await user.type(box, 'Checking in about the walkthrough.');

    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/api/communication/sms', expect.anything()));
    await waitFor(() => expect(box).toHaveValue(''));
    expect(markReadCalls()).toEqual([]);
  });

  it.each([
    ['?tab=walkthrough', /Walkthrough/],
    ['?tab=overview', /Overview/],
  ])('%s opens that tab', async (search, name) => {
    await openLead(search, { spiderAlertId: 'nr-2' });
    expect(await screen.findByRole('tab', { name, selected: true })).toBeInTheDocument();
  });

  it('a card clicked while the lead page is open switches to its tab', async () => {
    const user = userEvent.setup();
    await openLead('', undefined, { to: `/leads/${LEAD_ID}?tab=walkthrough`, state: { spiderAlertId: 'nr-2' } });
    expect(await screen.findByRole('tab', { name: /Overview/, selected: true })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'card' }));
    expect(await screen.findByRole('tab', { name: /Walkthrough/, selected: true })).toBeInTheDocument();
  });

  it('?tab=communication by someone who cannot read communications lands on Overview', async () => {
    const noComms = buildAbility([
      { action: 'manage', subject: 'all' },
      { action: 'read', subject: 'Communication', inverted: true },
    ]);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    renderLeadDetail({
      ability: noComms,
      entry: { pathname: `/leads/${LEAD_ID}`, search: '?tab=communication', state: { spiderAlertId: 'nr-1', spiderDraft: DRAFT } },
      wrap: (page) => <QueryClientProvider client={qc}>{page}</QueryClientProvider>,
    });
    expect(await screen.findByRole('tab', { name: /Overview/, selected: true })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /Communication/ })).toBeNull();
    expect(screen.queryByRole('textbox', { name: /message/i })).toBeNull();
  });

  it('an unknown ?tab= lands on Overview', async () => {
    await openLead('?tab=nonsense');
    expect(await screen.findByRole('tab', { name: /Overview/, selected: true })).toBeInTheDocument();
  });

  it('pre-fills nothing when the lead was opened any other way', async () => {
    await openLead('?tab=communication');
    expect(await screen.findByRole('textbox', {}, { timeout: 10_000 })).toHaveValue('');
  });

  it('pre-fills nothing at a company without Spider, even from an alert link', async () => {
    signIn({ ...SPIDER_USER, org_is_demo: false });
    await openLead('?tab=communication', { spiderAlertId: 'nr-1', spiderDraft: DRAFT });
    expect(await screen.findByRole('textbox', {}, { timeout: 10_000 })).toHaveValue('');
  });

  // SPEC-5: a real (non-demo) company on the server's Spider pilot list takes the draft too.
  it('starts the text box with the draft at a pilot company', async () => {
    signIn({ ...SPIDER_USER, org_is_demo: false, org_is_spider_pilot: true });
    await openLead('?tab=communication', { spiderAlertId: 'nr-1', spiderDraft: DRAFT });
    expect(await screen.findByRole('textbox', {}, { timeout: 10_000 })).toHaveValue(DRAFT);
  });
});
