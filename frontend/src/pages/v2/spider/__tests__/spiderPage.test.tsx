/**
 * Spider (#2619) - the Spider page as the contractor built it (Ran, 15 Oct: S1 of "bring Umer's
 * sandbox build over exactly"): his header, Configuration | History tabs, the Configuration & Alert
 * Rules card and his save review, with OUR on/off switch in the header (D1). Also its route guard
 * and the AI Center's Spider pop-up. The API is faked at axios.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
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
const LEADS = '/api/leads';
const CUSTOMERS = '/api/customers';

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
    watch_all_leads: true,
    selected_lead_ids: ['lead-new'],
    updated_at: null,
  },
  selected_leads: [{ id: 'lead-new', lead_number: 'L00042', customer_name: 'Pat Payer' }],
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
    watch_all_leads: true,
    selected_lead_ids: [],
  },
  selected_leads: [],
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

const PAT = { id: 'cust-pat', first_name: 'Pat', last_name: 'Payer', company_name: 'Payer Homes', email: 'pat@example.test' };
const LEAD_BASE = {
  customer_id: PAT.id,
  customer: PAT,
  service_request: 'Fix the door',
  contacted_at: null,
  walkthrough_first_booked_at: null,
  last_visit_completed_at: null,
  first_estimate_sent_at: null,
  won_at: null,
  lost_at: null,
  cancelled_at: null,
  commission_owner: null,
};
const LEADS_BODY = [
  // New, created 3 days ago, selected: past its 2-hour limit.
  { ...LEAD_BASE, id: 'lead-new', lead_number: 'L00042', status: 'NEW', created_at: ago(3 * DAY),
    service_location: { address_line1: '1 Test Way', address_line2: null, city: 'Testville', state: 'MA', zip: '02108' },
    commission_owner: { id: 'u2', first_name: 'Rita', last_name: 'Rep' } },
  // Contacted 5 hours ago.
  { ...LEAD_BASE, id: 'lead-contacted', lead_number: 'L00043', status: 'CONTACTED', created_at: ago(2 * DAY), contacted_at: ago(5 * HOUR) },
  // Not in any of his three stages: never listed.
  { ...LEAD_BASE, id: 'lead-won', lead_number: 'L00044', status: 'WON', created_at: ago(9 * DAY), won_at: ago(DAY) },
  { ...LEAD_BASE, id: 'lead-estimate', lead_number: 'L00045', status: 'ESTIMATED', created_at: ago(9 * DAY), contacted_at: ago(8 * DAY), first_estimate_sent_at: ago(DAY) },
  { ...LEAD_BASE, id: 'lead-booked', lead_number: 'L00046', status: 'WALKTHROUGH_SCHEDULED', created_at: ago(9 * DAY), contacted_at: ago(8 * DAY), walkthrough_first_booked_at: ago(7 * DAY) },
];
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
const LOCKED_LINE = 'Turn it on to change its settings or see its history.';

beforeEach(() => {
  spiderSwitch = { isActive: true, isSetUp: true };
  settingsBody = SETTINGS_BODY;
  summaryBody = { total: 26, new_since: 4 };
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
    if (url === LEADS) return { data: { leads: LEADS_BODY } };
    if (url === CUSTOMERS) return { data: { customers: [{ ...PAT, service_locations: [] }] } };
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
  fireEvent.click(within(dialog).getByRole('button', { name: 'Active' }));
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

  it("shows his defaults for a company that never saved: every channel, all four roles and the owner, auto-select on, every stage off", async () => {
    settingsBody = DEFAULT_SETTINGS_BODY;
    renderWithProviders(<SpiderPage />);
    await openConfig();
    for (const c of ['Email', 'SMS', 'In-app Message', 'Red Frame']) expect(channelBox(c)).toBeChecked();
    expect(screen.getByText('4/4 selected')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select all System roles' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Notify Lead Owner' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Auto-select new leads created during active Spider session' })).toBeChecked();
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
  it('has no on/off switch of its own; Save opens his review, and confirming saves the settings only, then says Saved', async () => {
    renderWithProviders(<SpiderPage />);
    await openConfig();
    expect(screen.getAllByRole('switch', SWITCH)).toHaveLength(1);
    fireEvent.click(channelBox('Email'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const dialog = await screen.findByRole('dialog', { name: 'Confirm Spider Agent Configuration' });
    expect(within(dialog).getByText('Before You Activate')).toBeInTheDocument();
    for (const t of ['Monitored Pipeline Targets', 'Active Notification Channels', 'Assigned Alert Recipients', 'Pipeline Stage Thresholds']) {
      expect(within(dialog).getByText(t)).toBeInTheDocument();
    }
    expect(within(dialog).getByText('Auto-Enrolled')).toBeInTheDocument();
    expect(within(dialog).getByText('2 Roles Selected')).toBeInTheDocument();
    expect(within(dialog).getByText('2 Hours')).toBeInTheDocument();
    expect(within(dialog).getAllByText('Disabled').length).toBeGreaterThanOrEqual(2);
    // Nothing is sent until the review is confirmed.
    expect(settingsPuts()).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Active' }));

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
      watch_all_leads: true,
      selected_lead_ids: ['lead-new'],
    });
    expect(mockApi.put.mock.calls.filter(([u]) => u === STATUS)).toHaveLength(0);
    expect(toast).toHaveBeenCalledWith('Spider Agent Settings Saved', expect.objectContaining({
      description: 'Notification preferences, assignments, stage thresholds, and lead watchers have been successfully applied.',
    }));
  });

  it("counts in the review only the selected leads it can name", async () => {
    settingsBody = {
      ...SETTINGS_BODY,
      settings: { ...SETTINGS_BODY.settings, watch_all_leads: false, selected_lead_ids: ['lead-new', 'lead-gone'] },
      selected_leads: [{ id: 'lead-new', lead_number: 'L00042', customer_name: 'Pat Payer' }],
    };
    renderWithProviders(<SpiderPage />);
    await openConfig();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const dialog = await screen.findByRole('dialog', { name: 'Confirm Spider Agent Configuration' });
    expect(within(dialog).getByText('Monitoring 1 lead across 1 customer account.')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByText('1 Leads Selected'));
    expect(within(dialog).getAllByText('L00042')).toHaveLength(1);
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
  it('refuses to save with nothing chosen: his callout with his three rules and the "Cannot Activate Spider Agent" toast', async () => {
    settingsBody = EMPTY_SETTINGS_BODY;
    renderWithProviders(<SpiderPage />);
    await openConfig();
    const dialog = await saveAndConfirm();
    expect(within(dialog).getByText('Required Items Missing Before Activation (3)')).toBeInTheDocument();
    expect(within(dialog).getByText('At least one item must be selected from every required section before activating:')).toBeInTheDocument();
    for (const rule of [
      'Please select at least one Notification Channel (Email, SMS, In-App, or Red Frame).',
      'Please assign at least one recipient (Admin Roles, Lead Owner, or Specific Users).',
      'Please set at least one stage duration threshold greater than 0.',
    ]) {
      expect(within(dialog).getByText(rule)).toBeInTheDocument();
    }
    expect(toast.error).toHaveBeenCalledWith('Cannot Activate Spider Agent', expect.anything());
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
    expect(within(dialog).getByText('Required Items Missing Before Activation (1)')).toBeInTheDocument();
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

  it('locks the page when Spider was switched off meanwhile', async () => {
    renderWithProviders(<SpiderPage />);
    await openConfig();
    spiderSwitch = { ...spiderSwitch, isActive: false };
    mockApi.put.mockRejectedValue(
      Object.assign(new Error('x'), { response: { status: 409, data: { error: 'Spider is off. Turn it on to change its settings.' } } }),
    );
    await saveAndConfirm();
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Failed to Save Settings', expect.objectContaining({
        description: 'Spider is off. Turn it on to change its settings.',
      })),
    );
    expect(await screen.findByText(LOCKED_LINE)).toBeInTheDocument();
    expect(screen.queryByText(HEADING)).toBeNull();
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

describe('Select Contacts for Alert', () => {
  async function expandPat() {
    await openConfig();
    fireEvent.click(await screen.findByRole('button', { name: 'Toggle leads for Pat Payer' }));
  }

  it('reads leads and customers as he did, and lists only leads in his three stages, by customer', async () => {
    renderWithProviders(<SpiderPage />);
    await expandPat();
    expect(mockApi.get).toHaveBeenCalledWith(LEADS, expect.objectContaining({ params: { page: 1, limit: 100 } }));
    expect(mockApi.get).toHaveBeenCalledWith(CUSTOMERS, expect.objectContaining({ params: { page: 1, limit: 100 } }));
    expect(screen.getByText('2 leads')).toBeInTheDocument();
    expect(screen.getByText('Leads for Pat Payer')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Lead Overview for L00042' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Lead Overview for L00043' })).toBeInTheDocument();
    // Won, an estimate sent, and a booked walkthrough: in none of his three stages.
    for (const n of ['L00044', 'L00045', 'L00046']) expect(screen.queryByText(n)).toBeNull();
  });

  it('shows time in stage, Last Comm, the stage, the overdue flag, the address and the owner, with his maths', async () => {
    renderWithProviders(<SpiderPage />);
    await expandPat();
    const newRow = screen.getByRole('button', { name: 'Open Lead Overview for L00042' }).closest('.rounded-md') as HTMLElement;
    expect(within(newRow).getByText('3 Days in stage')).toBeInTheDocument();
    expect(within(newRow).getByText('New')).toBeInTheDocument();
    // Selected, and 3 days in New against a 2-hour limit.
    expect(within(newRow).getByText('Alert: Overdue')).toBeInTheDocument();
    expect(within(newRow).getByText('1 Test Way, Testville, MA 02108')).toBeInTheDocument();
    expect(within(newRow).getByText('Rita Rep')).toBeInTheDocument();
    expect(within(newRow).queryByText(/Last Comm/)).toBeNull();
    expect(screen.getByText(/1 alert$/)).toBeInTheDocument();

    const contactedRow = screen.getByRole('button', { name: 'Open Lead Overview for L00043' }).closest('.rounded-md') as HTMLElement;
    expect(within(contactedRow).getByText('5 Hours in stage')).toBeInTheDocument();
    expect(within(contactedRow).getByText('· Last Comm: 5 hours ago')).toBeInTheDocument();
    expect(within(contactedRow).getByText('Contacted')).toBeInTheDocument();
    // Not selected: no alert, even though Contacted has no limit anyway.
    expect(within(contactedRow).queryByText('Alert: Overdue')).toBeNull();
  });

  const leadBox = (n: string) => screen.getByRole('checkbox', { name: `Select lead ${n} for notifications` });
  const autoBox = () => screen.getByRole('checkbox', { name: 'Auto-select new leads created during active Spider session' });
  const patBox = () => screen.getByRole('checkbox', { name: 'Select customer Pat Payer for watcher' });
  async function savedBody() {
    await saveAndConfirm();
    await waitFor(() => expect(settingsPuts()).toHaveLength(1));
    return settingsPuts()[0]![1] as { watch_all_leads: boolean; selected_lead_ids: string[] };
  }

  // "Auto-select new leads" is the server's watch-all flag: the ticks show what the server watches.
  it('ticks every listed lead and customer, with "Deselect all", while Auto-select new leads is on', async () => {
    renderWithProviders(<SpiderPage />);
    await expandPat();
    expect(autoBox()).toBeChecked();
    expect(leadBox('L00042')).toBeChecked();
    expect(leadBox('L00043')).toBeChecked();
    expect(patBox()).toBeChecked();
    expect(screen.getByText('Deselect all')).toBeInTheDocument();
    expect(screen.queryByText('Select all')).toBeNull();
  });

  it('ticks only the saved leads, with "Select all", while it is off', async () => {
    settingsBody = { ...SETTINGS_BODY, settings: { ...SETTINGS_BODY.settings, watch_all_leads: false } };
    renderWithProviders(<SpiderPage />);
    await expandPat();
    expect(autoBox()).not.toBeChecked();
    expect(leadBox('L00042')).toBeChecked();
    expect(leadBox('L00043')).not.toBeChecked();
    expect(screen.getByText('Select all')).toBeInTheDocument();
  });

  it('unticking a lead while auto-select is on turns it off and keeps every other listed lead selected', async () => {
    renderWithProviders(<SpiderPage />);
    await expandPat();
    fireEvent.click(leadBox('L00043'));
    expect(autoBox()).not.toBeChecked();
    expect(leadBox('L00042')).toBeChecked();
    expect(leadBox('L00043')).not.toBeChecked();
    expect(screen.getByText('Select all')).toBeInTheDocument();
    expect(await savedBody()).toMatchObject({ watch_all_leads: false, selected_lead_ids: ['lead-new'] });
  });

  it('"Deselect all" while auto-select is on turns it off and selects none', async () => {
    renderWithProviders(<SpiderPage />);
    await expandPat();
    fireEvent.click(screen.getByText('Deselect all'));
    expect(autoBox()).not.toBeChecked();
    expect(leadBox('L00042')).not.toBeChecked();
    expect(leadBox('L00043')).not.toBeChecked();
    expect(patBox()).not.toBeChecked();
    expect(await savedBody()).toMatchObject({ watch_all_leads: false, selected_lead_ids: [] });
  });

  it('ticking Auto-select again ticks everything, and saves the watch-all flag', async () => {
    renderWithProviders(<SpiderPage />);
    await expandPat();
    fireEvent.click(screen.getByText('Deselect all'));
    expect(leadBox('L00042')).not.toBeChecked();
    fireEvent.click(autoBox());
    expect(autoBox()).toBeChecked();
    expect(leadBox('L00042')).toBeChecked();
    expect(leadBox('L00043')).toBeChecked();
    expect(screen.getByText('Deselect all')).toBeInTheDocument();
    expect((await savedBody()).watch_all_leads).toBe(true);
  });

  // The ticks are saved as the leads Spider watches, so the list holds every lead, not one page.
  it('reads every page of leads, so unticking one with auto-select on keeps all 130 others watched', async () => {
    const many = Array.from({ length: 131 }, (_, i) => ({
      ...LEAD_BASE, id: `lead-${i}`, lead_number: `M${String(i).padStart(4, '0')}`, status: 'NEW', created_at: ago(DAY),
    }));
    const base = mockApi.get.getMockImplementation()!;
    mockApi.get.mockImplementation(async (url: string, config?: { params?: unknown }) => {
      if (url === LEADS) {
        const page = (config?.params as { page?: number } | undefined)?.page ?? 1;
        return { data: { leads: many.slice((page - 1) * 100, page * 100), pagination: { page, limit: 100, total: 131, totalPages: 2 } } };
      }
      if (url === CUSTOMERS) {
        return { data: { customers: [{ ...PAT, service_locations: [] }], pagination: { page: 1, limit: 100, total: 1, totalPages: 1 } } };
      }
      return base(url, config as never);
    });
    renderWithProviders(<SpiderPage />);
    await openConfig();
    expect(await screen.findByText('131 leads')).toBeInTheDocument();
    expect(mockApi.get).toHaveBeenCalledWith(LEADS, expect.objectContaining({ params: { page: 2, limit: 100 } }));
    // Label queries, not role queries: a role query over 131 rows is slow on a loaded machine.
    fireEvent.click(screen.getByLabelText('Toggle leads for Pat Payer'));
    // A lead from the second page.
    fireEvent.click(screen.getByLabelText('Select lead M0120 for notifications'));
    expect(screen.getByLabelText('Auto-select new leads created during active Spider session')).not.toBeChecked();
    fireEvent.click(screen.getByText('Save').closest('button')!);
    fireEvent.click((await screen.findByText('Active', { selector: 'button' })));
    await waitFor(() => expect(settingsPuts()).toHaveLength(1));
    const sent = settingsPuts()[0]![1] as { watch_all_leads: boolean; selected_lead_ids: string[] };
    expect(sent.watch_all_leads).toBe(false);
    expect(sent.selected_lead_ids).toHaveLength(130);
    expect(sent.selected_lead_ids).not.toContain('lead-120');
    expect(sent.selected_lead_ids).toEqual(expect.arrayContaining(['lead-0', 'lead-99', 'lead-100', 'lead-130']));
  }, 60_000);

  it('reads the lists again after a save, and never on its own', async () => {
    renderWithProviders(<SpiderPage />);
    await openConfig();
    await waitFor(() => expect(readsOf(LEADS)).toBe(1));
    await saveAndConfirm();
    await waitFor(() => expect(readsOf(LEADS)).toBe(2));
    expect(readsOf(CUSTOMERS)).toBe(2);
  });

  it('shows his loading, empty and error states', async () => {
    mockApi.get.mockImplementation(async (url: string) => {
      if (url === SETTINGS) return { data: settingsBody };
      if (url === STATUS) return { data: spiderSwitch };
      if (url === LEADS) throw new Error('down');
      if (url === CUSTOMERS) return { data: { customers: [] } };
      return { data: { users: [] } };
    });
    renderWithProviders(<SpiderPage />);
    expect(await screen.findByText('Failed to load contacts and leads')).toBeInTheDocument();
    expect(screen.getByText('Failed to load leads from database.')).toBeInTheDocument();
  });
});

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

  it("with no alerts at all shows his healthy state, naming the leads the save review counts", async () => {
    const base = mockApi.get.getMockImplementation()!;
    mockApi.get.mockImplementation(async (url: string, config?: unknown) =>
      url === HISTORY ? { data: { items: [], page: 1, page_size: 25, total: 0, total_pages: 1 } } : base(url, config as never),
    );
    renderWithProviders(<SpiderPage />);
    fireEvent.click(await screen.findByRole('tab', HISTORY_TAB));
    expect(await screen.findByText('All Monitored Stage Leads are Healthy')).toBeInTheDocument();
    // Auto-select is on, so every listed lead in one of his three stages: L00042 and L00043.
    expect(screen.getByText(/Spider is actively monitoring 2 lead targets in the background\./)).toBeInTheDocument();
  });

  it('with a saved selection, counts only the selected leads, as the save review does', async () => {
    settingsBody = { ...SETTINGS_BODY, settings: { ...SETTINGS_BODY.settings, watch_all_leads: false, selected_lead_ids: ['lead-new'] } };
    const base = mockApi.get.getMockImplementation()!;
    mockApi.get.mockImplementation(async (url: string, config?: unknown) =>
      url === HISTORY ? { data: { items: [], page: 1, page_size: 25, total: 0, total_pages: 1 } } : base(url, config as never),
    );
    renderWithProviders(<SpiderPage />);
    await openConfig();
    fireEvent.click(screen.getByRole('tab', HISTORY_TAB));
    expect(await screen.findByText(/Spider is actively monitoring 1 lead targets in the background\./)).toBeInTheDocument();
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
  it('has his back button, header card and tabs, with our switch on the right (D1)', async () => {
    renderWithProviders(<SpiderPage />);
    await openConfig();
    expect(screen.getByRole('heading', { name: 'Spider' })).toBeInTheDocument();
    expect(screen.getByText('AI Lead Manager')).toBeInTheDocument();
    expect(screen.getByText('New', { selector: 'span.uppercase' })).toBeInTheDocument();
    expect(screen.getByText('Proactively monitor pipeline progression, prevent lead stagnation, and trigger automated multi-channel escalation alerts.')).toBeInTheDocument();
    expect(screen.getByRole('tab', CONFIG_TAB)).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', HISTORY_TAB)).toBeInTheDocument();
    expect(screen.getByText('Make sure to save changes before leaving the page.')).toBeInTheDocument();
    // His Active / Deactivated control is replaced by our switch.
    expect(screen.queryByRole('button', { name: 'Spider Status' })).toBeNull();
    expect(screen.queryByText('Deactivated')).toBeNull();
    expect(screen.getByRole('switch', SWITCH)).toBeChecked();
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

  // The catalog's Spider card shows the switch too, so the one Spider request is its status:
  // never the Admin-only settings or history, whichever agent is open.
  it('opening a non-Spider agent asks only for the Spider switch, for the Spider card', async () => {
    useAiCenterStore.setState({ focusAgentId: 'mike' });
    renderWithProviders(<AiCenterModal />);
    expect(await screen.findByText('Book a call about Border Collie')).toBeInTheDocument();
    await waitFor(() => expect(spiderCalls()).toBe(1));
    expect(mockApi.get).toHaveBeenCalledWith(STATUS, expect.anything());
  });

  /** The Spider pop-up, once its status has been read. */
  async function spiderDialog(line: string) {
    const dialog = await screen.findByRole('dialog', { name: 'Spider' });
    await within(dialog).findByText(line);
    return dialog;
  }

  it('shows an Admin the switch and "Open Spider" locked while Spider is off, asking only for the status', async () => {
    spiderSwitch = { isActive: false, isSetUp: true };
    useAiCenterStore.setState({ focusAgentId: 'spider' });
    renderWithProviders(<AiCenterModal />);
    const dialog = await spiderDialog('Spider is off');
    expect(within(dialog).getByRole('switch', { name: 'Switch Spider on or off' })).not.toBeChecked();
    expect(within(dialog).getByRole('button', { name: 'Open Spider' })).toHaveAttribute('aria-disabled', 'true');
    expect(within(dialog).queryByRole('link')).toBeNull();
    expect(screen.queryByText('Book a call about Spider')).toBeNull();
    // The only Spider request is the status: never the Admin-only settings or history.
    expect(mockApi.get.mock.calls.filter(([url]) => String(url).includes('/spider/')).map(([url]) => url)).toEqual([STATUS]);
  });

  it('shows the switch on, the words On / Off and never "Active", when Spider is switched on', async () => {
    mockApi.get.mockImplementation(async (url: string) =>
      url === STATUS ? { data: { isActive: true, isSetUp: true } } : { data: {} },
    );
    useAiCenterStore.setState({ focusAgentId: 'spider' });
    renderWithProviders(<AiCenterModal />);
    const dialog = await spiderDialog('Spider is on');
    expect(within(dialog).getByRole('switch', { name: 'Switch Spider on or off' })).toBeChecked();
    expect(screen.queryAllByText(/\bActive\b/)).toHaveLength(0);
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
    const dialog = await spiderDialog('Spider is on');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open Spider' }));
    expect(await screen.findByText('Spider page')).toBeInTheDocument();
    expect(useAiCenterStore.getState().open).toBe(false);
  });

  // One switch, two surfaces: the page and the pop-up show the same control and the same state.
  it('switching Spider on from the Spider page flips the pop-up at once', async () => {
    spiderSwitch = { isActive: false, isSetUp: true };
    useAiCenterStore.setState({ focusAgentId: 'spider' });
    renderWithProviders(
      <>
        <SpiderPage />
        <AiCenterModal />
      </>,
    );
    const dialog = await spiderDialog('Spider is off');
    // The open dialog hides the page behind it from the accessibility tree, so ask for hidden roles.
    const switches = await screen.findAllByRole('switch', { ...SWITCH, hidden: true });
    expect(switches).toHaveLength(2);
    const pageSwitch = switches.find((sw) => !dialog.contains(sw))!;
    fireEvent.click(pageSwitch);
    await waitFor(() => expect(mockApi.put).toHaveBeenCalledWith(STATUS, { isActive: true }, expect.anything()));
    expect(await spiderDialog('Spider is on')).toBeInTheDocument();
    expect(within(dialog).getByRole('switch', SWITCH)).toBeChecked();
  });

  it('unlocks the Spider page in place when Spider is switched on from the pop-up', async () => {
    spiderSwitch = { isActive: false, isSetUp: true };
    useAiCenterStore.setState({ focusAgentId: 'spider' });
    renderWithProviders(
      <>
        <SpiderPage />
        <AiCenterModal />
      </>,
    );
    const dialog = await spiderDialog('Spider is off');
    expect(document.querySelector('[data-spider-locked]')).not.toBeNull();
    expect(readsOf(SETTINGS)).toBe(0);
    fireEvent.click(within(dialog).getByRole('switch', SWITCH));
    await waitFor(() => expect(document.querySelector('[data-spider-locked]')).toBeNull());
    expect(await screen.findByText(HEADING)).toBeInTheDocument();
    await waitFor(() => expect(mockApi.put).toHaveBeenCalledWith(STATUS, { isActive: true }, expect.anything()));
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
    for (const words of ['Spider is on', 'Spider is off', 'Coming soon']) expect(within(dialog).queryByText(words)).toBeNull();
    expect(within(dialog).queryByRole('switch')).toBeNull();
  });

  it('tells a non-Admin how they hear from Spider, with no switch and no button to its page', async () => {
    spiderSwitch = { isActive: false, isSetUp: true };
    signIn({ ...ADMIN, role: 'SALES', is_admin: false });
    useAiCenterStore.setState({ focusAgentId: 'spider' });
    renderWithProviders(<AiCenterModal />);
    const dialog = await spiderDialog('Spider is off');
    expect(within(dialog).getByText('An Admin turns Spider on or off. You will get its alerts once it is on.')).toBeInTheDocument();
    expect(within(dialog).queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open Spider' })).toBeNull();
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

// Ran, 14 Oct, layer 3 (kept by D1): Spider's settings open only while Spider is on. While off the
// page still opens for an Admin, with the same switch as the pop-up, so they can turn it back on.
describe('the Spider page while Spider is off', () => {
  const locked = () => document.querySelector<HTMLElement>('[data-spider-locked]');

  it('shows his header, the working switch and a locked panel, and asks for neither settings nor history', async () => {
    spiderSwitch = { isActive: false, isSetUp: true };
    renderWithProviders(<SpiderPage />);
    const sw = await screen.findByRole('switch', SWITCH);
    expect(screen.getByRole('heading', { name: 'Spider' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'AI Agentic Farm' })).toBeInTheDocument();
    expect(sw).not.toBeChecked();
    expect(sw).not.toHaveAttribute('aria-disabled');
    expect(sw).toHaveAttribute('data-size', 'lg');
    expect(sw).toHaveTextContent('Off');

    const panel = locked()!;
    expect(panel).not.toBeNull();
    expect(within(panel).getByText('Spider is off')).toBeInTheDocument();
    expect(within(panel).getByText(LOCKED_LINE)).toBeInTheDocument();
    expect(panel.querySelector('svg.lucide-lock')).not.toBeNull();

    expect(screen.queryByRole('tab', CONFIG_TAB)).toBeNull();
    expect(screen.queryByRole('tab', HISTORY_TAB)).toBeNull();
    expect(screen.queryByText(HEADING)).toBeNull();
    await new Promise((r) => setTimeout(r, 30));
    expect(readsOf(SETTINGS)).toBe(0);
    expect(readsOf(HISTORY)).toBe(0);
    expect(readsOf(LEADS)).toBe(0);
  });

  it('shows a placeholder, never the lock or the settings, until the switch is read', async () => {
    mockApi.get.mockImplementation((url: string) => (url === STATUS ? new Promise(() => {}) : Promise.resolve({ data: SETTINGS_BODY })));
    renderWithProviders(<SpiderPage />);
    await waitFor(() => expect(readsOf(STATUS)).toBe(1));
    expect(document.querySelector('[data-spider-page-placeholder]')).not.toBeNull();
    expect(document.querySelector('[data-agent-switch="loading"]')).not.toBeNull();
    expect(locked()).toBeNull();
    expect(screen.queryByText(HEADING)).toBeNull();
    expect(screen.queryByRole('switch', SWITCH)).toBeNull();
    expect(readsOf(SETTINGS)).toBe(0);
  });

  it('unlocks in place when turned on: no question, no navigation, and only then the settings are read', async () => {
    spiderSwitch = { isActive: false, isSetUp: true };
    renderWithProviders(
      <Routes>
        <Route path="/spider" element={<SpiderPage />} />
        <Route path="*" element={<div>Somewhere else</div>} />
      </Routes>,
      { initialEntries: ['/spider'] },
    );
    fireEvent.click(await screen.findByRole('switch', SWITCH));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() => expect(mockApi.put).toHaveBeenCalledWith(STATUS, { isActive: true }, expect.anything()));
    expect(await screen.findByText(HEADING)).toBeInTheDocument();
    expect(locked()).toBeNull();
    expect(screen.getByRole('tab', CONFIG_TAB)).toBeInTheDocument();
    expect(readsOf(SETTINGS)).toBeGreaterThan(0);
    expect(screen.queryByText('Somewhere else')).toBeNull();
    // Turning on never saved the settings.
    expect(settingsPuts()).toHaveLength(0);
  });

  it('locks in place when turned off, after asking first when it was set up', async () => {
    renderWithProviders(<SpiderPage />);
    await openConfig();
    fireEvent.click(screen.getByRole('switch', SWITCH));
    const confirm = await screen.findByRole('alertdialog', { name: 'Turn off Spider?' });
    // Nothing is switched until the question is answered.
    expect(mockApi.put).not.toHaveBeenCalled();
    expect(screen.getByText(HEADING)).toBeInTheDocument();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(mockApi.put).toHaveBeenCalledWith(STATUS, { isActive: false }, expect.anything()));
    expect(await screen.findByText(LOCKED_LINE)).toBeInTheDocument();
    expect(screen.queryByText(HEADING)).toBeNull();
    expect(screen.getByRole('heading', { name: 'Spider' })).toBeInTheDocument();
  });

  it('locks straight away, with no question, when turned off before it was ever set up', async () => {
    spiderSwitch = { isActive: true, isSetUp: false };
    renderWithProviders(<SpiderPage />);
    await openConfig();
    fireEvent.click(screen.getByRole('switch', SWITCH));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() => expect(mockApi.put).toHaveBeenCalledWith(STATUS, { isActive: false }, expect.anything()));
    expect(await screen.findByText(LOCKED_LINE)).toBeInTheDocument();
  });

  // Turning off locks the page and drops the draft, so changes not saved yet would go without a
  // word. While there are any, the switch always asks first and says so.
  it('asks first, saying unsaved changes will be lost, when turned off with the form edited, and keeps them on "Keep it on"', async () => {
    renderWithProviders(<SpiderPage />);
    await openConfig();
    fireEvent.click(stageSwitch(NEW_ROW));
    fireEvent.click(screen.getByRole('switch', SWITCH));
    const confirm = await screen.findByRole('alertdialog', { name: 'Turn off Spider?' });
    expect(within(confirm).getByText('The settings changes you have not saved will be lost.')).toBeInTheDocument();
    // Set up, so what is kept is still said.
    expect(within(confirm).getByText(/are all kept/)).toBeInTheDocument();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Keep it on' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(mockApi.put).not.toHaveBeenCalled();
    expect(stageSwitch(NEW_ROW)).not.toBeChecked();
  });

  it('asks first when turned off before it was ever set up, too, while the form holds unsaved changes', async () => {
    spiderSwitch = { isActive: true, isSetUp: false };
    renderWithProviders(<SpiderPage />);
    await openConfig();
    fireEvent.click(stageSwitch(CONTACTED_ROW));
    fireEvent.click(screen.getByRole('switch', SWITCH));
    const confirm = await screen.findByRole('alertdialog', { name: 'Turn off Spider?' });
    expect(within(confirm).getByText('The settings changes you have not saved will be lost.')).toBeInTheDocument();
    // Nothing was saved, so nothing is claimed as kept.
    expect(within(confirm).queryByText(/are all kept/)).toBeNull();
    expect(mockApi.put).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(mockApi.put).toHaveBeenCalledWith(STATUS, { isActive: false }, expect.anything()));
    expect(await screen.findByText(LOCKED_LINE)).toBeInTheDocument();
  });

  it('asks nothing extra once the edits are undone', async () => {
    spiderSwitch = { isActive: true, isSetUp: false };
    renderWithProviders(<SpiderPage />);
    await openConfig();
    fireEvent.click(channelBox('Email'));
    fireEvent.click(channelBox('Email'));
    fireEvent.click(screen.getByRole('switch', SWITCH));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() => expect(mockApi.put).toHaveBeenCalledWith(STATUS, { isActive: false }, expect.anything()));
  });

  it('opens neither History nor Configuration after it locks, even from the History tab', async () => {
    renderWithProviders(<SpiderPage />);
    fireEvent.click(await screen.findByRole('tab', HISTORY_TAB));
    expect(await screen.findByText('L00042')).toBeInTheDocument();
    const historyReads = readsOf(HISTORY);
    const settingsReads = readsOf(SETTINGS);
    fireEvent.click(screen.getByRole('switch', SWITCH));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Turn off' }));
    expect(await screen.findByText(LOCKED_LINE)).toBeInTheDocument();
    expect(screen.queryByText('L00042')).toBeNull();
    await new Promise((r) => setTimeout(r, 30));
    expect(readsOf(HISTORY)).toBe(historyReads);
    expect(readsOf(SETTINGS)).toBe(settingsReads);
  });

  it('claims nothing and opens nothing when the switch cannot be read', async () => {
    mockApi.get.mockImplementation(async (url: string) => {
      if (url === STATUS) throw Object.assign(new Error('x'), { response: { status: 500, data: {} } });
      return { data: SETTINGS_BODY };
    });
    renderWithProviders(<SpiderPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load whether Spider is on.');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(locked()).toBeNull();
    expect(screen.queryByText(HEADING)).toBeNull();
    expect(screen.queryByRole('switch', SWITCH)).toBeNull();
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

  it('asks the unsaved question when Spider is turned off from History with edits pending', async () => {
    renderWithProviders(<SpiderPage />);
    await openConfig();
    fireEvent.click(stageSwitch(NEW_ROW));
    fireEvent.click(screen.getByRole('tab', HISTORY_TAB));
    await screen.findByText('L00042');
    fireEvent.click(screen.getByRole('switch', SWITCH));
    const confirm = await screen.findByRole('alertdialog', { name: 'Turn off Spider?' });
    expect(within(confirm).getByText('The settings changes you have not saved will be lost.')).toBeInTheDocument();
    expect(mockApi.put).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(mockApi.put).toHaveBeenCalledWith(STATUS, { isActive: false }, expect.anything()));
    // Locked: no form, and no draft left behind.
    expect(await screen.findByText(LOCKED_LINE)).toBeInTheDocument();
    expect(screen.queryByText(HEADING)).toBeNull();
  });
});
