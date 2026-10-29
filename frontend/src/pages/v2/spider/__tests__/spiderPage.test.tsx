/**
 * Spider (#2619) - Seam E: the Spider page (Settings and History), its route guard and the AI
 * Center's Spider pop-up, with the API faked at axios.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes, useNavigate } from 'react-router-dom';
import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import { useAuthStore } from '@/stores/auth.store';
import { useAiCenterStore } from '@/stores/aiCenterStore';
import { AiCenterModal } from '@/components/ai-center/AiCenterModal';
import RequireSpider from '@/components/RequireSpider';
import SpiderPage from '../SpiderPage';

const mockApi = vi.mocked(api);
const SETTINGS = '/api/ai-farm/spider/settings';
const HISTORY = '/api/ai-farm/spider/history';
const STATUS = '/api/ai-farm/spider/status';

function signIn(user: Record<string, unknown>) {
  vi.mocked(useAuthStore).mockImplementation(((selector: (s: Record<string, unknown>) => unknown) =>
    selector({ user, isAuthenticated: true })) as never);
}
const ADMIN = { id: 'u1', role: 'ADMIN', organization_id: 'o1', org_is_demo: true, org_features: ['leads', 'spider'] };

const LIMIT_OFF = { enabled: false, value: 1, unit: 'DAY' };
const SETTINGS_BODY = {
  settings: {
    is_active: false,
    activated_at: null,
    status_limits: {
      NEW: { enabled: true, value: 2, unit: 'HOUR' },
      CONTACTED: LIMIT_OFF,
      WALKTHROUGH_SCHEDULED: LIMIT_OFF,
      WALKTHROUGH_COMPLETED: LIMIT_OFF,
      ESTIMATED: LIMIT_OFF,
    },
    channels: { in_app: true, red_frame: true, email: false, text: false },
    recipients: { roles: [], user_ids: [], lead_owner: true },
    watch_all_leads: true,
    selected_lead_ids: [],
    updated_at: null,
  },
  selected_leads: [],
  options: {
    statuses: [
      { value: 'NEW', label: 'New' },
      { value: 'CONTACTED', label: 'Contacted' },
      { value: 'WALKTHROUGH_SCHEDULED', label: 'Walkthrough Scheduled' },
      { value: 'WALKTHROUGH_COMPLETED', label: 'Walkthrough Completed' },
      { value: 'ESTIMATED', label: 'Estimate Sent' },
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

const HISTORY_ROW = {
  id: 'a1',
  lead_id: 'lead-1',
  lead_number: 'L00042',
  customer_name: 'Pat Payer',
  status: 'NEW',
  status_label: 'New',
  entered_status_at: '2026-10-01T09:00:00.000Z',
  alerted_at: '2026-10-01T12:00:00.000Z',
  limit: { value: 2, unit: 'HOUR' },
  channels: { in_app: 'Shown in the app', email: 'Email alerts are switched off', text: 'Text message could not be delivered' },
  recipients: [{ name: 'Rita Rep', email_outcome: null, text_outcome: 'Text message could not be delivered' }],
};

const spiderCalls = () => mockApi.get.mock.calls.filter(([url]) => String(url).includes('/spider/')).length;
const readsOf = (url: string) => mockApi.get.mock.calls.filter(([u]) => u === url).length;

/** The switch the server holds: GET /spider/status reads it, PUT /spider/status moves it. */
let spiderSwitch: { isActive: boolean; isSetUp: boolean } = { isActive: true, isSetUp: true };
const SWITCH = { name: 'Switch Spider on or off' };

beforeEach(() => {
  spiderSwitch = { isActive: true, isSetUp: true };
  vi.clearAllMocks();
  signIn(ADMIN);
  mockApi.get.mockImplementation(async (url: string, config?: { params?: unknown }) => {
    if (url === SETTINGS) return { data: SETTINGS_BODY };
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
    if (url === STATUS) return { data: spiderSwitch };
    if (url === '/api/users') return { data: { users: [] } };
    return { data: {} };
  });
  mockApi.put.mockImplementation(async (url: string, body?: unknown) => {
    if (url === STATUS) {
      spiderSwitch = { ...spiderSwitch, isActive: (body as { isActive: boolean }).isActive };
      return { data: spiderSwitch };
    }
    return { data: SETTINGS_BODY };
  });
});

describe('Spider settings', () => {
  it('load from the server, with the units the server lists', async () => {
    renderWithProviders(<SpiderPage />);
    expect(await screen.findByText('Statuses to watch')).toBeInTheDocument();
    expect(screen.getByLabelText('Time limit for New')).toHaveValue('2');
    expect(screen.getByRole('switch', { name: 'Watch New' })).toBeChecked();
    expect(mockApi.get).toHaveBeenCalledWith(SETTINGS);
  });

  // Ran, 14 Oct: one switch. The form has none of its own, and saving it never changes the switch.
  it('have no on/off switch of their own, and a save never sends is_active', async () => {
    renderWithProviders(<SpiderPage />);
    await screen.findByText('Statuses to watch');
    expect(screen.queryByRole('switch', { name: 'Spider on or off' })).toBeNull();
    expect(screen.getAllByRole('switch', SWITCH)).toHaveLength(1);
    fireEvent.click(screen.getByRole('switch', { name: 'Watch New' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    const [url, sent] = mockApi.put.mock.calls[0]!;
    expect(url).toBe(SETTINGS);
    expect(sent).not.toHaveProperty('is_active');
    expect(Object.values((sent as { status_limits: Record<string, { enabled: boolean }> }).status_limits).some((l) => l.enabled)).toBe(false);
  });

  it('show the server\'s sentence when Spider was switched off meanwhile, and lock the page', async () => {
    renderWithProviders(<SpiderPage />);
    await screen.findByText('Statuses to watch');
    // Another Admin switched Spider off while this form was open.
    spiderSwitch = { ...spiderSwitch, isActive: false };
    mockApi.put.mockRejectedValue(
      Object.assign(new Error('x'), { response: { status: 409, data: { error: 'Spider is off. Turn it on to change its settings.' } } }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/^Spider is off\. Turn it on to change its settings\.$/);
    // The status is read again, so the page locks.
    expect(await screen.findByText('Turn it on to change its settings or see its history.')).toBeInTheDocument();
    expect(screen.queryByText('Statuses to watch')).toBeNull();
  });

  it('show a load error, and no form, when the settings cannot be read', async () => {
    mockApi.get.mockImplementation(async (url: string) => {
      if (url === SETTINGS) throw Object.assign(new Error('x'), { response: { data: { error: 'Could not load Spider settings' } } });
      if (url === STATUS) return { data: spiderSwitch };
      return { data: {} };
    });
    renderWithProviders(<SpiderPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load Spider settings');
    expect(screen.queryByText('Statuses to watch')).toBeNull();
  });

  it('show the save error and never "Saved" when the save fails', async () => {
    mockApi.put.mockRejectedValue(
      Object.assign(new Error('x'), {
        response: { status: 400, data: { error: 'Validation failed', details: [{ field: 'channels.email', message: 'Expected boolean, received string' }] } },
      }),
    );
    renderWithProviders(<SpiderPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Save settings' }));
    // The sentence alone: never the field name the server keyed it to ("channels.email: ...").
    expect(await screen.findByRole('alert')).toHaveTextContent(/^Expected boolean, received string$/);
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('show every problem the server lists as its own sentence, with no field names', async () => {
    mockApi.put.mockRejectedValue(
      Object.assign(new Error('x'), {
        response: {
          status: 400,
          data: {
            error: 'Validation failed',
            details: [
              { field: 'status_limits.NEW.value', message: 'Limit must be greater than zero' },
              { field: 'status_limits.CONTACTED.value', message: 'Limit can be at most one year' },
            ],
          },
        },
      }),
    );
    renderWithProviders(<SpiderPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Save settings' }));
    const alert = await screen.findByRole('alert');
    // A status row's problem is named by that status's own label, never by the field path.
    expect(alert).toHaveTextContent(
      /^New: Limit must be greater than zero\. Contacted: Limit can be at most one year$/,
    );
    expect(alert.textContent).not.toMatch(/status_limits|CONTACTED/);
  });

  it('show the generic sentence, never a field name, when the listed problems carry no words', async () => {
    mockApi.put.mockRejectedValue(
      Object.assign(new Error('x'), {
        response: { status: 400, data: { error: 'Validation failed', details: [{ field: 'is_active', message: '' }] } },
      }),
    );
    renderWithProviders(<SpiderPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Save settings' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/^Could not save Spider settings\.$/);
  });

  it('fall back to the server sentence when it lists no details', async () => {
    mockApi.put.mockRejectedValue(
      Object.assign(new Error('x'), { response: { status: 403, data: { error: 'Only Admins can manage Spider' } } }),
    );
    renderWithProviders(<SpiderPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Save settings' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/^Only Admins can manage Spider$/);
  });

  it('say "Saved" only after the server accepted the save, and send what the form shows', async () => {
    renderWithProviders(<SpiderPage />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Email' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(mockApi.put).toHaveBeenCalledWith(
      SETTINGS,
      expect.objectContaining({ channels: { in_app: true, red_frame: true, email: true, text: false } }),
    );
  });
});

describe('Spider history', () => {
  it('shows rows with outcomes in plain words, and pages', async () => {
    renderWithProviders(<SpiderPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'History' }));
    const row = (await screen.findByText('L00042')).closest('tr')!;
    expect(within(row).getByText('Pat Payer')).toBeInTheDocument();
    expect(within(row).getByText('Shown in the app')).toBeInTheDocument();
    expect(within(row).getAllByText(/Text message could not be delivered/).length).toBeGreaterThan(0);
    expect(within(row).getByText('Rita Rep')).toBeInTheDocument();
    expect(screen.getByText(/Page 1 of 2/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('L00043')).toBeInTheDocument();
    expect(mockApi.get).toHaveBeenCalledWith(HISTORY, { params: { page: 2, page_size: 25 } });
  });

  it('shows an empty state', async () => {
    mockApi.get.mockImplementation(async (url: string) => {
      if (url === HISTORY) return { data: { items: [], page: 1, page_size: 25, total: 0, total_pages: 1 } };
      if (url === SETTINGS) return { data: SETTINGS_BODY };
      if (url === STATUS) return { data: spiderSwitch };
      return { data: { users: [] } };
    });
    renderWithProviders(<SpiderPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'History' }));
    expect(await screen.findByText('No Spider alerts yet')).toBeInTheDocument();
  });

  it('shows a load error', async () => {
    mockApi.get.mockImplementation(async (url: string) => {
      if (url === HISTORY) throw new Error('down');
      if (url === SETTINGS) return { data: SETTINGS_BODY };
      if (url === STATUS) return { data: spiderSwitch };
      return { data: { users: [] } };
    });
    renderWithProviders(<SpiderPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'History' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/down|Could not load Spider history/);
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
  ])('sends a company %s to the dashboard and makes no Spider request', async (_l, user) => {
    signIn(user);
    routed();
    expect(await screen.findByText('Dashboard')).toBeInTheDocument();
    expect(spiderCalls()).toBe(0);
  });

  it('opens for a company with Spider', async () => {
    routed();
    expect(await screen.findByText('Statuses to watch')).toBeInTheDocument();
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
    expect(await screen.findByText('Statuses to watch')).toBeInTheDocument();
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
    signIn({ ...ADMIN, role: 'SALES' });
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

// Ran, 14 Oct, layer 3: Spider's page opens only while Spider is on. While off it still opens for
// an Admin, with the same switch as the pop-up, so they can turn it back on right there.
describe('the Spider page while Spider is off', () => {
  const locked = () => document.querySelector<HTMLElement>('[data-spider-locked]');

  it('shows the header, the working switch and a locked panel, and asks for neither settings nor history', async () => {
    spiderSwitch = { isActive: false, isSetUp: true };
    renderWithProviders(<SpiderPage />);
    const sw = await screen.findByRole('switch', SWITCH);
    expect(screen.getByRole('heading', { name: 'Spider' })).toBeInTheDocument();
    expect(sw).not.toBeChecked();
    expect(sw).not.toHaveAttribute('aria-disabled');
    expect(sw).toHaveAttribute('data-size', 'lg');
    expect(sw).toHaveTextContent('Off');
    expect(sw).toHaveAccessibleDescription('No new lead alerts are going out');
    // The row's status line is the same polite live region as in the pop-up.
    expect(screen.getByRole('status')).toHaveTextContent('Spider is off');

    const panel = locked()!;
    expect(panel).not.toBeNull();
    expect(within(panel).getByText('Spider is off')).toBeInTheDocument();
    expect(within(panel).getByText('Turn it on to change its settings or see its history.')).toBeInTheDocument();
    expect(panel.querySelector('svg.lucide-lock')).not.toBeNull();

    expect(screen.queryByRole('tab', { name: 'Settings' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'History' })).toBeNull();
    expect(screen.queryByText('Statuses to watch')).toBeNull();
    await new Promise((r) => setTimeout(r, 30));
    expect(readsOf(SETTINGS)).toBe(0);
    expect(readsOf(HISTORY)).toBe(0);
  });

  it('shows a placeholder, never the lock or the settings, until the switch is read', async () => {
    mockApi.get.mockImplementation((url: string) => (url === STATUS ? new Promise(() => {}) : Promise.resolve({ data: SETTINGS_BODY })));
    renderWithProviders(<SpiderPage />);
    await waitFor(() => expect(readsOf(STATUS)).toBe(1));
    expect(document.querySelector('[data-spider-page-placeholder]')).not.toBeNull();
    expect(document.querySelector('[data-agent-control-row="loading"]')).not.toBeNull();
    expect(locked()).toBeNull();
    expect(screen.queryByText('Statuses to watch')).toBeNull();
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
    expect(await screen.findByText('Statuses to watch')).toBeInTheDocument();
    expect(locked()).toBeNull();
    expect(screen.getByRole('tab', { name: 'Settings' })).toBeInTheDocument();
    expect(readsOf(SETTINGS)).toBeGreaterThan(0);
    expect(screen.queryByText('Somewhere else')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Spider is on');
  });

  it('locks in place when turned off, after asking first when it was set up', async () => {
    renderWithProviders(<SpiderPage />);
    await screen.findByText('Statuses to watch');
    fireEvent.click(screen.getByRole('switch', SWITCH));
    const confirm = await screen.findByRole('alertdialog', { name: 'Turn off Spider?' });
    // Nothing is switched until the question is answered.
    expect(mockApi.put).not.toHaveBeenCalled();
    expect(screen.getByText('Statuses to watch')).toBeInTheDocument();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(mockApi.put).toHaveBeenCalledWith(STATUS, { isActive: false }, expect.anything()));
    expect(await screen.findByText('Turn it on to change its settings or see its history.')).toBeInTheDocument();
    expect(screen.queryByText('Statuses to watch')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Spider' })).toBeInTheDocument();
  });

  it('locks straight away, with no question, when turned off before it was ever set up', async () => {
    spiderSwitch = { isActive: true, isSetUp: false };
    renderWithProviders(<SpiderPage />);
    await screen.findByText('Statuses to watch');
    expect(screen.getByRole('switch', SWITCH)).toHaveAccessibleDescription('Choose the statuses to watch so it can start');
    fireEvent.click(screen.getByRole('switch', SWITCH));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() => expect(mockApi.put).toHaveBeenCalledWith(STATUS, { isActive: false }, expect.anything()));
    expect(await screen.findByText('Turn it on to change its settings or see its history.')).toBeInTheDocument();
  });

  // Turning off locks the page and unmounts the form, so changes not saved yet would go without a
  // word. While there are any, the switch always asks first and says so.
  it('asks first, saying unsaved changes will be lost, when turned off with the form edited, and keeps them on "Keep it on"', async () => {
    renderWithProviders(<SpiderPage />);
    await screen.findByText('Statuses to watch');
    fireEvent.click(screen.getByRole('switch', { name: 'Watch New' }));
    fireEvent.click(screen.getByRole('switch', SWITCH));
    const confirm = await screen.findByRole('alertdialog', { name: 'Turn off Spider?' });
    expect(within(confirm).getByText('The settings changes you have not saved will be lost.')).toBeInTheDocument();
    // Set up, so what is kept is still said.
    expect(within(confirm).getByText(/are all kept/)).toBeInTheDocument();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Keep it on' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(mockApi.put).not.toHaveBeenCalled();
    expect(screen.getByRole('switch', { name: 'Watch New' })).not.toBeChecked();
  });

  it('asks first when turned off before it was ever set up, too, while the form holds unsaved changes', async () => {
    spiderSwitch = { isActive: true, isSetUp: false };
    renderWithProviders(<SpiderPage />);
    await screen.findByText('Statuses to watch');
    fireEvent.click(screen.getByRole('switch', { name: 'Watch Contacted' }));
    fireEvent.click(screen.getByRole('switch', SWITCH));
    const confirm = await screen.findByRole('alertdialog', { name: 'Turn off Spider?' });
    expect(within(confirm).getByText('The settings changes you have not saved will be lost.')).toBeInTheDocument();
    // Nothing was saved, so nothing is claimed as kept.
    expect(within(confirm).queryByText(/are all kept/)).toBeNull();
    expect(mockApi.put).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(mockApi.put).toHaveBeenCalledWith(STATUS, { isActive: false }, expect.anything()));
    expect(await screen.findByText('Turn it on to change its settings or see its history.')).toBeInTheDocument();
  });

  it('asks nothing extra once the edits are undone', async () => {
    spiderSwitch = { isActive: true, isSetUp: false };
    renderWithProviders(<SpiderPage />);
    await screen.findByText('Statuses to watch');
    fireEvent.click(screen.getByRole('switch', { name: 'Watch Contacted' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Watch Contacted' }));
    fireEvent.click(screen.getByRole('switch', SWITCH));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() => expect(mockApi.put).toHaveBeenCalledWith(STATUS, { isActive: false }, expect.anything()));
  });

  it('opens neither History nor Settings after it locks, even from the History tab', async () => {
    renderWithProviders(<SpiderPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'History' }));
    expect(await screen.findByText('L00042')).toBeInTheDocument();
    const historyReads = readsOf(HISTORY);
    const settingsReads = readsOf(SETTINGS);
    fireEvent.click(screen.getByRole('switch', SWITCH));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Turn off' }));
    expect(await screen.findByText('Turn it on to change its settings or see its history.')).toBeInTheDocument();
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
    expect(screen.queryByText('Statuses to watch')).toBeNull();
    expect(screen.queryByRole('switch', SWITCH)).toBeNull();
    expect(readsOf(SETTINGS)).toBe(0);
  });
});

it('does not ask for History until its tab is opened', async () => {
  renderWithProviders(<SpiderPage />);
  await screen.findByText('Statuses to watch');
  await waitFor(() => expect(mockApi.get.mock.calls.filter(([u]) => u === HISTORY)).toHaveLength(0));
});

// Ran, 14 Oct: "As long as we haven't left the Spider page, the edits should stay intact." The
// Settings form stays mounted, hidden, behind History; the draft lives only in the page's memory.
describe('unsaved Spider settings across the tabs', () => {
  const settingsTab = () => screen.getByRole('tab', { name: /^Settings/ });
  const unsavedDot = () => document.querySelector('[data-spider-unsaved-dot]');
  const watchNew = () => screen.getByRole('switch', { name: 'Watch New' });

  /** The server keeps what it was sent, as the real one does. */
  function echoSaves() {
    mockApi.put.mockImplementation(async (url: string, body?: unknown) => {
      if (url === STATUS) {
        spiderSwitch = { ...spiderSwitch, isActive: (body as { isActive: boolean }).isActive };
        return { data: spiderSwitch };
      }
      return { data: { ...SETTINGS_BODY, settings: { ...SETTINGS_BODY.settings, ...(body as object) } } };
    });
  }

  it('keeps the edits through Settings -> History -> Settings, any number of times', async () => {
    renderWithProviders(<SpiderPage />);
    await screen.findByText('Statuses to watch');
    fireEvent.click(watchNew());
    fireEvent.click(screen.getByRole('switch', { name: 'Email' }));
    fireEvent.change(screen.getByLabelText('Time limit for New'), { target: { value: '7' } });
    expect(watchNew()).not.toBeChecked();

    for (let round = 0; round < 3; round++) {
      fireEvent.click(screen.getByRole('tab', { name: 'History' }));
      expect(await screen.findByText('L00042')).toBeInTheDocument();
      // Hidden while History is open: out of the accessibility tree, so out of the tab order too.
      expect(screen.queryByRole('switch', { name: 'Watch New' })).toBeNull();
      expect(screen.getByText('Statuses to watch').closest('[hidden]')).not.toBeNull();
      fireEvent.click(settingsTab());
      expect(screen.getByText('Statuses to watch').closest('[hidden]')).toBeNull();
      expect(watchNew()).not.toBeChecked();
      expect(screen.getByRole('switch', { name: 'Email' })).toBeChecked();
      expect(screen.getByLabelText('Time limit for New')).toHaveValue('7');
    }
    // Kept in memory only: never sent anywhere until Save.
    expect(mockApi.put).not.toHaveBeenCalled();
  });

  it('marks the Settings tab while its edits are unsaved and History is open, and clears it after a save', async () => {
    echoSaves();
    renderWithProviders(<SpiderPage />);
    await screen.findByText('Statuses to watch');
    // Nothing edited: no mark on either tab.
    fireEvent.click(screen.getByRole('tab', { name: 'History' }));
    expect(screen.getByRole('tab', { name: 'Settings' })).toBeInTheDocument();
    expect(unsavedDot()).toBeNull();
    fireEvent.click(settingsTab());

    fireEvent.click(watchNew());
    // On Settings itself the edits are in view: no mark.
    expect(screen.getByRole('tab', { name: 'Settings' })).toBeInTheDocument();
    expect(unsavedDot()).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'History' }));
    expect(await screen.findByRole('tab', { name: 'Settings, unsaved changes' })).toBeInTheDocument();
    expect(unsavedDot()).not.toBeNull();
    expect(unsavedDot()).toHaveAttribute('aria-hidden', 'true');

    fireEvent.click(settingsTab());
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'History' }));
    expect(screen.getByRole('tab', { name: 'Settings' })).toBeInTheDocument();
    expect(unsavedDot()).toBeNull();
    // The draft is now the saved state.
    fireEvent.click(settingsTab());
    expect(watchNew()).not.toBeChecked();
  });

  it('never lets a background refetch overwrite the edits', async () => {
    const { queryClient } = renderWithProviders(<SpiderPage />);
    await screen.findByText('Statuses to watch');
    fireEvent.click(watchNew());
    // Meanwhile the server's copy changed (another Admin saved): Text is now on.
    mockApi.get.mockImplementation(async (url: string) => {
      if (url === SETTINGS) {
        return { data: { ...SETTINGS_BODY, settings: { ...SETTINGS_BODY.settings, channels: { ...SETTINGS_BODY.settings.channels, text: true } } } };
      }
      if (url === STATUS) return { data: spiderSwitch };
      if (url === HISTORY) return { data: { items: [HISTORY_ROW], page: 1, page_size: 25, total: 1, total_pages: 1 } };
      return { data: { users: [] } };
    });
    const before = readsOf(SETTINGS);
    await queryClient.refetchQueries({ queryKey: ['spider', 'settings'] });
    await waitFor(() => expect(readsOf(SETTINGS)).toBeGreaterThan(before));
    // The draft stands, on this tab and after a trip to History and back.
    expect(watchNew()).not.toBeChecked();
    expect(screen.getByRole('switch', { name: 'Text message' })).not.toBeChecked();
    fireEvent.click(screen.getByRole('tab', { name: 'History' }));
    await queryClient.refetchQueries({ queryKey: ['spider', 'settings'] });
    expect(screen.getByRole('tab', { name: 'Settings, unsaved changes' })).toBeInTheDocument();
    fireEvent.click(settingsTab());
    expect(watchNew()).not.toBeChecked();
  });

  it('takes a refetched copy when there is nothing unsaved', async () => {
    const { queryClient } = renderWithProviders(<SpiderPage />);
    await screen.findByText('Statuses to watch');
    mockApi.get.mockImplementation(async (url: string) => {
      if (url === SETTINGS) {
        return { data: { ...SETTINGS_BODY, settings: { ...SETTINGS_BODY.settings, channels: { ...SETTINGS_BODY.settings.channels, text: true } } } };
      }
      if (url === STATUS) return { data: spiderSwitch };
      return { data: { users: [] } };
    });
    await queryClient.refetchQueries({ queryKey: ['spider', 'settings'] });
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Text message' })).toBeChecked());
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
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
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
    await screen.findByText('Statuses to watch');
    fireEvent.click(watchNew());
    fireEvent.click(screen.getByRole('tab', { name: 'History' }));
    await screen.findByText('L00042');
    fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
    expect(await screen.findByText('Somewhere else')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to Spider' }));
    await screen.findByText('Statuses to watch');
    expect(watchNew()).toBeChecked();
    expect(screen.getByRole('tab', { name: 'Settings' })).toHaveAttribute('aria-selected', 'true');
    // Nothing of the draft was kept in the browser, nor sent to the server.
    expect(setItem.mock.calls.filter(([key]) => /spider/i.test(String(key)))).toEqual([]);
    expect(mockApi.put).not.toHaveBeenCalled();
    setItem.mockRestore();
  });

  it('asks the unsaved question when Spider is turned off from History with edits pending', async () => {
    renderWithProviders(<SpiderPage />);
    await screen.findByText('Statuses to watch');
    fireEvent.click(watchNew());
    fireEvent.click(screen.getByRole('tab', { name: 'History' }));
    await screen.findByText('L00042');
    fireEvent.click(screen.getByRole('switch', SWITCH));
    const confirm = await screen.findByRole('alertdialog', { name: 'Turn off Spider?' });
    expect(within(confirm).getByText('The settings changes you have not saved will be lost.')).toBeInTheDocument();
    expect(mockApi.put).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(mockApi.put).toHaveBeenCalledWith(STATUS, { isActive: false }, expect.anything()));
    // Locked: no form, and no draft left behind.
    expect(await screen.findByText('Turn it on to change its settings or see its history.')).toBeInTheDocument();
    expect(screen.queryByText('Statuses to watch')).toBeNull();
    expect(unsavedDot()).toBeNull();
  });
});
