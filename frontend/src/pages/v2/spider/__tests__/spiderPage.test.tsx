/**
 * Spider (#2619) - the Spider page as the contractor built it (Ran, 15 Oct: S1 of "bring Umer's
 * sandbox build over exactly"): his header, Configuration | History tabs, the Configuration & Alert
 * Rules card and his save review, with the Not active / Active status and Activate / Deactivate in
 * the header (#3432; the activation itself is in spiderActivation.test.tsx). Also its route guard
 * and the AI Center's Spider pop-up. The API is faked at axios.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes, useNavigate } from 'react-router-dom';
import api from '@/lib/axios';
import { toast } from '@/ui-kit/components/ui/sonner';
import { renderWithProviders } from '@/__tests__/helpers';
import { useAuthStore } from '@/stores/auth.store';
import { useAiCenterStore } from '@/stores/aiCenterStore';
import { AiCenterModal } from '@/components/ai-center/AiCenterModal';
import RequireSpider from '@/components/RequireSpider';
import SpiderPage from '../SpiderPage';

vi.mock('@/ui-kit/components/ui/sonner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/ui-kit/components/ui/sonner')>();
  return {
    ...actual,
    toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), dismiss: vi.fn() }),
  };
});

const mockApi = vi.mocked(api);
const SETTINGS = '/api/ai-farm/spider/settings';
const HISTORY = '/api/ai-farm/spider/history';
const STATUS = '/api/ai-farm/spider/status';

function signIn(user: Record<string, unknown>) {
  vi.mocked(useAuthStore).mockImplementation(((selector: (s: Record<string, unknown>) => unknown) =>
    selector({ user, isAuthenticated: true })) as never);
}
const ADMIN = { id: 'u1', role: 'ADMIN', is_admin: true, organization_id: 'o1', org_is_demo: true, org_features: ['leads', 'spider'] };

const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const LIMIT_OFF = { enabled: false, value: 1, unit: 'MINUTE' };
const SETTINGS_BODY = {
  settings: {
    is_active: true,
    activated_at: ago(30 * DAY),
    status_limits: {
      NEW: { enabled: true, value: 2, unit: 'HOUR' },
      CONTACTED: LIMIT_OFF,
      WALKTHROUGH_COMPLETED: LIMIT_OFF,
    },
    channels: { in_app: true, red_frame: true, email: false, text: false },
    recipients: { roles: ['ADMIN', 'SALES'], user_ids: [], lead_owner: true },
    updated_at: null,
  },
  options: {
    statuses: [
      { value: 'NEW', label: 'New' },
      { value: 'CONTACTED', label: 'Contacted' },
      { value: 'WALKTHROUGH_COMPLETED', label: 'Walkthrough Completed' },
    ],
    units: [
      { value: 'MINUTE', label: 'Minutes' },
      { value: 'HOUR', label: 'Hours' },
      { value: 'DAY', label: 'Days' },
    ],
    roles: [
      { value: 'ADMIN', label: 'Admin' },
      { value: 'SALES', label: 'Sales' },
      { value: 'DISPATCHER', label: 'Dispatcher' },
      { value: 'TECHNICIAN', label: 'Technician' },
    ],
  },
};

/** A company that never saved: the contractor's defaults, as the server reads them (D3). */
const DEFAULT_SETTINGS_BODY = {
  ...SETTINGS_BODY,
  settings: {
    ...SETTINGS_BODY.settings,
    status_limits: { NEW: LIMIT_OFF, CONTACTED: LIMIT_OFF, WALKTHROUGH_COMPLETED: LIMIT_OFF },
    channels: { in_app: true, red_frame: true, email: true, text: true },
    recipients: { roles: ['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN'], user_ids: [], lead_owner: true },
  },
};

/** Nothing chosen anywhere: every one of his three required checks fails. */
const EMPTY_SETTINGS_BODY = {
  ...SETTINGS_BODY,
  settings: {
    ...DEFAULT_SETTINGS_BODY.settings,
    channels: { in_app: false, red_frame: false, email: false, text: false },
    recipients: { roles: [], user_ids: [], lead_owner: false },
  },
};

/** The picker's server (#3436): two open leads watched, none excluded, one customer with both. */
const OVERVIEW = '/api/ai-farm/spider/overview';
const PICKER_CUSTOMERS = '/api/ai-farm/spider/customers';
let overviewBody = { watched: 2, excluded: 0 };
const PAT_ROW = { id: 'cust-pat', name: 'Pat Payer', company_name: 'Payer Homes', email: 'pat@example.test', open_leads: 2, excluded_leads: 0 };
const USERS = [
  { id: 'u1', first_name: 'Ada', last_name: 'Admin', email: 'ada@example.test', role: 'ADMIN', is_admin: true },
  { id: 'u2', first_name: 'Rita', last_name: 'Rep', email: 'rita@example.test', role: 'SALES' },
];

const HISTORY_ROW = {
  id: 'a1',
  lead_id: 'lead-1',
  lead_number: 'L00042',
  customer_id: 'cust-pat',
  customer_name: 'Pat Payer',
  company_name: 'Payer Homes',
  service_request: 'Fix the door',
  service_location: '1 Test Way, Testville, MA, 02108',
  status: 'NEW',
  stage_name: 'New',
  elapsed: { value: 3, unit: 'HOUR' },
  alerted_at: '2026-10-01T12:00:00.000Z',
  outcome: 'FAILED',
  outcomes: {
    email: { enabled: true, status: 'SENT', sent: 2, skipped: 0, failed: 0, error: null, skip_reason: null, from: 'ServWave Spider Alerts <alerts@spider.servwave.com>' },
    sms: { enabled: true, status: 'FAILED', sent: 0, skipped: 0, failed: 2, error: 'Text message delivery failed', skip_reason: null },
    in_app: { enabled: true, status: 'SENT' },
  },
  recipients: [
    { id: 'u2', name: 'Rita Rep', email: 'rita@example.test', role: 'SALES', type: 'owner' },
    { id: 'u1', name: 'Ada Admin', email: 'ada@example.test', role: 'ADMIN', type: 'admin' },
  ],
  email_subject: 'Spider Alert - Pat Payer (L00042)',
  email_body: 'Spider Alert - Pat Payer (L00042)\nThis lead was created 3 hours ago and has not yet been contacted.\n\nView lead: https://app.test/leads/lead-1',
  sms_message: 'Spider Alert - Pat Payer (L00042)\nThis lead was created 3 hours ago and has not yet been contacted.',
  in_app_message: 'This lead was created 3 hours ago and has not yet been contacted.',
};

/** An alert from before the History copy: no message text was stored, and one outcome is unknown. */
const OLD_HISTORY_ROW = {
  ...HISTORY_ROW,
  id: 'a-old',
  lead_number: 'L00007',
  outcomes: { email: null, sms: { ...HISTORY_ROW.outcomes.sms, enabled: false, status: 'SKIPPED', failed: 0, error: null }, in_app: null },
  outcome: null,
  recipients: [{ id: 'u1', name: 'Ada Admin', email: 'ada@example.test', role: 'ADMIN', type: null }],
  email_subject: null,
  email_body: null,
  sms_message: null,
  in_app_message: null,
};

/** One row as a server from before S3 sends it: none of the contractor's fields. */
const PRE_S3_ROW = {
  id: 'a-pre',
  lead_id: 'lead-9',
  lead_number: 'L00009',
  customer_name: 'Pat Payer',
  status: 'NEW',
  status_label: 'New',
  entered_status_at: '2026-10-01T09:00:00.000Z',
  alerted_at: '2026-10-01T12:00:00.000Z',
  limit: { value: 2, unit: 'HOUR' },
  channels: { in_app: 'Shown in the app', email: 'Email alerts are switched off', text: 'Text message could not be delivered' },
  recipients: [{ name: 'Rita Rep', email_outcome: null, text_outcome: 'Text message could not be delivered' }],
};

const HISTORY_SEARCH = `${HISTORY}/search`;
const HISTORY_SUMMARY = `${HISTORY}/summary`;
const HISTORY_FILTERS = `${HISTORY}/filters`;
const HISTORY_EXPORT = `${HISTORY}/export`;
let summaryBody = { total: 26, new_since: 4 };
let filterCustomers = [{ value: 'cust-pat', label: 'Pat Payer' }];

const spiderCalls = () => mockApi.get.mock.calls.filter(([url]) => String(url).includes('/spider/')).length;
const readsOf = (url: string) =>
  mockApi.get.mock.calls.filter(([u]) => u === url).length +
  (url === HISTORY ? mockApi.post.mock.calls.filter(([u]) => u === HISTORY_SEARCH).length : 0);

/** The switch the server holds: GET /spider/status reads it, PUT /spider/status moves it. */
let spiderSwitch: { isActive: boolean; isSetUp: boolean } = { isActive: true, isSetUp: true };
let settingsBody: typeof SETTINGS_BODY = SETTINGS_BODY;
const SWITCH = { name: 'Switch Spider on or off' };
const HEADING = 'Configuration & Alert Rules';
/** The header's status badge, once it reads `words`. */
const statusBadge = (words: 'Active' | 'Not active') =>
  screen.findByText(words, { selector: '[data-spider-status-actions] [data-agent-chip]' });

beforeEach(() => {
  spiderSwitch = { isActive: true, isSetUp: true };
  settingsBody = SETTINGS_BODY;
  summaryBody = { total: 26, new_since: 4 };
  overviewBody = { watched: 2, excluded: 0 };
  filterCustomers = [{ value: 'cust-pat', label: 'Pat Payer' }];
  localStorage.clear();
  vi.clearAllMocks();
  signIn(ADMIN);
  mockApi.get.mockImplementation(async (url: string, config?: { params?: unknown }) => {
    if (url === SETTINGS) return { data: settingsBody };
    if (url === HISTORY) {
      const page = (config?.params as { page?: number } | undefined)?.page ?? 1;
      return {
        data: {
          items: page === 1 ? [HISTORY_ROW] : [{ ...HISTORY_ROW, id: 'a2', lead_number: 'L00043' }],
          page,
          page_size: 25,
          total: 26,
          total_pages: 2,
        },
      };
    }
    if (url === HISTORY_SUMMARY) return { data: summaryBody };
    if (url === HISTORY_FILTERS) {
      return { data: { recipients: [{ value: 'u1', label: 'Ada Admin' }, { value: 'u2', label: 'Rita Rep' }], customers: filterCustomers } };
    }
    if (url === STATUS) return { data: spiderSwitch };
    if (url === OVERVIEW) return { data: overviewBody };
    if (url === PICKER_CUSTOMERS) return { data: { customers: [PAT_ROW], next_cursor: null } };
    if (url === '/api/users') return { data: { users: USERS } };
    return { data: {} };
  });
  // The History page and its export are POSTed (the toolbar in the body). The page answers as GET
  // /history does in this file, so a test that changes that answer changes both.
  mockApi.post.mockImplementation(async (url: string, body?: unknown) => {
    if (url === HISTORY_SEARCH) return mockApi.get.getMockImplementation()!(HISTORY, { params: body } as never);
    if (url === HISTORY_EXPORT) {
      return { data: { items: [HISTORY_ROW, { ...HISTORY_ROW, id: 'a2', lead_number: 'L00043' }], total: 2, truncated: false } };
    }
    return { data: {} };
  });
  mockApi.put.mockImplementation(async (url: string, body?: unknown) => {
    if (url === STATUS) {
      spiderSwitch = { ...spiderSwitch, isActive: (body as { isActive: boolean }).isActive };
      return { data: spiderSwitch };
    }
    return { data: settingsBody };
  });
});

// ─── Helpers for his controls ────────────────────────────────────────────────

/** One of his Notifications rows (a whole-row click target with an unlabelled checkbox). */
const channelBox = (label: string) =>
  within(screen.getByText(label).closest('.cursor-pointer') as HTMLElement).getByRole('checkbox');
const stageSwitch = (label: string) => screen.getByRole('switch', { name: `Enable ${label}` });
const stageInput = (label: string) => screen.getByLabelText(`Time period for ${label}`) as HTMLInputElement;
const NEW_ROW = 'New → Contacted';
const CONTACTED_ROW = 'Contacted → Walkthrough Scheduled';
const COMPLETED_ROW = 'Walkthrough Completed → Estimate';

/** The Configuration tab, once the settings have been read into the form. */
async function openConfig() {
  await screen.findByText('Stage Thresholds');
  return screen.getByText(HEADING);
}

async function saveAndConfirm() {
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  const dialog = await screen.findByRole('dialog', { name: 'Confirm Spider Agent Configuration' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  return dialog;
}

const settingsPuts = () => mockApi.put.mock.calls.filter(([url]) => url === SETTINGS);

// ─── The Configuration tab ───────────────────────────────────────────────────

describe('Spider Configuration', () => {
  it("loads the settings from the server into his cards and his three stage rows", async () => {
    renderWithProviders(<SpiderPage />);
    await openConfig();
    expect(screen.getByText('Configure communication channels, assignees, stage thresholds, and monitored pipeline targets.')).toBeInTheDocument();
    for (const t of ['Notifications', 'Assignment', 'Stage Thresholds', 'Select Contacts for Alert']) {
      expect(screen.getByText(t)).toBeInTheDocument();
    }
    // His three rows, D2: no Walkthrough Scheduled or Estimate Sent row of their own.
    for (const label of [NEW_ROW, CONTACTED_ROW, COMPLETED_ROW]) expect(screen.getByText(label)).toBeInTheDocument();
    expect(stageSwitch(NEW_ROW)).toBeChecked();
    expect(stageInput(NEW_ROW)).toHaveValue('2');
    // The unit shows: his select's values now match the stored unit.
    expect(screen.getByRole('combobox', { name: `Time unit for ${NEW_ROW}` })).toHaveTextContent('hours');
    expect(stageSwitch(CONTACTED_ROW)).not.toBeChecked();
    expect(stageInput(CONTACTED_ROW)).toHaveAttribute('placeholder', 'None');
    expect(channelBox('In-app Message')).toBeChecked();
    expect(channelBox('Red Frame')).toBeChecked();
    expect(channelBox('Email')).not.toBeChecked();
    expect(channelBox('SMS')).not.toBeChecked();
    expect(screen.getByText('2/4 selected')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Notify Lead Owner' })).toBeChecked();
    expect(mockApi.get).toHaveBeenCalledWith(SETTINGS);
    // Our own extra copy is gone.
    for (const gone of [/alert after/i, /Who to alert/, /Nobody chosen/, /never watched/]) {
      expect(screen.queryByText(gone)).toBeNull();
    }
  });

  it("shows his defaults for a company that never saved: every channel, all four roles and the owner, every stage off", async () => {
    settingsBody = DEFAULT_SETTINGS_BODY;
    renderWithProviders(<SpiderPage />);
    await openConfig();
    for (const c of ['Email', 'SMS', 'In-app Message', 'Red Frame']) expect(channelBox(c)).toBeChecked();
    expect(screen.getByText('4/4 selected')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select all System roles' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Notify Lead Owner' })).toBeChecked();
    for (const label of [NEW_ROW, CONTACTED_ROW, COMPLETED_ROW]) {
      expect(stageSwitch(label)).not.toBeChecked();
      expect(stageInput(label)).toHaveValue('');
    }
  });

  it('lists the four roles with his labels, and users with their role and email', async () => {
    renderWithProviders(<SpiderPage />);
    await openConfig();
    fireEvent.click(screen.getByRole('button', { name: 'Toggle System role options' }));
    for (const r of ['Administrator (Owner)', 'Sales', 'Dispatcher', 'Technician']) {
      expect(screen.getByRole('checkbox', { name: r })).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole('button', { name: 'Toggle User options' }));
    expect(screen.getByText('Sales · rita@example.test')).toBeInTheDocument();
    expect(screen.getByText('0/2 selected')).toBeInTheDocument();
  });

  // D1: one switch. Saving never sends the switch, and the review's "Active" saves the settings only.
  it('has no on/off switch; while Active, Save opens his review, and confirming saves the settings only, then says Saved', async () => {
    renderWithProviders(<SpiderPage />);
    await openConfig();
    expect(screen.queryByRole('switch', SWITCH)).toBeNull();
    fireEvent.click(channelBox('Email'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const dialog = await screen.findByRole('dialog', { name: 'Confirm Spider Agent Configuration' });
    // Ran, 10 Nov: the mockup's title and subtitle, no old activation note, and the button says Save.
    expect(within(dialog).getByText('Review your campaign channels, recipients, stage thresholds, and monitored leads before saving.')).toBeInTheDocument();
    expect(within(dialog).queryByText(/Before You Activate/i)).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Active' })).toBeNull();
    for (const t of ['Monitored Pipeline Targets', 'Active Notification Channels', 'Assigned Alert Recipients', 'Pipeline Stage Thresholds']) {
      expect(within(dialog).getByText(t)).toBeInTheDocument();
    }
    expect(within(dialog).getByText('Auto-Enrolled')).toBeInTheDocument();
    expect(within(dialog).getByText('2 Roles Selected')).toBeInTheDocument();
    expect(within(dialog).getByText('2 Hours')).toBeInTheDocument();
    expect(within(dialog).getAllByText('Disabled').length).toBeGreaterThanOrEqual(2);
    // Nothing is sent until the review is confirmed.
    expect(settingsPuts()).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('button', { name: 'Saved' })).toBeInTheDocument();
    const [url, sent] = settingsPuts()[0]!;
    expect(url).toBe(SETTINGS);
    expect(sent).not.toHaveProperty('is_active');
    expect(sent).toEqual({
      status_limits: {
        NEW: { enabled: true, value: 2, unit: 'HOUR' },
        CONTACTED: { enabled: false, value: 1, unit: 'MINUTE' },
        WALKTHROUGH_COMPLETED: { enabled: false, value: 1, unit: 'MINUTE' },
      },
      channels: { in_app: true, red_frame: true, email: true, text: false },
      recipients: { roles: ['ADMIN', 'SALES'], user_ids: [], lead_owner: true },
    });
    // No tick changed: no exclusions request.
    expect(mockApi.patch).not.toHaveBeenCalled();
    expect(mockApi.put.mock.calls.filter(([u]) => u === STATUS)).toHaveLength(0);
    expect(toast).toHaveBeenCalledWith('Spider Agent Settings Saved', expect.objectContaining({
      description: 'Notification preferences, assignments, stage thresholds, and lead watchers have been successfully applied.',
    }));
  });

  it('the review counts the open leads Spider will watch, as the picker header does (#3436)', async () => {
    overviewBody = { watched: 2287, excluded: 13 };
    renderWithProviders(<SpiderPage />);
    await openConfig();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const dialog = await screen.findByRole('dialog', { name: 'Confirm Spider Agent Configuration' });
    expect(within(dialog).getByText('2,287 leads')).toBeInTheDocument();
    expect(within(dialog).queryByText(/Leads Selected/)).toBeNull();
  });

  it('enables a stage at 1, counts with the stepper, keeps minutes as minutes, and switches it off at 0', async () => {
    renderWithProviders(<SpiderPage />);
    await openConfig();
    fireEvent.click(stageSwitch(CONTACTED_ROW));
    expect(stageInput(CONTACTED_ROW)).toHaveValue('1');
    expect(screen.getByRole('combobox', { name: `Time unit for ${CONTACTED_ROW}` })).toHaveTextContent('minutes');
    // A count field: digits only, at least 1.
    fireEvent.change(stageInput(CONTACTED_ROW), { target: { value: '1x' } });
    expect(stageInput(CONTACTED_ROW)).toHaveValue('1');
    fireEvent.click(screen.getByRole('button', { name: `Increment time period for ${CONTACTED_ROW}` }));
    expect(stageInput(CONTACTED_ROW)).toHaveValue('2');
    // + on a row that is off switches it on at 1.
    fireEvent.click(screen.getByRole('button', { name: `Increment time period for ${COMPLETED_ROW}` }));
    expect(stageSwitch(COMPLETED_ROW)).toBeChecked();
    expect(stageInput(COMPLETED_ROW)).toHaveValue('1');
    fireEvent.click(screen.getByRole('button', { name: `Decrement time period for ${COMPLETED_ROW}` }));
    expect(stageSwitch(COMPLETED_ROW)).not.toBeChecked();

    await saveAndConfirm();
    await waitFor(() => expect(settingsPuts()).toHaveLength(1));
    const sent = settingsPuts()[0]![1] as { status_limits: Record<string, unknown> };
    expect(sent.status_limits.CONTACTED).toEqual({ enabled: true, value: 2, unit: 'MINUTE' });
    expect(sent.status_limits.WALKTHROUGH_COMPLETED).toEqual({ enabled: false, value: 1, unit: 'MINUTE' });
  });

  // D3: his three required checks, his callout, his toast. Nothing is sent.
  // While Active, Save's review is no activation (final review M2): Save's own words, never "Activate".
  it('refuses to save with nothing chosen: his callout with his three rules and the "Cannot Save Spider Settings" toast', async () => {
    settingsBody = EMPTY_SETTINGS_BODY;
    renderWithProviders(<SpiderPage />);
    await openConfig();
    const dialog = await saveAndConfirm();
    expect(within(dialog).getByText('Required Items Missing Before Saving (3)')).toBeInTheDocument();
    expect(within(dialog).queryByText(/Required Items Missing Before Activation/)).toBeNull();
    expect(within(dialog).getByText('At least one item must be selected from every required section before saving:')).toBeInTheDocument();
    expect(within(dialog).queryByText(/before activating/)).toBeNull();
    for (const rule of [
      'Please select at least one Notification Channel (Email, SMS, In-App, or Red Frame).',
      'Please assign at least one recipient (Admin Roles, Lead Owner, or Specific Users).',
      'Please set at least one stage duration threshold greater than 0.',
    ]) {
      expect(within(dialog).getByText(rule)).toBeInTheDocument();
    }
    expect(toast.error).toHaveBeenCalledWith('Cannot Save Spider Settings', expect.anything());
    expect(toast.error).not.toHaveBeenCalledWith('Cannot Activate Spider Agent', expect.anything());
    expect(settingsPuts()).toHaveLength(0);
    expect(screen.getByRole('dialog', { name: 'Confirm Spider Agent Configuration' })).toBeInTheDocument();
  });

  it('names only the rules still missing', async () => {
    settingsBody = EMPTY_SETTINGS_BODY;
    renderWithProviders(<SpiderPage />);
    await openConfig();
    fireEvent.click(channelBox('Email'));
    fireEvent.click(stageSwitch(NEW_ROW));
    const dialog = await saveAndConfirm();
    expect(within(dialog).getByText('Required Items Missing Before Saving (1)')).toBeInTheDocument();
    expect(within(dialog).getByText('Please assign at least one recipient (Admin Roles, Lead Owner, or Specific Users).')).toBeInTheDocument();
    expect(settingsPuts()).toHaveLength(0);
  });

  it('says "Failed to Save Settings" with the server\'s sentences, never a field name, and never "Saved"', async () => {
    mockApi.put.mockRejectedValue(
      Object.assign(new Error('x'), {
        response: {
          status: 400,
          data: {
            error: 'Validation failed',
            details: [{ field: 'status_limits.NEW.value', message: 'Limit can be at most one year' }],
          },
        },
      }),
    );
    renderWithProviders(<SpiderPage />);
    await openConfig();
    await saveAndConfirm();
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Failed to Save Settings', expect.objectContaining({
        description: 'New → Contacted: Limit can be at most one year',
      })),
    );
    expect(screen.queryByRole('button', { name: 'Saved' })).toBeNull();
    expect(toast).not.toHaveBeenCalledWith('Spider Agent Settings Saved', expect.anything());
  });

  it('says so, and follows to Not active, when Spider was deactivated while saving (409), keeping the edits', async () => {
    renderWithProviders(<SpiderPage />);
    await openConfig();
    fireEvent.click(channelBox('Email'));
    spiderSwitch = { ...spiderSwitch, isActive: false };
    mockApi.put.mockRejectedValue(
      Object.assign(new Error('x'), {
        response: { status: 409, data: { error: 'Spider was activated or deactivated while you were saving. Save again.' } },
      }),
    );
    await saveAndConfirm();
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Failed to Save Settings', expect.objectContaining({
        description: 'Spider was activated or deactivated while you were saving. Save again.',
      })),
    );
    expect(await statusBadge('Not active')).toBeInTheDocument();
    expect(screen.getByText(HEADING)).toBeInTheDocument();
    expect(channelBox('Email')).toBeChecked();
  });

  it('shows his load-error banner with Retry when the settings cannot be read', async () => {
    mockApi.get.mockImplementation(async (url: string) => {
      if (url === SETTINGS) throw Object.assign(new Error('Request failed'), { response: { status: 500, data: {} } });
      if (url === STATUS) return { data: spiderSwitch };
      return { data: {} };
    });
    renderWithProviders(<SpiderPage />);
    expect(await screen.findByText('Failed to load Spider configuration: Request failed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByText('Notifications')).toBeNull();
  });
});

// ─── Select Contacts for Alert ───────────────────────────────────────────────

// ─── History (S3: the contractor's History tab) ──────────────────────────────

const HISTORY_TAB = { name: 'History Tab' };
const CONFIG_TAB = { name: 'Configuration Tab' };

const historyCalls = () =>
  mockApi.post.mock.calls.filter(([u]) => u === HISTORY_SEARCH).map(([, body]) => body as Record<string, unknown>);

async function openHistory() {
  renderWithProviders(<SpiderPage />);
  fireEvent.click(await screen.findByRole('tab', HISTORY_TAB));
  return (await screen.findByText('L00042')).closest('tr')!;
}

describe('Spider history', () => {
  it('shows his eight columns: time, lead, stage, address, customer and company, outcome pills, recipients, preview', async () => {
    const row = await openHistory();
    for (const h of ['Date & Time', 'Lead ID', 'Stage', 'Lead Address', 'Customer Name', 'Notification Types', 'Recipients', 'Preview']) {
      expect(screen.getByRole('columnheader', { name: h })).toBeInTheDocument();
    }
    expect(within(row).getByText('Oct 1, 2026')).toBeInTheDocument();
    expect(within(row).getByText('1 Test Way, Testville, MA, 02108')).toBeInTheDocument();
    expect(within(row).getByText('Pat Payer')).toBeInTheDocument();
    expect(within(row).getByText('Payer Homes')).toBeInTheDocument();
    // The real outcome per channel, with his tooltips naming only what happened.
    expect(within(row).getByText('Email').closest('span[title]')).toHaveAttribute('title', 'Email: Successfully Sent to 2 recipient(s)');
    expect(within(row).getByText('SMS').closest('span[title]')).toHaveAttribute('title', 'SMS: Delivery Failed — Text message delivery failed');
    expect(within(row).getByText('In-App').closest('span[title]')).toHaveAttribute('title', 'In-App: Notification Delivered');
    expect(within(row).getByText('Rita Rep')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Preview' })).toBeInTheDocument();
  });

  it('"+N" lists every recipient with name, email and role (as the contractor did)', async () => {
    const row = await openHistory();
    fireEvent.click(within(row).getByRole('button', { name: 'View all recipients' }));
    const pop = await screen.findByText('All Assigned Recipients');
    const panel = pop.closest('[role="dialog"]') ?? pop.parentElement!.parentElement!;
    expect(within(panel as HTMLElement).getByText('2 total')).toBeInTheDocument();
    expect(within(panel as HTMLElement).getByText('ada@example.test')).toBeInTheDocument();
    expect(within(panel as HTMLElement).getByText('rita@example.test')).toBeInTheDocument();
    expect(within(panel as HTMLElement).getByText('ADMIN')).toBeInTheDocument();
    // Opening the list does not open the preview.
    expect(screen.queryByRole('dialog', { name: 'Delivered Message Preview' })).toBeNull();
  });

  it('pages on the server: "Showing a-b of N", his page controls, and 25 / 50 / 100 rows', async () => {
    await openHistory();
    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
    expect(screen.getByText('1-25')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(await screen.findByText('L00043')).toBeInTheDocument();
    expect(historyCalls().at(-1)).toEqual({ page: 2, page_size: 25 });
    expect(screen.getByRole('button', { name: 'First page' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Last page' })).toBeInTheDocument();
  });

  it('searches on the server, across every page, and starts again from page 1', async () => {
    await openHistory();
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByText('L00043');
    fireEvent.change(screen.getByPlaceholderText('Search leads...'), { target: { value: 'payer' } });
    await waitFor(() => expect(historyCalls().at(-1)).toEqual({ page: 1, page_size: 25, search: 'payer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    await waitFor(() => expect(historyCalls().at(-1)).toEqual({ page: 1, page_size: 25 }));
  });

  it("filtered to nothing shows his filtered empty state", async () => {
    const base = mockApi.get.getMockImplementation()!;
    mockApi.get.mockImplementation(async (url: string, config?: unknown) => {
      const params = (config as { params?: { search?: string } } | undefined)?.params;
      if (url === HISTORY && params?.search) return { data: { items: [], page: 1, page_size: 25, total: 0, total_pages: 1 } };
      return base(url, config as never);
    });
    await openHistory();
    fireEvent.change(screen.getByPlaceholderText('Search leads...'), { target: { value: 'nobody' } });
    expect(await screen.findByText('No notification logs matched your search filter.')).toBeInTheDocument();
    expect(screen.getByText('Try adjusting your search criteria or stage filter.')).toBeInTheDocument();
  });

  it("with no alerts at all shows his healthy state, naming the open leads Spider watches", async () => {
    const base = mockApi.get.getMockImplementation()!;
    mockApi.get.mockImplementation(async (url: string, config?: unknown) =>
      url === HISTORY ? { data: { items: [], page: 1, page_size: 25, total: 0, total_pages: 1 } } : base(url, config as never),
    );
    renderWithProviders(<SpiderPage />);
    fireEvent.click(await screen.findByRole('tab', HISTORY_TAB));
    expect(await screen.findByText('All Monitored Stage Leads are Healthy')).toBeInTheDocument();
    // The picker header's N (#3436).
    expect(screen.getByText(/Spider is actively monitoring 2 lead targets in the background\./)).toBeInTheDocument();
  });

  it('with leads excluded, counts only the watched ones, as the picker header does', async () => {
    overviewBody = { watched: 1, excluded: 1 };
    const base = mockApi.get.getMockImplementation()!;
    mockApi.get.mockImplementation(async (url: string, config?: unknown) =>
      url === HISTORY ? { data: { items: [], page: 1, page_size: 25, total: 0, total_pages: 1 } } : base(url, config as never),
    );
    renderWithProviders(<SpiderPage />);
    await openConfig();
    fireEvent.click(screen.getByRole('tab', HISTORY_TAB));
    expect(await screen.findByText(/Spider is actively monitoring 1 lead targets in the background\./)).toBeInTheDocument();
  });

  // Final review L1: a count that could not be read is never shown as "0"; the number's sentence is left out.
  it('with no alerts and no count read, claims no number of watched leads', async () => {
    const base = mockApi.get.getMockImplementation()!;
    mockApi.get.mockImplementation(async (url: string, config?: unknown) => {
      if (url === OVERVIEW) throw Object.assign(new Error('x'), { response: { status: 500, data: { error: 'Could not load Spider leads' } } });
      if (url === HISTORY) return { data: { items: [], page: 1, page_size: 25, total: 0, total_pages: 1 } };
      return base(url, config as never);
    });
    renderWithProviders(<SpiderPage />);
    fireEvent.click(await screen.findByRole('tab', HISTORY_TAB));
    expect(await screen.findByText('All Monitored Stage Leads are Healthy')).toBeInTheDocument();
    expect(screen.getByText('When overdue alerts trigger, notification logs and message previews will appear here.')).toBeInTheDocument();
    expect(screen.queryByText(/actively monitoring/)).toBeNull();
  });

  it('the Customers filter lists every customer and searches inside the list (tested with 1,000)', async () => {
    filterCustomers = Array.from({ length: 1000 }, (_, i) => ({ value: `cust-${i}`, label: `Customer ${String(i).padStart(4, '0')}` }));
    await openHistory();
    fireEvent.click(screen.getByRole('button', { name: /Filter/ }));
    const facets = await screen.findByRole('tablist', { name: 'Filter facets' });
    fireEvent.click(within(facets).getByRole('tab', { name: 'Customers' }));
    const search = await screen.findByRole('searchbox', { name: 'Search Customers' });
    expect(screen.getAllByRole('checkbox').length).toBeGreaterThanOrEqual(1000);
    fireEvent.change(search, { target: { value: 'Customer 0999' } });
    expect(screen.getAllByRole('checkbox', { name: /^Customer / })).toHaveLength(1);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Customer 0999' }));
    await waitFor(() => expect(historyCalls().at(-1)).toMatchObject({ customers: ['cust-999'] }));
  });

  it("shows his load error with the server's sentence, and Retry asks again", async () => {
    const base = mockApi.get.getMockImplementation()!;
    mockApi.get.mockImplementation(async (url: string, config?: unknown) => {
      if (url === HISTORY) throw Object.assign(new Error('x'), { response: { status: 500, data: { error: 'Could not load Spider history' } } });
      return base(url, config as never);
    });
    renderWithProviders(<SpiderPage />);
    fireEvent.click(await screen.findByRole('tab', HISTORY_TAB));
    expect(await screen.findByText('Failed to load notification history')).toBeInTheDocument();
    expect(screen.getByText('Could not load Spider history')).toBeInTheDocument();
    const before = historyCalls().length;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(historyCalls().length).toBeGreaterThan(before));
  });

  it('Refresh reads the page again (his tooltip), and nothing polls', async () => {
    await openHistory();
    const refresh = screen.getByRole('button', { name: 'Refresh' });
    expect(refresh).toHaveAttribute('title', 'Refresh notification logs from database');
    const before = historyCalls().length;
    fireEvent.click(refresh);
    await waitFor(() => expect(historyCalls().length).toBe(before + 1));
  });

  it("the filter offers his five facets, Stage limited to Spider's three, and sends the choice to the server", async () => {
    filterCustomers = [{ value: 'cust-pat', label: 'Pat Payer' }, { value: 'cust-sam', label: 'Sam Shore' }];
    await openHistory();
    fireEvent.click(screen.getByRole('button', { name: /Filter/ }));
    const facets = await screen.findByRole('tablist', { name: 'Filter facets' });
    expect(within(facets).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Stage', 'Date / Time', 'Recipients', 'Customers', 'Role']);
    expect(screen.getByRole('checkbox', { name: 'New' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Walkthrough' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Won' })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Contacted' }));
    await waitFor(() => expect(historyCalls().at(-1)).toEqual({ page: 1, page_size: 25, stage: ['CONTACTED'] }));

    fireEvent.click(within(facets).getByRole('tab', { name: 'Role' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Administrator (Owner)' }));
    await waitFor(() => expect(historyCalls().at(-1)).toMatchObject({ stage: ['CONTACTED'], roles: ['ADMIN'] }));

    fireEvent.click(within(facets).getByRole('tab', { name: 'Customers' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pat Payer' }));
    await waitFor(() => expect(historyCalls().at(-1)).toMatchObject({ customers: ['cust-pat'] }));
  });

  it('Custom Date opens a date field and filters to that day', async () => {
    await openHistory();
    fireEvent.click(screen.getByRole('button', { name: /Filter/ }));
    const facets = await screen.findByRole('tablist', { name: 'Filter facets' });
    fireEvent.click(within(facets).getByRole('tab', { name: 'Date / Time' }));
    expect(screen.queryByLabelText('Custom Date', { selector: 'input' })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Custom Date' }));
    const field = await screen.findByLabelText('Custom Date', { selector: 'input' });
    // Typed in the browser's date pattern, committed when the field is left.
    fireEvent.change(field, { target: { value: '10/01/2026' } });
    fireEvent.blur(field);
    const from = new Date(2026, 9, 1).toISOString();
    const to = new Date(new Date(2026, 9, 2).getTime() - 1).toISOString();
    await waitFor(() => expect(historyCalls().at(-1)).toMatchObject({ ranges: [`${from}~${to}`] }));
  });

  it('Export: his menu, the page on screen, or every filtered row from the server', async () => {
    const csv = await import('@/lib/csv');
    const spy = vi.spyOn(csv, 'exportCsvFile').mockImplementation(() => undefined);
    await openHistory();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Export' }), { button: 0, ctrlKey: false });
    expect(await screen.findByText('Export Notification History')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Current page (1 logs)' }));
    expect(spy).toHaveBeenCalledWith(
      expect.stringMatching(/^spider_notification_history_current_page_\d{4}-\d{2}-\d{2}\.csv$/),
      ['Date', 'Time', 'Lead ID', 'Lead Address', 'Customer', 'Stage', 'Recipients', 'Status'],
      [expect.arrayContaining(['L00042', '1 Test Way, Testville, MA, 02108', 'Pat Payer', 'New', 'Rita Rep, Ada Admin', 'FAILED'])],
    );
    expect(toast).toHaveBeenCalledWith('Export Complete', expect.objectContaining({
      description: 'Successfully exported 1 notification history records to CSV.',
    }));

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Export' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'All filtered (26 logs)' }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(mockApi.post).toHaveBeenCalledWith(HISTORY_EXPORT, {}, expect.anything());
    expect(spy.mock.calls[1]?.[2]).toHaveLength(2);
    spy.mockRestore();
  });

  it('"Select all" on 250 customers loads History, filtering nothing', async () => {
    filterCustomers = Array.from({ length: 250 }, (_, i) => ({ value: `cust-${i}`, label: `Customer ${String(i).padStart(3, '0')}` }));
    await openHistory();
    fireEvent.click(screen.getByRole('button', { name: /Filter/ }));
    const facets = await screen.findByRole('tablist', { name: 'Filter facets' });
    fireEvent.click(within(facets).getByRole('tab', { name: 'Customers' }));
    await screen.findByRole('searchbox', { name: 'Search Customers' });
    const before = historyCalls().length;
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
    await waitFor(() => expect(historyCalls().length).toBeGreaterThan(before));
    expect(historyCalls().at(-1)).toEqual({ page: 1, page_size: 25 });
    expect(await screen.findByText('L00042')).toBeInTheDocument();
    expect(screen.queryByText('Failed to load notification history')).toBeNull();
  });

  it('Export: when the server stops at its cap, the toast says how many of how many', async () => {
    const csv = await import('@/lib/csv');
    const spy = vi.spyOn(csv, 'exportCsvFile').mockImplementation(() => undefined);
    const basePost = mockApi.post.getMockImplementation()!;
    mockApi.post.mockImplementation(async (url: string, body?: unknown) =>
      url === HISTORY_EXPORT
        ? { data: { items: [HISTORY_ROW, { ...HISTORY_ROW, id: 'a2' }], total: 7342, truncated: true } }
        : basePost(url, body as never),
    );
    await openHistory();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Export' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'All filtered (26 logs)' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Export Complete', expect.objectContaining({
      description: 'Exported 2 of 7342 notification history records to CSV.',
    })));
    spy.mockRestore();
  });

  it('Export: a failed "All filtered" says so, with the server\'s sentence', async () => {
    const csv = await import('@/lib/csv');
    const spy = vi.spyOn(csv, 'exportCsvFile').mockImplementation(() => undefined);
    const basePost = mockApi.post.getMockImplementation()!;
    mockApi.post.mockImplementation(async (url: string, body?: unknown) => {
      if (url === HISTORY_EXPORT) throw Object.assign(new Error('x'), { response: { status: 500, data: { error: 'Could not export Spider history' } } });
      return basePost(url, body as never);
    });
    await openHistory();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Export' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'All filtered (26 logs)' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(JSON.stringify(vi.mocked(toast.error).mock.calls)).toContain('Could not export Spider history');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('says so when the filter options fail to load', async () => {
    const base = mockApi.get.getMockImplementation()!;
    mockApi.get.mockImplementation(async (url: string, config?: unknown) => {
      if (url === HISTORY_FILTERS) throw Object.assign(new Error('x'), { response: { status: 500, data: { error: 'Could not load Spider history' } } });
      return base(url, config as never);
    });
    await openHistory();
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(JSON.stringify(vi.mocked(toast.error).mock.calls)).toContain('Failed to load filter options');
  });

  describe('with a server from before S3 (the two deploy separately)', () => {
    beforeEach(() => {
      const base = mockApi.get.getMockImplementation()!;
      const notFound = () => Object.assign(new Error('x'), { response: { status: 404, data: {} } });
      mockApi.get.mockImplementation(async (url: string, config?: unknown) => {
        if (url === HISTORY_SUMMARY || url === HISTORY_FILTERS) throw notFound();
        if (url === HISTORY) return { data: { items: [PRE_S3_ROW], page: 1, page_size: 25, total: 1, total_pages: 1 } };
        return base(url, config as never);
      });
      mockApi.post.mockImplementation(async () => {
        throw notFound();
      });
    });

    it('renders its rows from the old fields: no badge, no invented stage, outcome or time, and no error', async () => {
      renderWithProviders(<SpiderPage />);
      const tab = await screen.findByRole('tab', HISTORY_TAB);
      expect(tab).toHaveTextContent(/^History$/);
      fireEvent.click(tab);
      const row = (await screen.findByText('L00009')).closest('tr')!;
      expect(within(row).getByText('New')).toBeInTheDocument();
      expect(within(row).getByText('Rita Rep')).toBeInTheDocument();
      expect(within(row).queryByText('Email')).toBeNull();
      expect(within(row).queryByText('SMS')).toBeNull();
      fireEvent.click(within(row).getByRole('button', { name: 'Preview' }));
      const drawer = await screen.findByRole('dialog', { name: 'Delivered Message Preview' });
      // The time is worked out from the two instants it sends: 3 hours.
      expect(within(drawer).getByText('Action Required: Lead has been inactive for 3 hours in New stage.')).toBeInTheDocument();
      expect(within(drawer).queryByText('Delivered')).toBeNull();
      expect(toast.error).not.toHaveBeenCalled();
    });

    it('a row with no stage at all shows "—", never "New"', async () => {
      const base = mockApi.get.getMockImplementation()!;
      mockApi.get.mockImplementation(async (url: string, config?: unknown) =>
        url === HISTORY
          ? { data: { items: [{ ...PRE_S3_ROW, status_label: undefined, limit: undefined }], page: 1, page_size: 25, total: 1, total_pages: 1 } }
          : base(url, config as never),
      );
      renderWithProviders(<SpiderPage />);
      fireEvent.click(await screen.findByRole('tab', HISTORY_TAB));
      const row = (await screen.findByText('L00009')).closest('tr')!;
      expect(within(row).queryByText('New')).toBeNull();
      expect(within(row).getByText('—')).toBeInTheDocument();
      fireEvent.click(within(row).getByRole('button', { name: 'Preview' }));
      const drawer = await screen.findByRole('dialog', { name: 'Delivered Message Preview' });
      expect(within(drawer).getByText('Action Required: Lead has been inactive for — in — stage.')).toBeInTheDocument();
    });

    it('opens his filter with empty Recipients and Customers lists, quietly', async () => {
      renderWithProviders(<SpiderPage />);
      fireEvent.click(await screen.findByRole('tab', HISTORY_TAB));
      await screen.findByText('L00009');
      fireEvent.click(screen.getByRole('button', { name: /Filter/ }));
      const facets = await screen.findByRole('tablist', { name: 'Filter facets' });
      const panel = facets.parentElement!;
      fireEvent.click(within(facets).getByRole('tab', { name: 'Customers' }));
      expect(within(panel).queryAllByRole('checkbox')).toHaveLength(0);
      fireEvent.click(within(facets).getByRole('tab', { name: 'Recipients' }));
      expect(within(panel).queryAllByRole('checkbox')).toHaveLength(0);
      expect(toast.error).not.toHaveBeenCalled();
    });
  });

  describe('the preview drawer', () => {
    async function openPreview() {
      const row = await openHistory();
      fireEvent.click(within(row).getByRole('button', { name: 'Preview' }));
      return screen.findByRole('dialog', { name: 'Delivered Message Preview' });
    }

    it('shows his header and the real outcome of each channel', async () => {
      const drawer = await openPreview();
      expect(within(drawer).getByText('Delivered Message Preview')).toBeInTheDocument();
      expect(within(drawer).getByText('(Payer Homes)')).toBeInTheDocument();
      expect(within(drawer).getByText('Delivery Outcomes')).toBeInTheDocument();
      const tile = (label: string) => within(drawer).getAllByText(label)[0]!.closest('.grid > div') as HTMLElement;
      expect(tile('Email')).toHaveTextContent('Sent');
      expect(tile('SMS')).toHaveTextContent('Failed');
      expect(tile('In-App')).toHaveTextContent('Delivered');
    });

    it('Email: from, time, the recipients\' emails, his card, the stored body and the open-lead button', async () => {
      const drawer = await openPreview();
      expect(within(drawer).getByText('ServWave Spider Alerts <alerts@spider.servwave.com>')).toBeInTheDocument();
      expect(within(drawer).getByText('rita@example.test, ada@example.test')).toBeInTheDocument();
      expect(within(drawer).getByText('Spider Lead Alert')).toBeInTheDocument();
      expect(within(drawer).getByText('Action Required: Lead has been inactive for 3 hours in New stage.')).toBeInTheDocument();
      expect(within(drawer).getByText(/This lead was created 3 hours ago and has not yet been contacted\.\s+View lead:/)).toBeInTheDocument();
      expect(within(drawer).getByRole('button', { name: 'Open Lead #L00042 in Pipeline' })).toBeInTheDocument();
    });

    it('SMS and In-App tabs show the texts that went out', async () => {
      const drawer = await openPreview();
      fireEvent.click(within(drawer).getByRole('tab', { name: 'SMS' }));
      expect(within(drawer).getByText('Rita Rep, Ada Admin')).toBeInTheDocument();
      expect(within(drawer).getByText('🕷️ Spider AI Alert:')).toBeInTheDocument();
      expect(within(drawer).getByText(/Spider Alert - Pat Payer \(L00042\)/)).toBeInTheDocument();
      fireEvent.click(within(drawer).getByRole('tab', { name: 'In-App' }));
      expect(within(drawer).getByText('Overdue Lead: #L00042 - Pat Payer')).toBeInTheDocument();
      expect(within(drawer).getByText('This lead was created 3 hours ago and has not yet been contacted.')).toBeInTheDocument();
    });

    it('Escape closes it; a row click opens it and the button reads Close', async () => {
      const row = await openHistory();
      fireEvent.click(row);
      expect(await screen.findByRole('dialog', { name: 'Delivered Message Preview' })).toBeInTheDocument();
      expect(within(row).getByRole('button', { name: 'Close' })).toBeInTheDocument();
      fireEvent.keyDown(window, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Delivered Message Preview' })).toBeNull());
    });

    it('an alert from before the History copy: no invented text, no "Sent" for what is unknown', async () => {
      const base = mockApi.get.getMockImplementation()!;
      mockApi.get.mockImplementation(async (url: string, config?: unknown) =>
        url === HISTORY ? { data: { items: [OLD_HISTORY_ROW], page: 1, page_size: 25, total: 1, total_pages: 1 } } : base(url, config as never),
      );
      renderWithProviders(<SpiderPage />);
      fireEvent.click(await screen.findByRole('tab', HISTORY_TAB));
      const row = (await screen.findByText('L00007')).closest('tr')!;
      // Email and in-app unknown, SMS switched off: no pill claims anything.
      expect(within(row).queryByText('Email')).toBeNull();
      expect(within(row).queryByText('SMS')).toBeNull();
      expect(within(row).queryByText('In-App')).toBeNull();
      fireEvent.click(within(row).getByRole('button', { name: 'Preview' }));
      const drawer = await screen.findByRole('dialog', { name: 'Delivered Message Preview' });
      const tile = (label: string) => within(drawer).getAllByText(label)[0]!.closest('.grid > div') as HTMLElement;
      expect(tile('Email')).toHaveTextContent('—');
      expect(tile('SMS')).toHaveTextContent('Skipped');
      expect(tile('In-App')).toHaveTextContent('—');
      expect(within(drawer).queryByText('Delivered')).toBeNull();
      expect(within(drawer).getAllByText('—').length).toBeGreaterThan(0);
    });
  });

  describe('the History count badge', () => {
    const KEY = 'servwave_spider_last_viewed_history_at';
    const summaryCalls = () =>
      mockApi.get.mock.calls.filter(([u]) => u === HISTORY_SUMMARY).map(([, c]) => (c as { params: Record<string, unknown> }).params);

    it('counts every alert before History was ever opened, then clears and remembers the visit under his key', async () => {
      summaryBody = { total: 26, new_since: 26 };
      renderWithProviders(<SpiderPage />);
      const tab = await screen.findByRole('tab', HISTORY_TAB);
      await waitFor(() => expect(within(tab).getByText('26')).toBeInTheDocument());
      expect(summaryCalls()[0]).toEqual({});

      const before = Date.now();
      fireEvent.click(tab);
      expect(within(tab).queryByText('26')).toBeNull();
      const saved = Number(localStorage.getItem(KEY));
      expect(saved).toBeGreaterThanOrEqual(before);
    });

    it('counts only alerts newer than the stored last view, asked of the server', async () => {
      localStorage.setItem(KEY, String(Date.UTC(2026, 9, 1, 12)));
      renderWithProviders(<SpiderPage />);
      const tab = await screen.findByRole('tab', HISTORY_TAB);
      await waitFor(() => expect(within(tab).getByText('4')).toBeInTheDocument());
      expect(summaryCalls()[0]).toEqual({ since: '2026-10-01T12:00:00.000Z' });
    });

    it('shows no badge when nothing is new', async () => {
      summaryBody = { total: 26, new_since: 0 };
      localStorage.setItem(KEY, String(Date.now()));
      renderWithProviders(<SpiderPage />);
      const tab = await screen.findByRole('tab', HISTORY_TAB);
      await waitFor(() => expect(summaryCalls().length).toBeGreaterThan(0));
      expect(tab).toHaveTextContent(/^History$/);
    });
  });
});

// ─── The page frame ──────────────────────────────────────────────────────────

describe('the Spider page frame', () => {
  it('has his back button, header card and tabs, with the status and Deactivate on the right', async () => {
    renderWithProviders(<SpiderPage />);
    await openConfig();
    expect(screen.getByRole('heading', { name: 'Spider' })).toBeInTheDocument();
    expect(screen.getByText('AI Lead Manager')).toBeInTheDocument();
    expect(screen.getByText('New', { selector: 'span.uppercase' })).toBeInTheDocument();
    expect(screen.getByText('Proactively monitor pipeline progression, prevent lead stagnation, and trigger automated multi-channel escalation alerts.')).toBeInTheDocument();
    expect(screen.getByRole('tab', CONFIG_TAB)).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', HISTORY_TAB)).toBeInTheDocument();
    expect(screen.getByText('Make sure to save changes before leaving the page.')).toBeInTheDocument();
    // His Active / Deactivated control is replaced by the status badge and Deactivate (#3432).
    expect(screen.queryByRole('button', { name: 'Spider Status' })).toBeNull();
    expect(screen.queryByText('Deactivated')).toBeNull();
    expect(screen.queryByRole('switch', SWITCH)).toBeNull();
    expect(await statusBadge('Active')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deactivate' })).toBeInTheDocument();
  });

  it('"AI Agentic Farm" reopens the AI Center over the page, without leaving it', async () => {
    useAiCenterStore.setState({ open: false, focusAgentId: null });
    renderWithProviders(<SpiderPage />);
    await openConfig();
    fireEvent.click(screen.getByRole('button', { name: 'AI Agentic Farm' }));
    expect(useAiCenterStore.getState().open).toBe(true);
    expect(screen.getByText(HEADING)).toBeInTheDocument();
  });
});

describe('the Spider route', () => {
  function routed() {
    return renderWithProviders(
      <Routes>
        <Route element={<RequireSpider />}>
          <Route path="/spider" element={<SpiderPage />} />
        </Route>
        <Route path="/" element={<div>Dashboard</div>} />
      </Routes>,
      { initialEntries: ['/spider'] },
    );
  }

  it.each([
    ['without the feature', { ...ADMIN, org_features: ['leads'] }],
    ['that is not a demo company', { ...ADMIN, org_is_demo: false }],
    ['that is not a demo company and not on the pilot list', { ...ADMIN, org_is_demo: false, org_is_spider_pilot: false }],
    ['on the pilot list but without the feature', { ...ADMIN, org_is_demo: false, org_is_spider_pilot: true, org_features: ['leads'] }],
  ])('sends a company %s to the dashboard and makes no Spider request', async (_l, user) => {
    signIn(user);
    routed();
    expect(await screen.findByText('Dashboard')).toBeInTheDocument();
    expect(spiderCalls()).toBe(0);
  });

  it('opens for a company with Spider', async () => {
    routed();
    expect(await screen.findByText(HEADING)).toBeInTheDocument();
  });

  // SPEC-5: a real (non-demo) company on the server's Spider pilot list.
  it('opens for an Admin of a pilot company, with the Configuration and History tabs', async () => {
    signIn({ ...ADMIN, org_is_demo: false, org_is_spider_pilot: true });
    routed();
    expect(await screen.findByText(HEADING)).toBeInTheDocument();
    expect(await screen.findByRole('tab', CONFIG_TAB)).toBeInTheDocument();
    expect(screen.getByRole('tab', HISTORY_TAB)).toBeInTheDocument();
    expect(screen.queryByText('Dashboard')).toBeNull();
  });
});

describe('the AI Center', () => {
  beforeEach(() => {
    useAiCenterStore.setState({ open: true, focusAgentId: null });
  });

  // The catalog's Spider card shows the status too, so the one Spider request is its status:
  // never the Admin-only settings or history, whichever agent is open.
  it('opening a non-Spider agent asks only for the Spider status, for the Spider card', async () => {
    useAiCenterStore.setState({ focusAgentId: 'mike' });
    renderWithProviders(<AiCenterModal />);
    expect(await screen.findByText('Book a call about Border Collie')).toBeInTheDocument();
    await waitFor(() => expect(spiderCalls()).toBe(1));
    expect(mockApi.get).toHaveBeenCalledWith(STATUS, expect.anything());
  });

  /** The Spider pop-up, once its status has been read. */
  async function spiderDialog(badge: 'Active' | 'Not active') {
    const dialog = await screen.findByRole('dialog', { name: 'Spider' });
    await within(dialog).findByText(badge, { selector: '[data-agent-chip]' });
    return dialog;
  }

  // #3433: no switch in the pop-up; Activate lives only on the Spider page, after its review.
  it('shows an Admin Not active, no switch and a working "Set up Spider" while Spider is Not active, asking only for the status', async () => {
    spiderSwitch = { isActive: false, isSetUp: true };
    useAiCenterStore.setState({ focusAgentId: 'spider' });
    renderWithProviders(<AiCenterModal />);
    const dialog = await spiderDialog('Not active');
    expect(within(dialog).queryByRole('switch')).toBeNull();
    // #3432: the page opens while Spider is not active, so its way in is never locked.
    expect(within(dialog).getByRole('button', { name: 'Set up Spider' })).not.toHaveAttribute('aria-disabled');
    expect(within(dialog).queryByRole('link')).toBeNull();
    expect(screen.queryByText('Book a call about Spider')).toBeNull();
    // The only Spider request is the status: never the Admin-only settings or history.
    expect(mockApi.get.mock.calls.filter(([url]) => String(url).includes('/spider/')).map(([url]) => url)).toEqual([STATUS]);
  });

  it('shows Active, no switch and never the words On / Off, when Spider is Active', async () => {
    mockApi.get.mockImplementation(async (url: string) =>
      url === STATUS ? { data: { isActive: true, isSetUp: true } } : { data: {} },
    );
    useAiCenterStore.setState({ focusAgentId: 'spider' });
    renderWithProviders(<AiCenterModal />);
    const dialog = await spiderDialog('Active');
    expect(within(dialog).queryByRole('switch')).toBeNull();
    expect(screen.queryAllByText(/^(On|Off)$|Spider is (on|off)/)).toHaveLength(0);
  });

  it('"Open Spider" closes the catalog and opens the Spider page while Spider is on', async () => {
    mockApi.get.mockImplementation(async (url: string) =>
      url === STATUS ? { data: { isActive: true, isSetUp: true } } : { data: {} },
    );
    useAiCenterStore.setState({ focusAgentId: 'spider' });
    renderWithProviders(
      <Routes>
        <Route path="/" element={<AiCenterModal />} />
        <Route path="/spider" element={<div>Spider page</div>} />
      </Routes>,
    );
    const dialog = await spiderDialog('Active');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open Spider' }));
    expect(await screen.findByText('Spider page')).toBeInTheDocument();
    expect(useAiCenterStore.getState().open).toBe(false);
  });

  // One status, two surfaces: Deactivate in the pop-up moves the page's badge in place.
  it('the Spider page follows the pop-up\'s Deactivate in place, settings shown throughout', async () => {
    spiderSwitch = { isActive: true, isSetUp: true };
    useAiCenterStore.setState({ focusAgentId: 'spider' });
    renderWithProviders(
      <>
        <SpiderPage />
        <AiCenterModal />
      </>,
    );
    const dialog = await spiderDialog('Active');
    expect(await statusBadge('Active')).toBeInTheDocument();
    expect(screen.getByText(HEADING)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Deactivate' }));
    fireEvent.click(within(await screen.findByRole('alertdialog', { name: 'Deactivate Spider?' })).getByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(mockApi.put).toHaveBeenCalledWith(STATUS, { isActive: false }, expect.anything()));
    expect(await statusBadge('Not active')).toBeInTheDocument();
    expect(screen.getByText(HEADING)).toBeInTheDocument();
  });

  it('claims nothing when the status cannot be read', async () => {
    mockApi.get.mockImplementation(async (url: string) => {
      if (url === STATUS) throw Object.assign(new Error('x'), { response: { status: 404, data: { error: 'Not found' } } });
      return { data: {} };
    });
    useAiCenterStore.setState({ focusAgentId: 'spider' });
    renderWithProviders(<AiCenterModal />);
    await waitFor(() => expect(mockApi.get).toHaveBeenCalledWith(STATUS, expect.anything()));
    const dialog = screen.getByRole('dialog', { name: 'Spider' });
    await waitFor(() => expect(dialog.querySelector('[data-agent-control-row]')).toBeNull());
    for (const words of ['Active', 'Not active', 'Coming soon']) expect(within(dialog).queryByText(words)).toBeNull();
    expect(within(dialog).queryByRole('switch')).toBeNull();
  });

  it('shows a non-Admin the status without the buttons: no switch, no Deactivate, no button to its page', async () => {
    spiderSwitch = { isActive: true, isSetUp: true };
    signIn({ ...ADMIN, role: 'SALES', is_admin: false });
    useAiCenterStore.setState({ focusAgentId: 'spider' });
    renderWithProviders(<AiCenterModal />);
    const dialog = await spiderDialog('Active');
    expect(within(dialog).queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('button', { name: /Open Spider|Set up Spider|Deactivate/ })).toBeNull();
  });

  it('keeps Spider as "Coming soon" and "Book a call" for a company without Spider, and asks nothing', async () => {
    signIn({ ...ADMIN, org_is_demo: false });
    useAiCenterStore.setState({ focusAgentId: 'spider' });
    renderWithProviders(<AiCenterModal />);
    expect(await screen.findByText('Book a call about Spider')).toBeInTheDocument();
    const dialog = screen.getByRole('dialog', { name: 'Spider' });
    expect(within(dialog).getByText('Coming soon')).toBeInTheDocument();
    expect(within(dialog).queryByText('Off')).toBeNull();
    expect(within(dialog).queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open Spider' })).toBeNull();
    expect(spiderCalls()).toBe(0);
  });
});

// #3432 (Ran, 10 Nov): the page opens whether Spider is Not active or Active; the status and its
// buttons are covered in spiderActivation.test.tsx. Here: what shows before the status is read.
describe('the Spider page before its status is read', () => {
  it('shows a placeholder, never a status or the settings, until the status is read', async () => {
    mockApi.get.mockImplementation((url: string) => (url === STATUS ? new Promise(() => {}) : Promise.resolve({ data: SETTINGS_BODY })));
    renderWithProviders(<SpiderPage />);
    await waitFor(() => expect(readsOf(STATUS)).toBe(1));
    expect(document.querySelector('[data-spider-page-placeholder]')).not.toBeNull();
    expect(document.querySelector('[data-spider-status="loading"]')).not.toBeNull();
    expect(document.querySelector('[data-agent-chip]')).toBeNull();
    expect(screen.queryByText(HEADING)).toBeNull();
    expect(screen.queryByRole('button', { name: /Activate|Deactivate/ })).toBeNull();
    expect(readsOf(SETTINGS)).toBe(0);
  });

  it('shows the settings and History while Not active', async () => {
    spiderSwitch = { isActive: false, isSetUp: true };
    renderWithProviders(<SpiderPage />);
    await openConfig();
    expect(await statusBadge('Not active')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', HISTORY_TAB));
    expect(await screen.findByText('L00042')).toBeInTheDocument();
  });

  it('claims nothing and opens nothing when the status cannot be read', async () => {
    mockApi.get.mockImplementation(async (url: string) => {
      if (url === STATUS) throw Object.assign(new Error('x'), { response: { status: 500, data: {} } });
      return { data: SETTINGS_BODY };
    });
    renderWithProviders(<SpiderPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load whether Spider is on.');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(document.querySelector('[data-agent-chip]')).toBeNull();
    expect(screen.queryByText(HEADING)).toBeNull();
    expect(screen.queryByRole('button', { name: /Activate|Deactivate/ })).toBeNull();
    expect(readsOf(SETTINGS)).toBe(0);
  });
});

it('does not ask for History until its tab is opened', async () => {
  renderWithProviders(<SpiderPage />);
  await openConfig();
  await waitFor(() => expect(readsOf(HISTORY)).toBe(0));
});

// Ran, 14 Oct (#2793): "As long as we haven't left the Spider page, the edits should stay intact."
// The draft lives in the page while Spider is on; nothing of it is kept in the browser.
describe('unsaved Spider settings across the tabs', () => {
  const configTab = () => screen.getByRole('tab', CONFIG_TAB);

  it('keeps the edits through Configuration -> History -> Configuration, any number of times', async () => {
    renderWithProviders(<SpiderPage />);
    await openConfig();
    fireEvent.click(stageSwitch(NEW_ROW));
    fireEvent.click(channelBox('Email'));
    fireEvent.click(stageSwitch(CONTACTED_ROW));
    fireEvent.change(stageInput(CONTACTED_ROW), { target: { value: '7' } });

    for (let round = 0; round < 3; round++) {
      fireEvent.click(screen.getByRole('tab', HISTORY_TAB));
      expect(await screen.findByText('L00042')).toBeInTheDocument();
      expect(screen.queryByText(HEADING)).toBeNull();
      fireEvent.click(configTab());
      expect(await screen.findByText(HEADING)).toBeInTheDocument();
      expect(stageSwitch(NEW_ROW)).not.toBeChecked();
      expect(channelBox('Email')).toBeChecked();
      expect(stageInput(CONTACTED_ROW)).toHaveValue('7');
    }
    // Kept in memory only: never sent anywhere until Save.
    expect(mockApi.put).not.toHaveBeenCalled();
  });

  it('never lets a background refetch overwrite the edits', async () => {
    const { queryClient } = renderWithProviders(<SpiderPage />);
    await openConfig();
    fireEvent.click(stageSwitch(NEW_ROW));
    // Meanwhile the server's copy changed (another Admin saved): SMS is now on.
    settingsBody = { ...SETTINGS_BODY, settings: { ...SETTINGS_BODY.settings, channels: { ...SETTINGS_BODY.settings.channels, text: true } } };
    const before = readsOf(SETTINGS);
    await queryClient.refetchQueries({ queryKey: ['spider', 'settings'] });
    await waitFor(() => expect(readsOf(SETTINGS)).toBeGreaterThan(before));
    // The draft stands, on this tab and after a trip to History and back.
    expect(stageSwitch(NEW_ROW)).not.toBeChecked();
    expect(channelBox('SMS')).not.toBeChecked();
    fireEvent.click(screen.getByRole('tab', HISTORY_TAB));
    await queryClient.refetchQueries({ queryKey: ['spider', 'settings'] });
    fireEvent.click(configTab());
    expect(stageSwitch(NEW_ROW)).not.toBeChecked();
  });

  it('takes a refetched copy when there is nothing unsaved', async () => {
    const { queryClient } = renderWithProviders(<SpiderPage />);
    await openConfig();
    settingsBody = { ...SETTINGS_BODY, settings: { ...SETTINGS_BODY.settings, channels: { ...SETTINGS_BODY.settings.channels, text: true } } };
    await queryClient.refetchQueries({ queryKey: ['spider', 'settings'] });
    await waitFor(() => expect(channelBox('SMS')).toBeChecked());
  });

  it('drops the draft once the page is left: coming back starts from the server copy', async () => {
    function Nav() {
      const navigate = useNavigate();
      return (
        <>
          <button type="button" onClick={() => navigate('/elsewhere')}>Leave</button>
          <button type="button" onClick={() => navigate('/spider')}>Back to Spider</button>
        </>
      );
    }
    // The prototype of the storage the page really writes to: jsdom's Storage on Node 22 (CI), Node's
    // own on newer Node, where a spy on jsdom's Storage.prototype sees nothing.
    const setItem = vi.spyOn(Object.getPrototypeOf(globalThis.localStorage) as Storage, 'setItem');
    renderWithProviders(
      <>
        <Nav />
        <Routes>
          <Route path="/spider" element={<SpiderPage />} />
          <Route path="/elsewhere" element={<div>Somewhere else</div>} />
        </Routes>
      </>,
      { initialEntries: ['/spider'] },
    );
    await openConfig();
    fireEvent.click(stageSwitch(NEW_ROW));
    fireEvent.click(screen.getByRole('tab', HISTORY_TAB));
    await screen.findByText('L00042');
    fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
    expect(await screen.findByText('Somewhere else')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to Spider' }));
    await openConfig();
    expect(stageSwitch(NEW_ROW)).toBeChecked();
    expect(configTab()).toHaveAttribute('aria-selected', 'true');
    // Nothing of the draft was kept in the browser, nor sent to the server. The one Spider key written
    // is his "last viewed History" time (opening History writes it, Ran 15 Oct): a time, no settings.
    const spiderWrites = setItem.mock.calls.filter(([key]) => /spider/i.test(String(key)));
    expect(spiderWrites.map(([key]) => key)).toEqual(['servwave_spider_last_viewed_history_at']);
    expect(spiderWrites.every(([, value]) => /^\d+$/.test(String(value)))).toBe(true);
    expect(mockApi.put).not.toHaveBeenCalled();
    setItem.mockRestore();
  });
});

// ─── #3432: Not active / Active, Activate and Deactivate ─────────────────────
// Mockup M1, "Spider page" and "Activating and deactivating" (Ran, 10 Nov): the page opens while Spider is
// Not active, Save there starts nothing, Activate opens the review with the "When you activate" box and sends
// the chosen starting summary, Deactivate asks first, and someone without Spider's Admin access sees the
// status alone. Its own server: this block's beforeEach replaces the file's fakes.
describe('#3432 activating and deactivating Spider', () => {
  const PREVIEW = '/api/ai-farm/spider/activation-preview';
  const SET_UP = {
    settings: {
      is_active: false,
      activated_at: null,
      status_limits: { NEW: { enabled: true, value: 2, unit: 'HOUR' }, CONTACTED: LIMIT_OFF, WALKTHROUGH_COMPLETED: LIMIT_OFF },
      channels: { in_app: true, red_frame: true, email: false, text: false },
      recipients: { roles: ['ADMIN', 'SALES'], user_ids: [], lead_owner: true },
      updated_at: null,
    },
    options: { statuses: [], units: [], roles: [] },
  };
  /** Never saved: every status off, so Spider cannot be activated yet. */
  const NO_LIMIT = {
    ...SET_UP,
    settings: { ...SET_UP.settings, status_limits: { NEW: LIMIT_OFF, CONTACTED: LIMIT_OFF, WALKTHROUGH_COMPLETED: LIMIT_OFF } },
  };
  /** The pilot company's numbers from 9 Nov, as the mockup draws them. */
  const PREVIEW_BODY = { watchedLeads: 2287, excludedLeads: 13, pastLimitLeads: 1331, summaryRecipients: 17 };

  let actSwitch = { isActive: false, isSetUp: true };
  let actSettings: typeof SET_UP = SET_UP;
  let previewBody: unknown = PREVIEW_BODY;
  /** Every request, in order, as "METHOD url". */
  let calls: string[] = [];

  beforeEach(() => {
    actSwitch = { isActive: false, isSetUp: true };
    actSettings = SET_UP;
    previewBody = PREVIEW_BODY;
    calls = [];
    localStorage.clear();
    vi.clearAllMocks();
    signIn(ADMIN);
    mockApi.get.mockImplementation(async (url: string) => {
      calls.push(`GET ${url}`);
      if (url === SETTINGS) return { data: actSettings };
      if (url === STATUS) return { data: actSwitch };
      if (url === PREVIEW) {
        if (previewBody instanceof Error) throw previewBody;
        return { data: previewBody };
      }
      if (url === OVERVIEW) return { data: { watched: 0, excluded: 0 } };
      if (url === PICKER_CUSTOMERS) return { data: { customers: [], next_cursor: null } };
      if (url === '/api/users') return { data: { users: [] } };
      return { data: {} };
    });
    mockApi.post.mockImplementation(async () => ({ data: {} }));
    mockApi.put.mockImplementation(async (url: string, body?: unknown) => {
      calls.push(`PUT ${url}`);
      if (url === STATUS) {
        actSwitch = { ...actSwitch, isActive: (body as { isActive: boolean }).isActive };
        return { data: actSwitch };
      }
      const sent = body as typeof SET_UP.settings;
      actSettings = { ...actSettings, settings: { ...actSettings.settings, ...sent } };
      return { data: actSettings };
    });
  });

  const statusPuts = () => mockApi.put.mock.calls.filter(([url]) => url === STATUS);
  const header = () => document.querySelector<HTMLElement>('[data-spider-status-actions]')!;

  /** The header's status badge, once it reads `words`. */
  async function badge(words: 'Not active' | 'Active') {
    const chip = await screen.findByText(words, { selector: '[data-spider-status-actions] [data-agent-chip]' });
    return chip;
  }
  async function openActivateReview() {
    fireEvent.click(within(header()).getByRole('button', { name: 'Activate' }));
    const dialog = await screen.findByRole('dialog', { name: 'Confirm Spider Agent Configuration' });
    await within(dialog).findByText(/Spider watches/);
    return dialog;
  }

  describe('the Spider page while Not active', () => {
    it('opens with the settings, the "Not active" badge, its ? and Activate, and no switch', async () => {
      renderWithProviders(<SpiderPage />);
      await openConfig();
      expect(await badge('Not active')).toBeInTheDocument();
      expect(within(header()).getByRole('button', { name: 'About Not active' })).toBeInTheDocument();
      expect(within(header()).getByRole('button', { name: 'Activate' })).toBeEnabled();
      expect(within(header()).queryByRole('button', { name: 'Deactivate' })).toBeNull();
      expect(screen.queryByRole('switch', { name: 'Switch Spider on or off' })).toBeNull();
      // No second line under the status, and no lock.
      expect(document.querySelector('[data-spider-locked]')).toBeNull();
      expect(screen.getByRole('tab', { name: 'Configuration Tab' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'History Tab' })).toBeInTheDocument();
    });

    it('the ? reads the mockup\'s words', async () => {
      renderWithProviders(<SpiderPage />);
      await openConfig();
      await badge('Not active');
      const help = within(header()).getByRole('button', { name: 'About Not active' });
      fireEvent.click(help);
      expect(
        await screen.findByText('Spider watches nothing and sends nothing. Check the settings, then press Activate.'),
      ).toBeInTheDocument();
    });

    it('Save keeps the settings and starts nothing: one PUT /spider/settings, no review, no activation', async () => {
      renderWithProviders(<SpiderPage />);
      await openConfig();
      fireEvent.click(stageSwitch(CONTACTED_ROW));
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      expect(await screen.findByRole('button', { name: 'Saved' })).toBeInTheDocument();
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(settingsPuts()).toHaveLength(1);
      expect(settingsPuts()[0]![1]).not.toHaveProperty('is_active');
      expect(statusPuts()).toHaveLength(0);
      expect(calls).not.toContain(`GET ${PREVIEW}`);
      expect(toast).toHaveBeenCalledWith('Spider Agent Settings Saved', expect.anything());
      expect(within(header()).getByText('Not active')).toBeInTheDocument();
    });

    it('Activate is greyed out with no time limit on, and enabled once one is', async () => {
      actSettings = NO_LIMIT;
      actSwitch = { isActive: false, isSetUp: false };
      renderWithProviders(<SpiderPage />);
      await openConfig();
      await badge('Not active');
      const activate = within(header()).getByRole('button', { name: 'Activate' });
      expect(activate).toBeDisabled();
      fireEvent.click(stageSwitch(NEW_ROW));
      expect(activate).toBeEnabled();
      fireEvent.click(stageSwitch(NEW_ROW));
      expect(activate).toBeDisabled();
      fireEvent.click(activate);
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(statusPuts()).toHaveLength(0);
    });
  });

  describe('Activate', () => {
    it('opens the review with the "When you activate" box from the preview, Send preselected, and the button Activate', async () => {
      renderWithProviders(<SpiderPage />);
      await openConfig();
      await badge('Not active');
      const dialog = await openActivateReview();
      const box = dialog.querySelector<HTMLElement>('[data-spider-activation-box]')!;
      expect(within(box).getByText('When you activate')).toBeInTheDocument();
      expect(box).toHaveTextContent('Spider watches 2,287 open leads and every new lead. 13 are excluded.');
      expect(box).toHaveTextContent('1,331 of them are already past their time limit.');
      const send = within(box).getByRole('radio', { name: /Send one starting summary of them/ });
      const skip = within(box).getByRole('radio', { name: /Skip them/ });
      expect(send).toBeChecked();
      expect(skip).not.toBeChecked();
      expect(within(box).getByText('To 17 people, a few minutes after you activate.')).toBeInTheDocument();
      expect(within(box).getByText('Alert only on leads that pass their time limit from now on.')).toBeInTheDocument();
      // The mockup's title and subtitle, today's four parts, the box on top, and the button says Activate.
      expect(within(dialog).getByText('Review your campaign channels, recipients, stage thresholds, and monitored leads before saving.')).toBeInTheDocument();
      for (const t of ['Monitored Pipeline Targets', 'Active Notification Channels', 'Assigned Alert Recipients', 'Pipeline Stage Thresholds']) {
        expect(within(dialog).getByText(t)).toBeInTheDocument();
      }
      expect(within(dialog).queryByText(/Before You Activate/i)).toBeNull();
      expect(within(dialog).queryByRole('button', { name: 'Active' })).toBeNull();
      expect(within(dialog).queryByRole('button', { name: 'Save' })).toBeNull();
      // Nothing is sent until it is confirmed.
      expect(statusPuts()).toHaveLength(0);
      expect(within(dialog).getByRole('button', { name: 'Activate' })).toBeEnabled();
    });

    it('sends startingSummary "send" by default, then shows Active with Deactivate', async () => {
      renderWithProviders(<SpiderPage />);
      await openConfig();
      await badge('Not active');
      const dialog = await openActivateReview();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Activate' }));
      await waitFor(() => expect(statusPuts()).toHaveLength(1));
      expect(statusPuts()[0]![1]).toEqual({ isActive: true, startingSummary: 'send' });
      expect(await badge('Active')).toBeInTheDocument();
      expect(within(header()).getByRole('button', { name: 'Deactivate' })).toBeInTheDocument();
      expect(within(header()).queryByRole('button', { name: 'Activate' })).toBeNull();
      // Nothing unsaved, so the settings were not saved again.
      expect(settingsPuts()).toHaveLength(0);
    });

    it('sends startingSummary "skip" when Skip them is chosen', async () => {
      renderWithProviders(<SpiderPage />);
      await openConfig();
      await badge('Not active');
      const dialog = await openActivateReview();
      fireEvent.click(within(dialog).getByRole('radio', { name: /Skip them/ }));
      expect(within(dialog).getByRole('radio', { name: /Skip them/ })).toBeChecked();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Activate' }));
      await waitFor(() => expect(statusPuts()).toHaveLength(1));
      expect(statusPuts()[0]![1]).toEqual({ isActive: true, startingSummary: 'skip' });
    });

    it('with unsaved edits saves them first, then reads the review numbers, then activates on confirm', async () => {
      actSettings = NO_LIMIT;
      actSwitch = { isActive: false, isSetUp: false };
      renderWithProviders(<SpiderPage />);
      await openConfig();
      await badge('Not active');
      fireEvent.click(stageSwitch(NEW_ROW));
      const dialog = await openActivateReview();
      const order = calls.filter((c) => c === `PUT ${SETTINGS}` || c === `GET ${PREVIEW}`);
      expect(order).toEqual([`PUT ${SETTINGS}`, `GET ${PREVIEW}`]);
      expect((settingsPuts()[0]![1] as { status_limits: Record<string, unknown> }).status_limits.NEW).toEqual({ enabled: true, value: 1, unit: 'MINUTE' });
      expect(statusPuts()).toHaveLength(0);
      fireEvent.click(within(dialog).getByRole('button', { name: 'Activate' }));
      await waitFor(() => expect(statusPuts()).toHaveLength(1));
      expect(calls.indexOf(`PUT ${STATUS}`)).toBeGreaterThan(calls.indexOf(`PUT ${SETTINGS}`));
    });

    it('a refused activation (409) shows the server\'s sentence and stays Not active', async () => {
      mockApi.put.mockImplementation(async (url: string) => {
        if (url === STATUS) {
          throw Object.assign(new Error('x'), {
            response: { status: 409, data: { error: "Spider's settings changed while you were activating. Check them and activate again." } },
          });
        }
        return { data: actSettings };
      });
      renderWithProviders(<SpiderPage />);
      await openConfig();
      await badge('Not active');
      const dialog = await openActivateReview();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Activate' }));
      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith("Spider's settings changed while you were activating. Check them and activate again."),
      );
      expect(within(header()).getByText('Not active')).toBeInTheDocument();
      expect(within(header()).getByRole('button', { name: 'Activate' })).toBeInTheDocument();
    });

    // Final review M1: each opening waits for its own numbers; the last opening's never stand in for them.
    it('opened again, shows none of the last opening\'s numbers and Activate waits until the fresh ones arrive', async () => {
      renderWithProviders(<SpiderPage />);
      await openConfig();
      await badge('Not active');
      let dialog = await openActivateReview();
      expect(dialog.querySelector('[data-spider-activation-box]')).toHaveTextContent('2,287 open leads');
      fireEvent.keyDown(dialog, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

      let answer!: (body: unknown) => void;
      const base = mockApi.get.getMockImplementation()!;
      mockApi.get.mockImplementation(async (url: string, config?: unknown) =>
        url === PREVIEW ? new Promise((resolve) => { answer = (body) => resolve({ data: body }); }) : base(url, config as never),
      );
      fireEvent.click(within(header()).getByRole('button', { name: 'Activate' }));
      dialog = await screen.findByRole('dialog', { name: 'Confirm Spider Agent Configuration' });
      await waitFor(() => expect(answer).toBeTypeOf('function'));
      expect(within(dialog).queryByText(/2,287/)).toBeNull();
      expect(dialog.querySelector('[data-spider-activation-loading]')).not.toBeNull();
      expect(within(dialog).getByRole('button', { name: 'Activate' })).toBeDisabled();
      await act(async () => answer({ ...PREVIEW_BODY, summaryRecipients: 3 }));
      expect(await within(dialog).findByText('To 3 people, a few minutes after you activate.')).toBeInTheDocument();
      expect(within(dialog).getByRole('button', { name: 'Activate' })).toBeEnabled();
    });

    it('opened again when the numbers cannot be read: the error and Try again, and Activate stays greyed out', async () => {
      renderWithProviders(<SpiderPage />);
      await openConfig();
      await badge('Not active');
      let dialog = await openActivateReview();
      fireEvent.keyDown(dialog, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      previewBody = Object.assign(new Error('x'), { response: { status: 500, data: { error: 'Could not load the Spider review' } } });
      fireEvent.click(within(header()).getByRole('button', { name: 'Activate' }));
      dialog = await screen.findByRole('dialog', { name: 'Confirm Spider Agent Configuration' });
      expect(await within(dialog).findByRole('alert')).toHaveTextContent('Could not load the Spider review');
      expect(within(dialog).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
      expect(within(dialog).queryByText(/Spider watches/)).toBeNull();
      expect(within(dialog).getByRole('button', { name: 'Activate' })).toBeDisabled();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Activate' }));
      expect(statusPuts()).toHaveLength(0);
    });

    // Ran, 10 Nov (final review): a failed Activate with no sentence from the server says what was tried.
    it('a failed Activate with no sentence from the server says "Could not activate Spider. Try again later."', async () => {
      const basePut = mockApi.put.getMockImplementation()!;
      mockApi.put.mockImplementation(async (url: string, body?: unknown) => {
        if (url === STATUS) throw { response: { status: 502, data: {} } };
        return basePut(url, body);
      });
      renderWithProviders(<SpiderPage />);
      await openConfig();
      await badge('Not active');
      const dialog = await openActivateReview();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Activate' }));
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not activate Spider. Try again later.'));
      expect(within(header()).getByText('Not active')).toBeInTheDocument();
    });

    // Ran's sentence whenever the failure carries no sentence from the server: never the HTTP library's English.
    it.each([
      ['a network error', () => Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' })],
      ['a bare 502', () => Object.assign(new Error('Request failed with status code 502'), { response: { status: 502, data: '<html>Bad Gateway</html>' } })],
    ])('a failed Activate on %s says "Could not activate Spider. Try again later."', async (_what, failure) => {
      const basePut = mockApi.put.getMockImplementation()!;
      mockApi.put.mockImplementation(async (url: string, body?: unknown) => {
        if (url === STATUS) throw failure();
        return basePut(url, body);
      });
      renderWithProviders(<SpiderPage />);
      await openConfig();
      await badge('Not active');
      const dialog = await openActivateReview();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Activate' }));
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not activate Spider. Try again later.'));
      expect(toast.error).not.toHaveBeenCalledWith(expect.stringMatching(/Network Error|Request failed/));
    });

    // Final review M3: the settings Activate was reviewed on stay put until it answers.
    it('Save is greyed out while Activate is on its way, and back once it answers', async () => {
      let answer!: () => void;
      const basePut = mockApi.put.getMockImplementation()!;
      mockApi.put.mockImplementation(async (url: string, body?: unknown) => {
        if (url === STATUS) await new Promise<void>((resolve) => { answer = resolve; });
        return basePut(url, body);
      });
      renderWithProviders(<SpiderPage />);
      await openConfig();
      await badge('Not active');
      const dialog = await openActivateReview();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Activate' }));
      await waitFor(() => expect(statusPuts()).toHaveLength(1));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      const saveButton = screen.getByRole('button', { name: 'Save' });
      expect(saveButton).toBeDisabled();
      fireEvent.click(saveButton);
      expect(settingsPuts()).toHaveLength(0);
      await act(async () => answer());
      expect(await badge('Active')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    });

    it('Activate\'s review keeps its own words when something required is missing', async () => {
      actSettings = { ...SET_UP, settings: { ...SET_UP.settings, channels: { in_app: false, red_frame: false, email: false, text: false } } };
      renderWithProviders(<SpiderPage />);
      await openConfig();
      await badge('Not active');
      const dialog = await openActivateReview();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Activate' }));
      expect(within(dialog).getByText('Required Items Missing Before Activation (1)')).toBeInTheDocument();
      expect(within(dialog).getByText('At least one item must be selected from every required section before activating:')).toBeInTheDocument();
      expect(toast.error).toHaveBeenCalledWith('Cannot Activate Spider Agent', expect.anything());
      expect(statusPuts()).toHaveLength(0);
    });

    it('claims no numbers when the review cannot be read: the error, Try again, and Activate waits', async () => {
      previewBody = Object.assign(new Error('x'), { response: { status: 500, data: { error: 'Could not load the Spider review' } } });
      renderWithProviders(<SpiderPage />);
      await openConfig();
      await badge('Not active');
      fireEvent.click(within(header()).getByRole('button', { name: 'Activate' }));
      const dialog = await screen.findByRole('dialog', { name: 'Confirm Spider Agent Configuration' });
      expect(await within(dialog).findByRole('alert')).toHaveTextContent('Could not load the Spider review');
      expect(within(dialog).queryByText(/Spider watches/)).toBeNull();
      expect(within(dialog).getByRole('button', { name: 'Activate' })).toBeDisabled();
      previewBody = PREVIEW_BODY;
      fireEvent.click(within(dialog).getByRole('button', { name: 'Try again' }));
      expect(await within(dialog).findByText(/Spider watches/)).toBeInTheDocument();
      expect(within(dialog).getByRole('button', { name: 'Activate' })).toBeEnabled();
    });
  });

  describe('the Spider page while Active', () => {
    beforeEach(() => {
      actSwitch = { isActive: true, isSetUp: true };
      actSettings = { ...SET_UP, settings: { ...SET_UP.settings, is_active: true } };
    });

    it('Save opens the review titled as the mockup draws it, without the starting box, with a Save button, and saves the settings only', async () => {
      renderWithProviders(<SpiderPage />);
      await openConfig();
      await badge('Active');
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      const dialog = await screen.findByRole('dialog', { name: 'Confirm Spider Agent Configuration' });
      expect(dialog.querySelector('[data-spider-activation-box]')).toBeNull();
      expect(within(dialog).queryByText('When you activate')).toBeNull();
      expect(within(dialog).getByText('Review your campaign channels, recipients, stage thresholds, and monitored leads before saving.')).toBeInTheDocument();
      for (const t of ['Monitored Pipeline Targets', 'Active Notification Channels', 'Assigned Alert Recipients', 'Pipeline Stage Thresholds']) {
        expect(within(dialog).getByText(t)).toBeInTheDocument();
      }
      expect(within(dialog).queryByText(/Before You Activate/i)).toBeNull();
      expect(within(dialog).queryByRole('button', { name: 'Active' })).toBeNull();
      expect(within(dialog).queryByRole('button', { name: 'Activate' })).toBeNull();
      expect(settingsPuts()).toHaveLength(0);
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(settingsPuts()).toHaveLength(1));
      expect(statusPuts()).toHaveLength(0);
      expect(calls).not.toContain(`GET ${PREVIEW}`);
    });

    it('Deactivate asks first with the mockup\'s words; Keep it active sends nothing', async () => {
      renderWithProviders(<SpiderPage />);
      await openConfig();
      await badge('Active');
      expect(within(header()).queryByRole('button', { name: 'About Not active' })).toBeNull();
      fireEvent.click(within(header()).getByRole('button', { name: 'Deactivate' }));
      const confirm = await screen.findByRole('alertdialog', { name: 'Deactivate Spider?' });
      expect(confirm).toHaveTextContent(
        'Spider stops watching your leads and sends no new alerts. Any open Spider alerts are cleared for everyone, and Spider History keeps a record of them.',
      );
      expect(confirm).toHaveTextContent(
        'Your statuses, time limits and who gets alerted are all kept. When you activate it again, the review asks whether to send one summary of the leads still past their time limit.',
      );
      fireEvent.click(within(confirm).getByRole('button', { name: 'Keep it active' }));
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
      expect(statusPuts()).toHaveLength(0);
      expect(within(header()).getByText('Active')).toBeInTheDocument();
    });

    it('a failed Deactivate with no sentence from the server says "Could not deactivate Spider. Try again later."', async () => {
      const basePut = mockApi.put.getMockImplementation()!;
      mockApi.put.mockImplementation(async (url: string, body?: unknown) => {
        if (url === STATUS) throw { response: { status: 502, data: {} } };
        return basePut(url, body);
      });
      renderWithProviders(<SpiderPage />);
      await openConfig();
      await badge('Active');
      fireEvent.click(within(header()).getByRole('button', { name: 'Deactivate' }));
      const confirm = await screen.findByRole('alertdialog', { name: 'Deactivate Spider?' });
      fireEvent.click(within(confirm).getByRole('button', { name: 'Deactivate' }));
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not deactivate Spider. Try again later.'));
      expect(await badge('Active')).toBeInTheDocument();
    });

    it.each([
      ['a network error', () => Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' })],
      ['a bare 502', () => Object.assign(new Error('Request failed with status code 502'), { response: { status: 502, data: '<html>Bad Gateway</html>' } })],
    ])('a failed Deactivate on %s says "Could not deactivate Spider. Try again later."', async (_what, failure) => {
      const basePut = mockApi.put.getMockImplementation()!;
      mockApi.put.mockImplementation(async (url: string, body?: unknown) => {
        if (url === STATUS) throw failure();
        return basePut(url, body);
      });
      renderWithProviders(<SpiderPage />);
      await openConfig();
      await badge('Active');
      fireEvent.click(within(header()).getByRole('button', { name: 'Deactivate' }));
      const confirm = await screen.findByRole('alertdialog', { name: 'Deactivate Spider?' });
      fireEvent.click(within(confirm).getByRole('button', { name: 'Deactivate' }));
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not deactivate Spider. Try again later.'));
      expect(toast.error).not.toHaveBeenCalledWith(expect.stringMatching(/Network Error|Request failed/));
    });

    it('Deactivate works at once and keeps the page, the settings and unsaved edits', async () => {
      renderWithProviders(<SpiderPage />);
      await openConfig();
      await badge('Active');
      fireEvent.click(stageSwitch(CONTACTED_ROW));
      fireEvent.click(within(header()).getByRole('button', { name: 'Deactivate' }));
      const confirm = await screen.findByRole('alertdialog', { name: 'Deactivate Spider?' });
      fireEvent.click(within(confirm).getByRole('button', { name: 'Deactivate' }));
      expect(await badge('Not active')).toBeInTheDocument();
      expect(statusPuts()[0]![1]).toEqual({ isActive: false });
      expect(screen.getByText('Configuration & Alert Rules')).toBeInTheDocument();
      expect(stageSwitch(CONTACTED_ROW)).toBeChecked();
      expect(within(header()).getByRole('button', { name: 'Activate' })).toBeInTheDocument();
      expect(settingsPuts()).toHaveLength(0);
    });
  });

  describe('someone without Spider\'s Admin access', () => {
    it.each([
      ['Not active', { isActive: false, isSetUp: true }],
      ['Active', { isActive: true, isSetUp: true }],
    ] as const)('sees "%s" without Activate, Deactivate or the ?', async (words, sw) => {
      actSwitch = sw;
      signIn({ ...ADMIN, role: 'SALES', is_admin: false });
      renderWithProviders(<SpiderPage />);
      expect(await badge(words)).toBeInTheDocument();
      for (const name of ['Activate', 'Deactivate', 'About Not active']) {
        expect(within(header()).queryByRole('button', { name })).toBeNull();
      }
    });
  });

  describe('ways in while Not active', () => {
    it('the Spider route opens the page for an Admin of a company with Spider', async () => {
      renderWithProviders(
        <Routes>
          <Route element={<RequireSpider />}>
            <Route path="/spider" element={<SpiderPage />} />
          </Route>
          <Route path="/" element={<div>Dashboard</div>} />
        </Routes>,
        { initialEntries: ['/spider'] },
      );
      await openConfig();
      expect(await badge('Not active')).toBeInTheDocument();
      expect(screen.queryByText('Dashboard')).toBeNull();
    });

    it('the AI Agentic Farm pop-up\'s page button is not locked and opens the page', async () => {
      useAiCenterStore.setState({ open: true, focusAgentId: 'spider' });
      renderWithProviders(
        <Routes>
          <Route path="/" element={<AiCenterModal />} />
          <Route path="/spider" element={<div>Spider page</div>} />
        </Routes>,
      );
      const dialog = await screen.findByRole('dialog', { name: 'Spider' });
      const open = await within(dialog).findByRole('button', { name: 'Set up Spider' });
      expect(open).not.toHaveAttribute('aria-disabled');
      expect(dialog.querySelector('[data-agent-locked]')).toBeNull();
      fireEvent.click(open);
      expect(await screen.findByText('Spider page')).toBeInTheDocument();
    });
  });

  describe('no vendor names', () => {
    const VENDORS = /CTM|CallTrackingMetrics|Supabase|Render\b|Twilio|Resend|Stripe|Vercel|OpenAI|Anthropic/;

    it('in the page, the Activate review or the Deactivate question', async () => {
      renderWithProviders(<SpiderPage />);
      await openConfig();
      await badge('Not active');
      expect(document.body.textContent).not.toMatch(VENDORS);
      const dialog = await openActivateReview();
      expect(dialog.textContent).not.toMatch(VENDORS);
      fireEvent.click(within(dialog).getByRole('button', { name: 'Activate' }));
      await badge('Active');
      fireEvent.click(within(header()).getByRole('button', { name: 'Deactivate' }));
      const confirm = await screen.findByRole('alertdialog', { name: 'Deactivate Spider?' });
      expect(confirm.textContent).not.toMatch(VENDORS);
    });
  });
});
