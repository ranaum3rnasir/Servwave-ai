import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AiCenterModal } from './AiCenterModal';
import { AgentDetailModal } from './AgentDetailModal';
import SpiderWatcherPage from '@/pages/v2/spider/SpiderWatcherPage';
import { AI_AGENTS, AI_AGENT_COUNT } from '@/lib/ai-center/agents';
import { useAiCenterStore } from '@/stores/aiCenterStore';
import {
  useSpiderWatcherStore,
  resolveLeadStageAndElapsedTime,
  isLeadOverdue,
  isLeadInAllowedAlertStage,
  isLeadWalkthroughCompleted,
  formatLeadServiceLocation,
  formatAddressParts,
  buildWatcherCustomersFromLive,
  resolveSpiderAlertRecipients,
  type WatcherCustomer,
} from '@/stores/spiderWatcherStore';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useLocation: () => ({ pathname: '/spider', search: '', hash: '', state: null, key: 'default' }),
  };
});

const getMockSpiderConfig = () => ({
  isActive: useSpiderWatcherStore.getState().isActive,
  autoEnrollAllLeads: useSpiderWatcherStore.getState().autoEnrollAllLeads ?? true,
  selectedLeadIds: useSpiderWatcherStore.getState().selectedLeadIds ?? [],
  stageThresholds: {},
  notifications: useSpiderWatcherStore.getState().notifications,
  assignments: useSpiderWatcherStore.getState().assignments,
});

vi.mock('@/lib/api', () => ({
  default: {
    get: vi.fn((url: string) => {
      if (typeof url === 'string' && url.includes('/api/ai-farm/spider/config')) {
        return Promise.resolve({ data: { ok: true, config: getMockSpiderConfig() } });
      }
      if (typeof url === 'string' && url.includes('/api/ai-farm/spider/logs')) {
        return Promise.resolve({ data: { ok: true, records: [], total: 0 } });
      }
      return Promise.resolve({ data: {} });
    }),
    post: vi.fn().mockResolvedValue({ data: { ok: true } }),
    put: vi.fn((url: string, body: any) => {
      if (typeof url === 'string' && url.includes('/api/ai-farm/spider/config')) {
        return Promise.resolve({
          data: {
            ok: true,
            config: {
              ...getMockSpiderConfig(),
              ...(body || {}),
            },
          },
        });
      }
      return Promise.resolve({ data: { ok: true } });
    }),
    delete: vi.fn().mockResolvedValue({ data: { ok: true } }),
  },
}));

vi.mock('@/lib/axios', () => ({
  default: {
    get: vi.fn((url: string) => {
      if (typeof url === 'string' && url.includes('/api/ai-farm/spider/config')) {
        return Promise.resolve({ data: { ok: true, config: getMockSpiderConfig() } });
      }
      if (typeof url === 'string' && url.includes('/api/ai-farm/spider/logs')) {
        return Promise.resolve({ data: { ok: true, records: [], total: 0 } });
      }
      return Promise.resolve({ data: {} });
    }),
    post: vi.fn().mockResolvedValue({ data: { ok: true } }),
    put: vi.fn((url: string, body: any) => {
      if (typeof url === 'string' && url.includes('/api/ai-farm/spider/config')) {
        return Promise.resolve({
          data: {
            ok: true,
            config: {
              ...getMockSpiderConfig(),
              ...(body || {}),
            },
          },
        });
      }
      return Promise.resolve({ data: { ok: true } });
    }),
    delete: vi.fn().mockResolvedValue({ data: { ok: true } }),
  },
}));

const mockUseOrganization = vi.fn();
vi.mock('@/lib/api/organization', () => ({
  useOrganization: () => mockUseOrganization(),
}));

export const TEST_ASSIGNMENT_USERS = [
  { id: 'u-admin-1', first_name: 'Alex', last_name: 'Morgan', email: 'alex@example.com', role: 'ADMIN' },
  { id: 'u-admin-2', first_name: 'Sarah', last_name: 'Connor', email: 'sarah@example.com', role: 'ADMIN' },
  { id: 'u-sales-1', first_name: 'Michael', last_name: 'Scott', email: 'michael@example.com', role: 'SALES' },
  { id: 'u-sales-2', first_name: 'Jim', last_name: 'Halpert', email: 'jim@example.com', role: 'SALES' },
  { id: 'u-disp-1', first_name: 'Pam', last_name: 'Beesly', email: 'pam@example.com', role: 'DISPATCHER' },
  { id: 'u-tech-1', first_name: 'Dwight', last_name: 'Schrute', email: 'dwight@example.com', role: 'TECHNICIAN' },
];

vi.mock('@/lib/api/users', () => ({
  useUsers: () => ({ data: TEST_ASSIGNMENT_USERS, isLoading: false }),
}));

vi.mock('@/lib/api/roles', () => ({
  useRoles: () => ({
    data: [
      { role: 'ADMIN', label: 'Administrator (Owner)', description: 'Full administrative access' },
      { role: 'SALES', label: 'Sales', description: 'Sales pipeline manager' },
      { role: 'DISPATCHER', label: 'Dispatcher', description: 'Job dispatch coordinator' },
      { role: 'TECHNICIAN', label: 'Technician', description: 'Field service technician' },
    ],
    isLoading: false,
  }),
}));

const queryClient = new QueryClient();

const TEST_CUSTOMERS: WatcherCustomer[] = [
  {
    id: 'c1',
    name: 'John Smith',
    company: 'Apex Plumbing Co.',
    email: 'john@apexplumbing.com',
    phone: '+1 (555) 234-5678',
    leads: [
      {
        id: 'l1',
        leadNumber: 'LD-101',
        serviceRequest: 'Main Line Leak & Pipe Replacement',
        serviceLocation: '9462 Highland Ave, Suite 414 Paterson, NJ 07501',
        stageId: 'new-contacted',
        stageLabel: 'New → Contacted',
        elapsedValue: 4,
        elapsedUnit: 'Day',
        elapsedSeconds: 4 * 86400,
        assigned_to: 'usr-admin-1',
        commission_owner_id: 'usr-admin-1',
        assignedToName: 'Alex Morgan',
      },
      {
        id: 'l2',
        leadNumber: 'LD-102',
        serviceRequest: 'Commercial Water Heater Installation',
        serviceLocation: '1048 Industrial Pkwy, Suite 300 Portland, OR 97201',
        stageId: 'contacted-walkthrough-scheduled',
        stageLabel: 'Contacted → Walkthrough Scheduled',
        elapsedValue: 6,
        elapsedUnit: 'Day',
        elapsedSeconds: 6 * 86400,
        contactedAt: new Date(Date.now() - 6 * 24 * 3600 * 1000).toISOString(),
        assigned_to: 'usr-sales-owner',
        commission_owner_id: 'usr-sales-owner',
        assignedToName: 'Michael Scott',
      },
    ],
  },
];

function renderAiCenter() {
  return render(
    <QueryClientProvider client={queryClient}>
      <AiCenterModal />
    </QueryClientProvider>
  );
}

function renderSpiderDetail(openConfig = false) {
  if (openConfig) {
    return render(
      <QueryClientProvider client={queryClient}>
        <SpiderWatcherPage />
      </QueryClientProvider>
    );
  }
  const agent = AI_AGENTS.find((a) => a.id === 'spider')!;
  return render(
    <QueryClientProvider client={queryClient}>
      <AgentDetailModal
        agent={agent}
        onOpenChange={() => {}}
        onBook={() => {}}
      />
    </QueryClientProvider>
  );
}

describe('AiCenterModal', () => {
  beforeEach(() => {
    queryClient.clear();
    mockNavigate.mockReset();
    mockUseOrganization.mockReturnValue({
      data: { is_demo: false },
    });
    useAiCenterStore.setState({ open: true, focusAgentId: null });
    useSpiderWatcherStore.setState({
      isActive: true,
      notifications: {
        email: true,
        sms: true,
        inApp: true,
        redFrame: true,
      },
      days: '',
      leadStages: [
        {
          id: 'new-contacted',
          label: 'New → Contacted',
          fromStage: 'New',
          toStage: 'Contacted',
          duration: undefined,
          unit: 'Minute',
        },
        {
          id: 'contacted-walkthrough-scheduled',
          label: 'Contacted → Walkthrough Scheduled',
          fromStage: 'Contacted',
          toStage: 'Walkthrough Scheduled',
          duration: undefined,
          unit: 'Minute',
        },
        {
          id: 'walkthrough-completed-estimate',
          label: 'Walkthrough Completed → Estimate',
          fromStage: 'Walkthrough Completed',
          toStage: 'Estimate',
          duration: undefined,
          unit: 'Minute',
        },
      ],
      customers: TEST_CUSTOMERS,
      selectedCustomerIds: ['c1'],
      selectedLeadIds: ['l1', 'l2'],
      hasUserModifiedSelection: false,
      autoEnrollAllLeads: true,
    });
  });

  describe('AiCenterModal — available to all orgs (Base Behavior)', () => {
    function setDemoOrg(isDemo: boolean) {
      vi.mocked(useAuthStore).mockImplementation((selector: (s: any) => unknown) =>
        selector({ user: { id: 'u1', role: 'ADMIN', org_is_demo: isDemo }, isAuthenticated: true })
      );
      mockUseOrganization.mockReturnValue({
        data: { is_demo: isDemo },
      });
    }

    it('renders the dialog for a real (non-demo) org', () => {
      setDemoOrg(false);
      renderAiCenter();
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('renders the dialog for a demo org', () => {
      setDemoOrg(true);
      renderAiCenter();
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    // None of the unbuilt agents is presented as live - the catalog is discovery plus "book a
    // call". The status label and the header must say so rather than claim a
    // live, working team.
    it('does not present unbuilt agents as live', () => {
      setDemoOrg(false);
      renderAiCenter();
      const unbuiltAgentsCount = AI_AGENTS.filter((a) => a.id !== 'spider').length;
      expect(screen.queryAllByText('Available')).toHaveLength(0);
      expect(screen.getAllByText('Coming soon')).toHaveLength(unbuiltAgentsCount);
      // The phrase, not a bare 24/7: Falcon's own card legitimately says "works
      // 24/7" and renders in this same modal.
      expect(screen.queryByText(/agents working 24\/7/i)).toBeNull();
    });

    it('the agent detail modal carries the same roadmap label', () => {
      setDemoOrg(false);
      useAiCenterStore.setState({ focusAgentId: 'mike' });
      renderAiCenter();
      expect(screen.getByText('Book a call about Border Collie')).toBeInTheDocument();
      expect(screen.queryAllByText('Available')).toHaveLength(0);
    });
  });
  describe('Spider Agent Preview Window & Activation Toggle Flow', () => {
    it('opening a non-Spider agent makes no Spider requests and renders standard booking modal', () => {
      const getSpy = vi.spyOn(api, 'get');
      const nonSpiderAgent = AI_AGENTS.find((a) => a.id !== 'spider')!;

      render(
        <QueryClientProvider client={queryClient}>
          <AgentDetailModal
            agent={nonSpiderAgent}
            onOpenChange={() => {}}
            onBook={() => {}}
          />
        </QueryClientProvider>
      );

      // Header details for non-Spider agent
      expect(screen.getByRole('heading', { level: 2, name: nonSpiderAgent.name })).toBeInTheDocument();
      expect(screen.getByText(nonSpiderAgent.role)).toBeInTheDocument();
      expect(screen.getByText('Coming soon')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: new RegExp(`Book a call about ${nonSpiderAgent.name}`, 'i') })).toBeInTheDocument();

      // Ensure no Spider-specific elements or endpoints were triggered
      expect(screen.queryByText(/Configure Spider/i)).toBeNull();
      expect(screen.queryByText(/AI Lead Manager/i)).toBeNull();
      expect(screen.queryByText(/Watchers/i)).toBeNull();

      const spiderCalls = getSpy.mock.calls.filter(([url]) => typeof url === 'string' && url.includes('/spider'));
      expect(spiderCalls).toHaveLength(0);
      getSpy.mockRestore();
    });

    it('clicking non-Spider agent cards inside AiCenterModal makes no Spider requests', () => {
      const getSpy = vi.spyOn(api, 'get');
      useAiCenterStore.setState({ open: true, focusAgentId: 'maya' });
      renderAiCenter();

      expect(screen.getByText('Book a call about Falcon')).toBeInTheDocument();
      expect(screen.getAllByText('AI Cold Caller').length).toBeGreaterThanOrEqual(1);
      expect(screen.queryByText(/Configure Spider/i)).toBeNull();

      const spiderCalls = getSpy.mock.calls.filter(([url]) => typeof url === 'string' && url.includes('/spider'));
      expect(spiderCalls).toHaveLength(0);
      getSpy.mockRestore();
    });

    it('opens Spider dedicated config panel for Spider agent', () => {
      renderSpiderDetail(false);

      // Header details
      expect(screen.getByRole('heading', { level: 2, name: 'Spider' })).toBeInTheDocument();
      expect(screen.getByText('AI Lead Manager')).toBeInTheDocument();
    });

    it('displays Unavailable status and Book a call button when Spider is not enabled for the company', () => {
      vi.mocked(useAuthStore).mockImplementation((selector: any) =>
        selector({
          user: {
            id: 'u-admin-1',
            organization_id: 'org-real-no-spider',
            org_is_demo: false,
          },
        })
      );

      renderSpiderDetail(false);

      expect(screen.getByRole('button', { name: /Unavailable/i })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Configure Spider/i })).toBeNull();

      const bookBtn = screen.getByRole('button', { name: /Book a call/i });
      fireEvent.click(bookBtn);

      expect(mockNavigate).not.toHaveBeenCalled();
      expect(screen.getByRole('heading', { name: 'Email support' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Upgrade my plan' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Get me Spider' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Other' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Send to support/i })).toBeInTheDocument();
    });

    it('navigates to /spider when Spider is enabled for the company (demo or allowlisted)', () => {
      vi.mocked(useAuthStore).mockImplementation((selector: any) =>
        selector({
          user: {
            id: 'u-admin-1',
            organization_id: 'org-real-allowed',
            org_is_demo: true,
          },
        })
      );

      renderSpiderDetail(false);

      const configBtn = screen.getByRole('button', { name: /Configure Spider/i });
      fireEvent.click(configBtn);

      expect(mockNavigate).toHaveBeenCalledWith('/spider');
      expect(
        screen.queryByText('Spider is not enabled for this company, please contact ServWave support')
      ).toBeNull();
    });
  });


  it('renders the dialog for a real (non-demo) org', () => {
    renderAiCenter();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('renders the dialog for a demo org', () => {
    mockUseOrganization.mockReturnValue({
      data: { is_demo: true },
    });
    renderAiCenter();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('does not present unbuilt agents as live', () => {
    renderAiCenter();
    expect(screen.queryAllByText('Available')).toHaveLength(0);
    expect(screen.getAllByText('Coming soon')).toHaveLength(AI_AGENT_COUNT - 1);
    expect(screen.queryByText(/agents working 24\/7/i)).toBeNull();
  });

  it('the agent detail modal carries the same roadmap label', () => {
    useAiCenterStore.setState({ focusAgentId: 'mike' });
    renderAiCenter();
    expect(screen.getByText('Book a call about Border Collie')).toBeInTheDocument();
    expect(screen.queryAllByText('Available')).toHaveLength(0);
  });

  it('renders custom Watcher configuration UI for Spider agent with Lead Stages and multi-lead Contact Watchers', () => {
    renderSpiderDetail(true);

    // 0. Notifications section with Email, SMS, In-app Message, and Red Frame
    expect(screen.getByText('Notifications')).toBeInTheDocument();
    expect(screen.getByText('Email')).toBeInTheDocument();
    expect(screen.getByText('SMS')).toBeInTheDocument();
    expect(screen.getByText('In-app Message')).toBeInTheDocument();
    expect(screen.getByText('Red Frame')).toBeInTheDocument();

    // Footer buttons on config screen: Book a call is removed, Save button & Back button exist
    expect(screen.queryByRole('button', { name: /Book a call about Spider/i })).toBeNull();
    const saveBtn = screen.getAllByRole('button', { name: /Save/i })[0]!;
    expect(saveBtn).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /AI Agentic Farm/i }).length).toBeGreaterThanOrEqual(1);

    // Toggling Red Frame in UI modifies draft, but does NOT update store until Save is clicked
    expect(useSpiderWatcherStore.getState().notifications.redFrame).toBe(true);
    const redFrameOption = screen.getByText('Red Frame').closest('div[class*="cursor-pointer"]');
    expect(redFrameOption).not.toBeNull();
    fireEvent.click(redFrameOption!);
    // Store remains unchanged before saving
    expect(useSpiderWatcherStore.getState().notifications.redFrame).toBe(true);

    // 1. Stage Thresholds section with 3 stages and default blank duration
    expect(screen.getByText('Stage Thresholds')).toBeInTheDocument();
    expect(screen.getByText('New → Contacted')).toBeInTheDocument();
    expect(screen.getByText('Contacted → Walkthrough Scheduled')).toBeInTheDocument();
    expect(screen.getByText('Walkthrough Completed → Estimate')).toBeInTheDocument();

    const stages = useSpiderWatcherStore.getState().leadStages;
    expect(stages.length).toBe(3);
    expect(stages.every((s) => s.duration === undefined && s.unit === 'Minute')).toBe(true);

    // Enable / disable switch toggles exist for each stage
    const enableSwitches = screen.getAllByRole('switch');
    expect(enableSwitches.length).toBeGreaterThanOrEqual(3);

    // Parallel time period & units inputs exist and default to blank
    const unitSelects = screen.getAllByLabelText(/^Time unit for/i);
    expect(unitSelects.length).toBe(3);
    const durationInputs = screen.getAllByLabelText(/^Time period for/i);
    expect(durationInputs.length).toBe(3);
    expect(durationInputs[0]!.getAttribute('value') || '').toBe('');

    // Stepper + / - buttons exist
    const incButtons = screen.getAllByLabelText(/^Increment time period for/i);
    expect(incButtons.length).toBe(3);
    const decButtons = screen.getAllByLabelText(/^Decrement time period for/i);
    expect(decButtons.length).toBe(3);

    // Decrement button is disabled when blank/<1
    expect(decButtons[0]!).toBeDisabled();

    // Clicking increment button increments draft value to 1 and enables decrement button
    fireEvent.click(incButtons[0]!);
    expect(durationInputs[0]!.getAttribute('value')).toBe('1');
    expect(decButtons[0]!).not.toBeDisabled();

    // Changing stage time period to 7 in draft
    fireEvent.change(durationInputs[0]!, { target: { value: '7' } });
    expect(durationInputs[0]!.getAttribute('value')).toBe('7');

    // Before clicking Save, store still has undefined duration and redFrame: true
    expect(useSpiderWatcherStore.getState().leadStages[0]!.duration).toBeUndefined();
    expect(useSpiderWatcherStore.getState().notifications.redFrame).toBe(true);

    // Clicking Save in footer opens confirmation overview modal
    fireEvent.click(saveBtn);
    expect(screen.getByText('Confirm Spider Agent Configuration')).toBeInTheDocument();
    expect(screen.getByText(/Pipeline Stage Thresholds/i)).toBeInTheDocument();

    // Confirm save in overview dialog
    const confirmBtn = screen.getByRole('button', { name: 'Active' });
    fireEvent.click(confirmBtn);

    expect(screen.getAllByText('Saved').length).toBeGreaterThanOrEqual(1);
    expect(useSpiderWatcherStore.getState().leadStages[0]!.duration).toBe(7);
    expect(useSpiderWatcherStore.getState().notifications.redFrame).toBe(false);

    // 2. Contact Watchers with Multi-Lead Dropdowns
    expect(screen.getByText('John Smith')).toBeInTheDocument();
    expect(screen.getByText(/Apex Plumbing Co/i)).toBeInTheDocument();

    // Dropdown is NOT open on hover
    const customerCard = screen.getByText('John Smith').closest('div[class*="rounded-lg border"]');
    expect(customerCard).not.toBeNull();
    fireEvent.mouseEnter(customerCard!);
    expect(screen.queryByText('Leads for John Smith')).toBeNull();

    // Click dropdown button to open dropdown of leads
    const dropdownBtn = screen.getByLabelText(/Toggle leads for John Smith/i);
    expect(dropdownBtn).toBeInTheDocument();
    fireEvent.click(dropdownBtn);

    // Dropdown shows customer's multiple leads
    expect(screen.getByText('Leads for John Smith')).toBeInTheDocument();
    expect(screen.getByText('LD-101')).toBeInTheDocument();
    // Complete address with suite, city, state, zip is displayed
    expect(screen.getByText('9462 Highland Ave, Suite 414 Paterson, NJ 07501')).toBeInTheDocument();
    expect(screen.queryByText('Main Line Leak & Pipe Replacement')).toBeNull();
    expect(screen.getByText('LD-102')).toBeInTheDocument();
    expect(screen.getByText('1048 Industrial Pkwy, Suite 300 Portland, OR 97201')).toBeInTheDocument();

    // Stage elapsed time is rendered between Lead ID and Stage
    expect(screen.getByText('4 Days in stage')).toBeInTheDocument();
    expect(screen.getByText('6 Days in stage')).toBeInTheDocument();

    // Last Communication Time is rendered before threshold value for Contacted lead
    expect(screen.getByText(/Last Comm:\s*6 Days ago/i)).toBeInTheDocument();

    // Select/deselect customer and specific lead
    const leadCheckbox = screen.getByLabelText(/Select lead LD-101 for notifications/i);
    expect(leadCheckbox).toBeInTheDocument();

    // Lead stage badge in Contact Watcher displays single stage ("New", "Contacted", "Walkthrough")
    expect(screen.getAllByText('New').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Contacted').length).toBeGreaterThan(0);

    // Clicking a lead redirects to Lead Overview
    const leadLink = screen.getByRole('button', { name: /Open Lead Overview for LD-101/i });
    expect(leadLink).toBeInTheDocument();
    fireEvent.click(leadLink);
    expect(mockNavigate).toHaveBeenCalledWith('/leads/l1');
  });

  it('redirects to Lead Overview when clicking on lead service location in Contact Watcher', () => {
    renderSpiderDetail(true);

    // Expand customer
    const dropdownBtn = screen.getByLabelText(/Toggle leads for John Smith/i);
    fireEvent.click(dropdownBtn);

    // Click service location
    const locationEl = screen.getByText('9462 Highland Ave, Suite 414 Paterson, NJ 07501');
    fireEvent.click(locationEl);

    expect(mockNavigate).toHaveBeenCalledWith('/leads/l1');
    expect(useAiCenterStore.getState().open).toBe(false);
  });

  it('calculates real lead stage and actual elapsed time accurately for New, Contacted, and Walkthrough Completed from Lead Overview', () => {
    const now = Date.now();

    // Stage 1: New -> standard Lead Status is NEW
    const newLead = {
      id: 'lead-1',
      created_at: new Date(now - 15 * 60 * 1000).toISOString(), // 15 mins ago
      status: 'NEW',
    };
    const s1 = resolveLeadStageAndElapsedTime(newLead);
    expect(s1.stageId).toBe('new-contacted');
    expect(s1.stageLabel).toBe('New → Contacted');
    expect(s1.elapsedUnit).toBe('Minute');
    expect(s1.elapsedValue).toBe(15);

    // Stage 2: Contacted -> standard Lead Status is CONTACTED
    const contactedLead = {
      id: 'lead-2',
      created_at: new Date(now - 2 * 24 * 3600 * 1000).toISOString(),
      contacted_at: new Date(now - 3 * 3600 * 1000).toISOString(), // 3 hours ago
      status: 'CONTACTED',
    };
    const s2 = resolveLeadStageAndElapsedTime(contactedLead);
    expect(s2.stageId).toBe('contacted-walkthrough-scheduled');
    expect(s2.stageLabel).toBe('Contacted → Walkthrough Scheduled');
    expect(s2.elapsedUnit).toBe('Hour');
    expect(s2.elapsedValue).toBe(3);

    // Contacted lead with walkthrough scheduled but not completed stays in Contacted stage
    const scheduledLead = {
      id: 'lead-3',
      created_at: new Date(now - 5 * 24 * 3600 * 1000).toISOString(),
      contacted_at: new Date(now - 4 * 24 * 3600 * 1000).toISOString(),
      walkthrough_scheduled_at: new Date(now - 45 * 1000).toISOString(),
      status: 'CONTACTED',
    };
    const s3 = resolveLeadStageAndElapsedTime(scheduledLead);
    expect(s3.stageId).toBe('contacted-walkthrough-scheduled');
    expect(s3.stageLabel).toBe('Contacted → Walkthrough Scheduled');

    // Stage 3: Walkthrough Completed -> pulled directly from Lead Overview details
    const completedLead = {
      id: 'lead-4',
      created_at: new Date(now - 7 * 24 * 3600 * 1000).toISOString(),
      walkthrough_completed_at: new Date(now - 2 * 24 * 3600 * 1000).toISOString(), // 2 days ago
      status: 'CONTACTED',
    };
    const s4 = resolveLeadStageAndElapsedTime(completedLead);
    expect(s4.stageId).toBe('walkthrough-completed-estimate');
    expect(s4.stageLabel).toBe('Walkthrough Completed → Estimate');
    expect(s4.elapsedUnit).toBe('Day');
    expect(s4.elapsedValue).toBe(2);

    // Estimate stage is resolved for leads with estimates or ESTIMATED status
    const estimatedLead = {
      id: 'lead-5',
      created_at: new Date(now - 10 * 24 * 3600 * 1000).toISOString(),
      walkthrough_completed_at: new Date(now - 5 * 24 * 3600 * 1000).toISOString(),
      status: 'ESTIMATED',
      estimates: [{ id: 'est-1', total_amount: '500' }],
    };
    const s5 = resolveLeadStageAndElapsedTime(estimatedLead);
    expect(s5.stageId).toBe('estimate');
    expect(s5.stageLabel).toBe('Estimate');
  });

  it('selects all customers and all leads by default in Spider Contact Watchers', () => {
    useSpiderWatcherStore.setState({
      isActive: true,
      activatedAt: new Date().toISOString(),
      customers: [],
      selectedCustomerIds: [],
      selectedLeadIds: [],
      leadStages: [
        {
          id: 'new-contacted',
          label: 'New → Contacted',
          fromStage: 'New',
          toStage: 'Contacted',
          duration: 0,
          unit: 'Second',
        },
        {
          id: 'contacted-walkthrough-scheduled',
          label: 'Contacted → Walkthrough Scheduled',
          fromStage: 'Contacted',
          toStage: 'Walkthrough Scheduled',
          duration: 0,
          unit: 'Second',
        },
      ],
      hasUserModifiedSelection: false,
    });

    const nowIso = new Date().toISOString();
    const activeTestCustomers: WatcherCustomer[] = TEST_CUSTOMERS.map((c) => ({
      ...c,
      leads: c.leads.map((l) => ({ ...l, createdAt: nowIso })),
    }));
    useSpiderWatcherStore.getState().setCustomers(activeTestCustomers);

    const state = useSpiderWatcherStore.getState();
    expect(state.selectedCustomerIds).toEqual(['c1']);
    expect(state.selectedLeadIds).toEqual(['l1', 'l2']);

    // Computed notifications evaluate all selected leads as triggered by default (0s threshold)
    const notifs = state.getComputedNotifications();
    expect(notifs.length).toBe(2);
    expect(notifs.map((n) => n.leadId)).toEqual(['l1', 'l2']);
  });

  it('selects nested leads when customers load before leads arrive asynchronously', () => {
    useSpiderWatcherStore.setState({
      customers: [],
      selectedCustomerIds: [],
      selectedLeadIds: [],
      leadStages: [
        {
          id: 'new-contacted',
          label: 'New → Contacted',
          fromStage: 'New',
          toStage: 'Contacted',
          duration: 0,
          unit: 'Second',
        },
        {
          id: 'contacted-walkthrough-scheduled',
          label: 'Contacted → Walkthrough Scheduled',
          fromStage: 'Contacted',
          toStage: 'Walkthrough Scheduled',
          duration: 0,
          unit: 'Second',
        },
      ],
      hasUserModifiedSelection: false,
    });

    // Step 1: User selects customer c1
    useSpiderWatcherStore.getState().toggleCustomerSelection('c1', []);
    expect(useSpiderWatcherStore.getState().selectedCustomerIds).toEqual(['c1']);
    expect(useSpiderWatcherStore.getState().selectedLeadIds).toEqual([]);

    // Step 2: Leads API returns shortly after
    useSpiderWatcherStore.getState().setCustomers(TEST_CUSTOMERS);
    useSpiderWatcherStore.getState().selectAllCustomers();
    const state = useSpiderWatcherStore.getState();
    expect(state.selectedCustomerIds).toEqual(['c1']);
    expect(state.selectedLeadIds).toEqual(['l1', 'l2']);
    expect(state.getComputedNotifications().length).toBe(2);
  });

  it('allows toggling customer and lead selections and supports select/deselect all', () => {
    useSpiderWatcherStore.setState({
      customers: TEST_CUSTOMERS,
      selectedCustomerIds: ['c1'],
      selectedLeadIds: ['l1', 'l2'],
      leadStages: [
        {
          id: 'new-contacted',
          label: 'New → Contacted',
          fromStage: 'New',
          toStage: 'Contacted',
          duration: 0,
          unit: 'Second',
        },
        {
          id: 'contacted-walkthrough-scheduled',
          label: 'Contacted → Walkthrough Scheduled',
          fromStage: 'Contacted',
          toStage: 'Walkthrough Scheduled',
          duration: 0,
          unit: 'Second',
        },
      ],
      hasUserModifiedSelection: false,
    });

    // Deselect customer c1
    useSpiderWatcherStore.getState().toggleCustomerSelection('c1', ['l1', 'l2']);
    let state = useSpiderWatcherStore.getState();
    expect(state.selectedCustomerIds).toEqual([]);
    expect(state.selectedLeadIds).toEqual([]);
    expect(state.getComputedNotifications().length).toBe(0);

    // Select customer c1 again -> selects both customer and its leads
    useSpiderWatcherStore.getState().toggleCustomerSelection('c1', ['l1', 'l2']);
    state = useSpiderWatcherStore.getState();
    expect(state.selectedCustomerIds).toEqual(['c1']);
    expect(state.selectedLeadIds).toEqual(['l1', 'l2']);

    // Deselect single lead l1
    useSpiderWatcherStore.getState().toggleLeadSelection('l1', 'c1', ['l1', 'l2']);
    state = useSpiderWatcherStore.getState();
    expect(state.selectedCustomerIds).toEqual(['c1']); // c1 still selected because l2 is selected
    expect(state.selectedLeadIds).toEqual(['l2']);

    // Deselect all
    useSpiderWatcherStore.getState().deselectAllCustomers();
    state = useSpiderWatcherStore.getState();
    expect(state.selectedCustomerIds).toEqual([]);
    expect(state.selectedLeadIds).toEqual([]);

    // Select all
    useSpiderWatcherStore.getState().selectAllCustomers();
    state = useSpiderWatcherStore.getState();
    expect(state.selectedCustomerIds).toEqual(['c1']);
    expect(state.selectedLeadIds).toEqual(['l1', 'l2']);
  });

  it('selects and deselects all leads when clicking customer select checkbox in Watcher settings', () => {
    useSpiderWatcherStore.setState({
      customers: TEST_CUSTOMERS,
      selectedCustomerIds: ['c1'],
      selectedLeadIds: ['l1', 'l2'],
      hasUserModifiedSelection: true,
    });

    const state = useSpiderWatcherStore.getState();
    expect(state.selectedCustomerIds).toContain('c1');
    expect(state.selectedLeadIds).toEqual(['l1', 'l2']);

    // Deselect customer
    useSpiderWatcherStore.getState().toggleCustomerSelection('c1', ['l1', 'l2']);
    expect(useSpiderWatcherStore.getState().selectedCustomerIds).not.toContain('c1');
    expect(useSpiderWatcherStore.getState().selectedLeadIds).toEqual([]);

    // Select customer back
    useSpiderWatcherStore.getState().toggleCustomerSelection('c1', ['l1', 'l2']);
    expect(useSpiderWatcherStore.getState().selectedCustomerIds).toContain('c1');
    expect(useSpiderWatcherStore.getState().selectedLeadIds).toEqual(['l1', 'l2']);
  });

  it('does not apply selection changes until the user clicks Save', () => {
    useSpiderWatcherStore.setState({
      customers: TEST_CUSTOMERS,
      selectedCustomerIds: ['c1'],
      selectedLeadIds: ['l1', 'l2'],
      hasUserModifiedSelection: false,
      leadStages: [
        {
          id: 'new-contacted',
          label: 'New → Contacted',
          fromStage: 'New',
          toStage: 'Contacted',
          duration: 10,
          unit: 'Day',
        },
      ],
    });

    renderSpiderDetail(true);

    // Expand dropdown for customer first
    const dropdownBtn = screen.getByLabelText(/Toggle leads for John Smith/i);
    fireEvent.click(dropdownBtn);

    // Toggle off second lead so 1 lead remains selected
    const l2Checkbox = screen.getByLabelText(/Select lead LD-102/i);
    fireEvent.click(l2Checkbox);

    // BUT store has NOT changed yet because Save was not clicked
    expect(useSpiderWatcherStore.getState().selectedLeadIds).toEqual(['l1', 'l2']);

    // Now click the Save button in the footer and confirm overview
    const saveBtn = screen.getAllByRole('button', { name: /Save/i })[0]!;
    fireEvent.click(saveBtn);
    const confirmBtn = screen.getByRole('button', { name: 'Active' });
    fireEvent.click(confirmBtn);

    // Now store has been updated!
    expect(useSpiderWatcherStore.getState().selectedLeadIds).toEqual(['l1']);
  });

  describe('Confirm Spider Agent Configuration Modal Validation Checks', () => {
    it('displays error prompt and prevents activation when required sections are missing', () => {
      // Default state has undefined stage durations
      renderSpiderDetail(true);

      // Click Save to open confirmation modal
      const saveBtn = screen.getAllByRole('button', { name: /Save/i })[0]!;
      fireEvent.click(saveBtn);

      expect(screen.getByText('Confirm Spider Agent Configuration')).toBeInTheDocument();

      // Activate button is present
      const activateBtn = screen.getByRole('button', { name: 'Active' });
      expect(activateBtn).toBeInTheDocument();

      // Before clicking, error callout is not yet shown
      expect(screen.queryByText(/Required Items Missing Before Activation/i)).toBeNull();

      // Clicking Activate triggers validation error callout and prevents save
      fireEvent.click(activateBtn);

      // Validation callout is rendered explaining the missing required item
      expect(screen.getByText(/Required Items Missing Before Activation/i)).toBeInTheDocument();
      expect(screen.getByText(/At least one item must be selected from every required section before activating/i)).toBeInTheDocument();
      expect(screen.getByText(/Please set at least one stage duration threshold greater than 0/i)).toBeInTheDocument();

      // Modal remains open and configuration is not saved
      expect(screen.getByText('Confirm Spider Agent Configuration')).toBeInTheDocument();
      expect(useSpiderWatcherStore.getState().leadStages[0]!.duration).toBeUndefined();
    });
  });

  it('triggers notification alerts for Contacted stage leads based on the last communication timestamp', () => {
    useSpiderWatcherStore.setState({
      customers: TEST_CUSTOMERS,
      selectedCustomerIds: ['c1'],
      selectedLeadIds: ['l1', 'l2'],
      leadStages: [
        {
          id: 'new-contacted',
          label: 'New → Contacted',
          fromStage: 'New',
          toStage: 'Contacted',
          duration: 10,
          unit: 'Day',
        },
        {
          id: 'contacted-walkthrough-scheduled',
          label: 'Contacted → Walkthrough Scheduled',
          fromStage: 'Contacted',
          toStage: 'Walkthrough Scheduled',
          duration: 5,
          unit: 'Day',
        },
        {
          id: 'walkthrough-completed-estimate',
          label: 'Walkthrough Completed → Estimate',
          fromStage: 'Walkthrough Completed',
          toStage: 'Estimate',
          duration: undefined,
          unit: 'Second',
        },
      ],
      readNotificationIds: [],
    });

    const notifs = useSpiderWatcherStore.getState().getComputedNotifications();
    // LD-102 has 6 days since contacted, exceeding 5 Day threshold -> triggers alert
    expect(notifs.some((n) => n.leadId === 'l2')).toBe(true);

    // LD-101 has 4 days in New stage, below 10 Day threshold -> no alert
    expect(notifs.some((n) => n.leadId === 'l1')).toBe(false);
  });

  it('persists Spider settings to localStorage across reload', () => {
    localStorage.clear();

    useSpiderWatcherStore.setState({
      customers: TEST_CUSTOMERS,
      selectedCustomerIds: ['c1'],
      selectedLeadIds: ['l1', 'l2'],
      hasUserModifiedSelection: false,
    });

    renderSpiderDetail(true);

    // Change redFrame and stage duration
    const redFrameOption = screen.getByText('Red Frame').closest('div[class*="cursor-pointer"]');
    fireEvent.click(redFrameOption!);

    const durationInputs = screen.getAllByLabelText(/^Time period for/i);
    fireEvent.change(durationInputs[0]!, { target: { value: '14' } });

    // Click Save and confirm overview
    const saveBtn = screen.getAllByRole('button', { name: /Save/i })[0]!;
    fireEvent.click(saveBtn);
    const confirmBtn = screen.getByRole('button', { name: 'Active' });
    fireEvent.click(confirmBtn);

    // Verify localStorage has persisted settings (SEC-7: no customer PII in browser storage)
    const stored = localStorage.getItem('servwave_spider_watcher_settings');
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!);
    expect(parsed.state.notifications.redFrame).toBe(false);
    expect(parsed.state.leadStages[0].duration).toBe(14);
    expect(parsed.state.hasUserModifiedSelection).toBe(true);
    expect(parsed.state.customers).toBeUndefined();
  });

  it('persists Spider UI configuration preferences across page reload without storing customer PII', () => {
    localStorage.clear();

    useSpiderWatcherStore.setState({
      selectedLeadIds: ['l1', 'l2'],
      leadStages: [
        {
          id: 'new-contacted',
          label: 'New → Contacted',
          fromStage: 'New',
          toStage: 'Contacted',
          duration: 1,
          unit: 'Day',
        },
      ],
      notifications: {
        email: true,
        sms: true,
        inApp: true,
        redFrame: true,
      },
      readNotificationIds: [],
      hasUserModifiedSelection: true,
    });

    const persistedRaw = localStorage.getItem('servwave_spider_watcher_settings');
    expect(persistedRaw).not.toBeNull();
    const persistedObj = JSON.parse(persistedRaw!).state;
    expect(persistedObj.notifications.email).toBe(true);
    expect(persistedObj.selectedLeadIds).toEqual(['l1', 'l2']);
    expect(persistedObj.customers).toBeUndefined();
  });

  describe('Service Location Resolution for Customer Leads', () => {
    it('formatAddressParts formats full street address, unit, city, state, zip cleanly', () => {
      expect(
        formatAddressParts('1888 Main St', null, 'Clifton', 'NJ', '07011')
      ).toBe('1888 Main St, Clifton, NJ 07011');

      expect(
        formatAddressParts('9462 Highland Ave', 'Suite 414', 'Paterson', 'NJ', '07501')
      ).toBe('9462 Highland Ave, Suite 414, Paterson, NJ 07501');

      expect(
        formatAddressParts(null, null, 'Clifton', 'NJ', null)
      ).toBe('Clifton, NJ');
    });

    it('formatLeadServiceLocation extracts complete address from service_location relation', () => {
      const lead = {
        id: 'l-test-1',
        service_location: {
          address_line1: '1888 Main St',
          address_line2: null,
          city: 'Clifton',
          state: 'NJ',
          zip: '07011',
        },
      };
      expect(formatLeadServiceLocation(lead)).toBe('1888 Main St, Clifton, NJ 07011');
    });

    it('formatLeadServiceLocation extracts complete address matching customer service_locations', () => {
      const lead = {
        id: 'l-test-2',
        service_location_id: 'loc-primary',
        service_city: 'Clifton',
        service_state: 'NJ',
      };
      const customer = {
        id: 'c-test',
        service_locations: [
          {
            id: 'loc-primary',
            address_line1: '1888 Main St',
            city: 'Clifton',
            state: 'NJ',
            zip: '07011',
            is_primary: true,
          },
        ],
      };
      expect(formatLeadServiceLocation(lead, customer)).toBe('1888 Main St, Clifton, NJ 07011');
    });

    it('buildWatcherCustomersFromLive links live API customers and leads with complete service locations', () => {
      const apiLeads = [
        {
          id: 'lead-87',
          lead_number: 'L00087',
          customer_id: 'cust-12',
          service_request: 'Automatic slide gate stuck halfway, motor humming',
          service_location_id: 'loc-1',
          created_at: new Date(Date.now() - 20 * 86400 * 1000).toISOString(),
          status: 'CONTACTED',
          contacted_at: new Date(Date.now() - 20 * 86400 * 1000).toISOString(),
        },
      ];

      const apiCustomers = [
        {
          id: 'cust-12',
          first_name: 'Steven',
          last_name: 'Nguyen',
          email: 'steven.nguyen@example.com',
          phone: '+15552012571',
          service_locations: [
            {
              id: 'loc-1',
              address_line1: '1888 Main St',
              city: 'Clifton',
              state: 'NJ',
              zip: '07011',
              is_primary: true,
            },
          ],
        },
      ];

      const customers = buildWatcherCustomersFromLive(apiLeads, apiCustomers);
      expect(customers).toHaveLength(1);
      expect(customers[0]!.name).toBe('Steven Nguyen');
      expect(customers[0]!.leads).toHaveLength(1);
      expect(customers[0]!.leads[0]!.serviceLocation).toBe('1888 Main St, Clifton, NJ 07011');
    });

    it('renders complete service location in Spider Contact Watchers dropdown', () => {
      const customersWithFullAddress: WatcherCustomer[] = [
        {
          id: 'c-steven',
          name: 'Steven Nguyen',
          email: 'steven.nguyen@example.com',
          service_locations: [
            {
              id: 'loc-1',
              address_line1: '1888 Main St',
              city: 'Clifton',
              state: 'NJ',
              zip: '07011',
              is_primary: true,
            },
          ],
          leads: [
            {
              id: 'l-87',
              leadNumber: 'L00087',
              serviceRequest: 'Automatic slide gate stuck halfway, motor humming',
              serviceLocation: '1888 Main St, Clifton, NJ 07011',
              stageId: 'contacted-walkthrough-scheduled',
              stageLabel: 'Contacted → Walkthrough Scheduled',
              elapsedValue: 20,
              elapsedUnit: 'Day',
              elapsedSeconds: 20 * 86400,
            },
          ],
        },
      ];

      useSpiderWatcherStore.setState({
        customers: customersWithFullAddress,
        selectedCustomerIds: ['c-steven'],
        selectedLeadIds: ['l-87'],
      });

      renderSpiderDetail(true);

      // Expand Steven Nguyen's lead dropdown
      const stevenRow = screen.getByText('Steven Nguyen').closest('div[class*="rounded-lg"]');
      const expandBtn = stevenRow!.querySelector('button[aria-label="Toggle leads for Steven Nguyen"]');
      fireEvent.click(expandBtn!);

      // Complete service location is visible
      expect(screen.getByText('1888 Main St, Clifton, NJ 07011')).toBeInTheDocument();
      expect(screen.getByTitle('1888 Main St, Clifton, NJ 07011')).toBeInTheDocument();
    });
  });

  describe('Spider Watcher Assignment Section', () => {
    it('renders the Assignment section with System role, Owner, and User categories', () => {
      renderSpiderDetail(true);

      expect(screen.getByText('Assignment')).toBeInTheDocument();
      expect(
        screen.getByText('Alerts will notify all active team members matching the selected roles and users.')
      ).toBeInTheDocument();

      expect(screen.getByText('System role')).toBeInTheDocument();
      expect(screen.getByText('Owner')).toBeInTheDocument();
      expect(screen.getByText('User')).toBeInTheDocument();
    });

    it('expands System role to show 4 roles from Settings > Roles & Permissions', () => {
      renderSpiderDetail(true);

      // Initially collapsed
      expect(screen.queryByText('Administrator (Owner)')).toBeNull();
      expect(screen.queryByText('Dispatcher')).toBeNull();

      // Expand System role
      const toggleAdmin = screen.getByLabelText(/Toggle System role options/i);
      fireEvent.click(toggleAdmin);
      expect(screen.getByText('Administrator (Owner)')).toBeInTheDocument();
      expect(screen.getByText('Sales')).toBeInTheDocument();
      expect(screen.getByText('Dispatcher')).toBeInTheDocument();
      expect(screen.getByText('Technician')).toBeInTheDocument();
    });

    it('renders Owner as a direct toggle without nested sub-options', () => {
      renderSpiderDetail(true);

      const ownerCheckbox = screen.getByLabelText(/Notify Lead Owner/i);
      expect(ownerCheckbox).toBeInTheDocument();
      expect(ownerCheckbox).toHaveAttribute('data-state', 'checked');

      // No dropdown chevron for Owner
      expect(screen.queryByLabelText(/Toggle Owner options/i)).toBeNull();

      // Click Owner toggle
      fireEvent.click(ownerCheckbox);
      expect(ownerCheckbox).toHaveAttribute('data-state', 'unchecked');
    });

    it('renders User section listing all available users independently of System role selections', () => {
      renderSpiderDetail(true);

      // Expand System role and User
      const toggleAdmin = screen.getByLabelText(/Toggle System role options/i);
      fireEvent.click(toggleAdmin);
      const toggleUser = screen.getByLabelText(/Toggle User options/i);
      fireEvent.click(toggleUser);

      // All available users appear in the User list independently
      expect(screen.getByText('Alex Morgan')).toBeInTheDocument();
      expect(screen.getByText('Michael Scott')).toBeInTheDocument();
      expect(screen.getByText('Dwight Schrute')).toBeInTheDocument();

      // Deselect all System roles
      const adminRoleSelectAll = screen.getByLabelText(/Select all System roles/i);
      fireEvent.click(adminRoleSelectAll);

      // All users still remain accessible in the User list independently
      expect(screen.getByText('Alex Morgan')).toBeInTheDocument();
      expect(screen.getByText('Michael Scott')).toBeInTheDocument();
      expect(screen.getByText('Dwight Schrute')).toBeInTheDocument();
    });

    it('toggles assignments and saves to store', () => {
      useSpiderWatcherStore.setState({
        assignments: {
          adminRoles: ['ADMIN'],
          owner: true,
          users: ['u-tech-1', 'u-admin-1'],
        },
      });
      renderSpiderDetail(true);

      // Expand System role and User
      const toggleAdmin = screen.getByLabelText(/Toggle System role options/i);
      fireEvent.click(toggleAdmin);
      const toggleUser = screen.getByLabelText(/Toggle User options/i);
      fireEvent.click(toggleUser);

      // Deselect Dwight Schrute in User section
      const dwightRow = screen.getByText('Dwight Schrute').closest('div[class*="cursor-pointer"]');
      expect(dwightRow).not.toBeNull();
      fireEvent.click(dwightRow!);

      // Toggle Owner
      const ownerCheckbox = screen.getByLabelText(/Notify Lead Owner/i);
      fireEvent.click(ownerCheckbox);

      // Set stage threshold duration so validation passes
      const durationInputs = screen.getAllByLabelText(/^Time period for/i);
      fireEvent.change(durationInputs[0]!, { target: { value: '5' } });

      // Save changes
      const saveBtn = screen.getAllByRole('button', { name: /Save/i })[0]!;
      fireEvent.click(saveBtn);
      const confirmBtn = screen.getByRole('button', { name: 'Active' });
      fireEvent.click(confirmBtn);

      const savedAssignments = useSpiderWatcherStore.getState().assignments;
      expect(savedAssignments.owner).toBe(false);
      expect(savedAssignments.users).not.toContain('u-tech-1');
      expect(savedAssignments.users).toContain('u-admin-1');
    });

    it('resolves alert recipients according to independent Assignment configuration rules', () => {
      const mockLead = {
        id: 'l101',
        assigned_to: 'user-lead-owner',
      };

      const allUsers = [
        { id: 'u-admin-1', name: 'Alex Morgan', role: 'ADMIN' },
        { id: 'u-sales-1', name: 'Michael Scott', role: 'SALES' },
        { id: 'u-disp-1', name: 'Pam Beesly', role: 'DISPATCHER' },
        { id: 'u-tech-1', name: 'Dwight Schrute', role: 'TECHNICIAN' },
      ];

      // 1. Admin roles selected independently: alerts sent to users of those roles
      const adminRolesOnly = resolveSpiderAlertRecipients({
        assignments: {
          adminRoles: ['ADMIN', 'SALES'],
          owner: false,
          users: [],
        },
        lead: mockLead,
        allUsers,
      });
      expect(adminRolesOnly).toContain('u-admin-1');
      expect(adminRolesOnly).toContain('u-sales-1');
      expect(adminRolesOnly).not.toContain('user-lead-owner');
      expect(adminRolesOnly).not.toContain('u-disp-1');

      // 2. Specific individual users selected independently: alerts sent directly to those users
      const usersOnly = resolveSpiderAlertRecipients({
        assignments: {
          adminRoles: [],
          owner: false,
          users: ['u-tech-1'],
        },
        lead: mockLead,
        allUsers,
      });
      expect(usersOnly).toEqual(['u-tech-1']);

      // 3. Owner selected independently: alerts sent ONLY to the owner of the lead
      const ownerOnly = resolveSpiderAlertRecipients({
        assignments: {
          adminRoles: [],
          owner: true,
          users: [],
        },
        lead: mockLead,
        allUsers,
      });
      expect(ownerOnly).toEqual(['user-lead-owner']);

      // 4. Combined: Admin roles + specific User + Owner all selected independently
      const combined = resolveSpiderAlertRecipients({
        assignments: {
          adminRoles: ['ADMIN'],
          owner: true,
          users: ['u-tech-1'],
        },
        lead: mockLead,
        allUsers,
      });
      expect(combined).toContain('u-admin-1');
      expect(combined).toContain('u-tech-1');
      expect(combined).toContain('user-lead-owner');
      expect(combined.length).toBe(3);

      // 4. Nothing selected: 0 recipients
      const noneSelected = resolveSpiderAlertRecipients({
        assignments: {
          adminRoles: [],
          owner: false,
          users: [],
        },
        lead: mockLead,
        allUsers,
      });
      expect(noneSelected).toEqual([]);
    });

    it('suppresses notifications when current user does not match the Assignment selection', () => {
      useSpiderWatcherStore.setState({
        customers: TEST_CUSTOMERS,
        selectedLeadIds: ['l1', 'l2'],
        readNotificationIds: [],
        leadStages: [
          {
            id: 'new-contacted',
            label: 'New → Contacted',
            fromStage: 'New',
            toStage: 'Contacted',
            duration: 3,
            unit: 'Day',
          },
          {
            id: 'contacted-walkthrough-scheduled',
            label: 'Contacted → Walkthrough Scheduled',
            fromStage: 'Contacted',
            toStage: 'Walkthrough Scheduled',
            duration: 5,
            unit: 'Day',
          },
        ],
        assignments: {
          adminRoles: [],
          owner: false,
          users: [],
        },
      });

      const adminUser = { id: 'usr-admin-1', role: 'ADMIN' };

      // Case 1: Nothing selected in Assignment -> 0 notifications for system admin user
      const notifsNone = useSpiderWatcherStore.getState().getComputedNotifications(adminUser);
      expect(notifsNone).toEqual([]);

      // Case 2: Only SALES selected -> ADMIN user receives 0 notifications
      useSpiderWatcherStore.setState({
        assignments: {
          adminRoles: ['SALES'],
          owner: false,
          users: ['u-sales-1'],
        },
      });
      const notifsSalesOnly = useSpiderWatcherStore.getState().getComputedNotifications(adminUser);
      expect(notifsSalesOnly).toEqual([]);

      // Case 3: ADMIN role selected -> ADMIN user receives notifications
      useSpiderWatcherStore.setState({
        assignments: {
          adminRoles: ['ADMIN'],
          owner: false,
          users: ['u-admin-1'],
        },
      });
      const notifsAdminActive = useSpiderWatcherStore.getState().getComputedNotifications(adminUser);
      expect(notifsAdminActive.length).toBeGreaterThan(0);

      // Case 4: Only Owner selected -> alerts sent strictly to the assigned lead owner of that specific lead
      useSpiderWatcherStore.setState({
        assignments: {
          adminRoles: [],
          owner: true,
          users: [],
        },
      });

      // User 1 (usr-admin-1) is owner of lead l1
      const notifsOwner1 = useSpiderWatcherStore.getState().getComputedNotifications({ id: 'usr-admin-1', role: 'TECHNICIAN' });
      expect(notifsOwner1.length).toBe(1);
      expect(notifsOwner1[0]!.leadId).toBe('l1');

      // User 2 (usr-sales-owner) is owner of lead l2
      const notifsOwner2 = useSpiderWatcherStore.getState().getComputedNotifications({ id: 'usr-sales-owner', role: 'TECHNICIAN' });
      expect(notifsOwner2.length).toBe(1);
      expect(notifsOwner2[0]!.leadId).toBe('l2');

      // User 3 (unrelated user) is not the owner of any triggered lead
      const notifsStranger = useSpiderWatcherStore.getState().getComputedNotifications({ id: 'usr-stranger-999', role: 'TECHNICIAN' });
      expect(notifsStranger).toEqual([]);
    });

    it('switches between Configuration and History tabs on the Spider Watcher page and renders Date column next to Time', async () => {
      localStorage.clear();
      useSpiderWatcherStore.setState({
        customers: TEST_CUSTOMERS,
        selectedCustomerIds: ['c1'],
        selectedLeadIds: ['l1', 'l2'],
        leadStages: [
          {
            id: 'new-contacted',
            label: 'New → Contacted',
            fromStage: 'New',
            toStage: 'Contacted',
            duration: 1,
            unit: 'Day',
            enabled: true,
          },
        ],
      });
      vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
        if (url.includes('/api/ai-farm/spider/logs')) {
          return {
            data: {
              ok: true,
              records: [
                {
                  id: 'log-1',
                  lead_id: 'l1',
                  lead_number: 'LD-101',
                  customer_name: 'John Smith',
                  stage_name: 'New → Contacted',
                  service_location: '9462 Highland Ave',
                  created_at: new Date().toISOString(),
                  channels: { email: { enabled: true, status: 'SENT' }, sms: { enabled: false } },
                  recipients: [{ name: 'Alex Morgan', role: 'ADMIN' }],
                },
              ],
              total: 1,
              page: 1,
              limit: 50,
            },
          } as any;
        }
        return { data: {} } as any;
      });

      renderSpiderDetail(true);

      // Default tab is Configuration
      const historyTabBtn = screen.getByRole('tab', { name: /History Tab/i });
      expect(screen.getByRole('tab', { name: /Configuration Tab/i })).toBeInTheDocument();
      expect(historyTabBtn).toBeInTheDocument();
      expect(screen.getByText('Configuration & Alert Rules')).toBeInTheDocument();

      // Click History tab -> clears unread badge
      fireEvent.click(historyTabBtn);

      // History view is now active
      expect(screen.getByRole('button', { name: /Filter/i })).toBeInTheDocument();
      expect(screen.getByPlaceholderText(/Search leads/i)).toBeInTheDocument();

      // Verify table headers include combined Date & Time
      const dateTimeHeader = await screen.findByText('Date & Time');
      expect(dateTimeHeader).toBeInTheDocument();

      // Click Configuration tab
      const configTabBtn = screen.getByRole('tab', { name: /Configuration Tab/i });
      fireEvent.click(configTabBtn);

      // Configuration view is active again
      expect(screen.getByText('Configuration & Alert Rules')).toBeInTheDocument();
      expect(screen.getByText('Notifications')).toBeInTheDocument();
    });

    it('displays the real database total count (e.g. 500) in the History pagination instead of capping at 100', async () => {
      useSpiderWatcherStore.setState({
        isActive: true,
        activatedAt: new Date().toISOString(),
      });

      const fakeLogs = Array.from({ length: 25 }, (_, i) => ({
        id: `log-${i + 1}`,
        lead_id: `lead-${i + 1}`,
        lead_number: `LD-${100 + i + 1}`,
        customer_name: `Customer ${i + 1}`,
        stage_name: 'New Lead',
        service_location: `${i + 1} Main St`,
        created_at: new Date(Date.now() - i * 60000).toISOString(),
        channels: { email: { enabled: true, status: 'SENT' } },
        recipients: [{ name: 'Alex Morgan', role: 'ADMIN' }],
      }));

      vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
        if (url.includes('/api/ai-farm/spider/logs')) {
          return {
            data: {
              ok: true,
              records: fakeLogs,
              total: 500,
              page: 1,
              limit: 25,
              totalPages: 20,
            },
          } as any;
        }
        return { data: {} } as any;
      });

      renderSpiderDetail(true);

      const historyTabBtn = screen.getByRole('tab', { name: /History Tab/i });
      fireEvent.click(historyTabBtn);

      // Verify it displays Showing 1-25 of 500 and Page 1 of 20
      expect(await screen.findByText('1-25')).toBeInTheDocument();
      expect(screen.getByText('500')).toBeInTheDocument();
      expect(screen.getByText('Page 1 of 20')).toBeInTheDocument();
    });

    it('measures lead duration strictly forward from Spider activation timestamp, ignoring older history', () => {
      const now = Date.now();
      // Lead created 3 days ago
      const threeDaysAgo = new Date(now - 3 * 24 * 3600 * 1000).toISOString();
      // Spider activated 10 minutes ago
      const activatedTenMinsAgo = new Date(now - 10 * 60 * 1000).toISOString();

      const oldLead = {
        id: 'old-lead-1',
        leadNumber: 'LD-999',
        created_at: threeDaysAgo,
        stageId: 'new-contacted',
        stageLabel: 'New → Contacted',
      };

      // 1. When activatedAt is passed, elapsedSeconds is ~600 seconds (10 minutes), NOT 3 days (259200 seconds)
      const metrics = resolveLeadStageAndElapsedTime(oldLead, activatedTenMinsAgo);
      expect(metrics.elapsedSeconds).toBeGreaterThanOrEqual(590);
      expect(metrics.elapsedSeconds).toBeLessThanOrEqual(610);
      expect(metrics.elapsedUnit).toBe('Minute');
      expect(metrics.elapsedValue).toBe(10);

      // 2. Stage threshold is 1 Hour (3600 seconds). Since Spider has only been active for 10 minutes,
      // the lead MUST NOT trigger overdue immediately upon Spider activation.
      const oneHourStageConfig = [
        {
          id: 'new-contacted',
          label: 'New → Contacted',
          fromStage: 'New',
          toStage: 'Contacted',
          duration: 1,
          unit: 'Hour' as const,
          enabled: true,
        },
      ];

      const isOverdueNow = isLeadOverdue(
        { ...oldLead, elapsedSeconds: metrics.elapsedSeconds, elapsedValue: metrics.elapsedValue, elapsedUnit: metrics.elapsedUnit },
        oneHourStageConfig,
        true,
        activatedTenMinsAgo
      );
      expect(isOverdueNow).toBe(false);

      // 3. Now suppose Spider was activated 2 hours ago (7200 seconds ago) for the same old lead:
      const activatedTwoHoursAgo = new Date(now - 2 * 3600 * 1000).toISOString();
      const overdueMetrics = resolveLeadStageAndElapsedTime(oldLead, activatedTwoHoursAgo);
      expect(overdueMetrics.elapsedSeconds).toBeGreaterThanOrEqual(7190);

      const isOverdueAfterTwoHours = isLeadOverdue(
        { ...oldLead, elapsedSeconds: overdueMetrics.elapsedSeconds, elapsedValue: overdueMetrics.elapsedValue, elapsedUnit: overdueMetrics.elapsedUnit },
        oneHourStageConfig,
        true,
        activatedTwoHoursAgo
      );
      expect(isOverdueAfterTwoHours).toBe(true);

      // 4. When Spider is deactivated (isActive = false), it never flags leads as overdue
      const isDeactivated = isLeadOverdue(
        { ...oldLead, elapsedSeconds: overdueMetrics.elapsedSeconds, elapsedValue: overdueMetrics.elapsedValue, elapsedUnit: overdueMetrics.elapsedUnit },
        oneHourStageConfig,
        false,
        activatedTwoHoursAgo
      );
      expect(isDeactivated).toBe(false);
    });



    it('renders Active status with Deactivate popover action and Deactivated static badge without Activate option on Spider page', () => {
      // Case 1: Active status
      useSpiderWatcherStore.setState({ isActive: true });
      const { unmount } = renderSpiderDetail(true);

      const activeBtn = screen.getByRole('button', { name: /Spider Status/i });
      expect(activeBtn).toBeInTheDocument();
      expect(activeBtn).toHaveTextContent('Active');

      // Click to open popover -> only "Deactivate" option is visible (no check icon)
      fireEvent.click(activeBtn);
      const deactivateAction = screen.getByRole('button', { name: /Deactivate/i });
      expect(deactivateAction).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^Activate$/i })).toBeNull();

      // Click Deactivate
      fireEvent.click(deactivateAction);
      expect(useSpiderWatcherStore.getState().isActive).toBe(false);
      unmount();

      // Case 2: Deactivated status -> static indicator without Activate option
      useSpiderWatcherStore.setState({ isActive: false });
      renderSpiderDetail(true);
      const deactivatedBadge = screen.getByLabelText('Spider Status');
      expect(deactivatedBadge).toHaveTextContent('Deactivated');
      expect(screen.queryByRole('button', { name: /Spider Status/i })).toBeNull();
      expect(screen.queryByText(/^Activate$/i)).toBeNull();
    });

    it('correctly filters leads for Select Contacts for Alert, only allowing New, Contacted, and Walkthrough Completed stages', () => {
      // 1. Test isLeadInAllowedAlertStage
      const newLead = { id: 'l-new', status: 'NEW' };
      const contactedLead = { id: 'l-cont', status: 'CONTACTED' };
      const wtScheduledLead = { id: 'l-wt-sched', status: 'CONTACTED', walkthrough_scheduled_at: new Date().toISOString() };
      const wtCompletedLead = { id: 'l-wt', status: 'CONTACTED', walkthrough_completed_at: new Date().toISOString() };
      const estimatedLead = { id: 'l-est', status: 'ESTIMATED', estimates: [{ id: 'e1' }] };
      const wonLead = { id: 'l-won', status: 'WON' };
      const lostLead = { id: 'l-lost', status: 'LOST' };
      const cancelledLead = { id: 'l-canc', status: 'CANCELLED' };

      expect(isLeadInAllowedAlertStage(newLead)).toBe(true);
      expect(isLeadInAllowedAlertStage(contactedLead)).toBe(true);
      expect(isLeadInAllowedAlertStage(wtScheduledLead)).toBe(false);
      expect(isLeadInAllowedAlertStage(wtCompletedLead)).toBe(true);
      expect(isLeadInAllowedAlertStage(estimatedLead)).toBe(false);
      expect(isLeadInAllowedAlertStage(wonLead)).toBe(false);
      expect(isLeadInAllowedAlertStage(lostLead)).toBe(false);
      expect(isLeadInAllowedAlertStage(cancelledLead)).toBe(false);

      // 2. Test buildWatcherCustomersFromLive filters out Estimate, Closed, and Walkthrough Scheduled leads
      const apiLeads = [
        { id: 'lead-new', lead_number: 'LD-1', status: 'NEW', customer_id: 'cust-1', customer: { id: 'cust-1', first_name: 'Alice' } },
        { id: 'lead-contacted', lead_number: 'LD-2', status: 'CONTACTED', customer_id: 'cust-1', customer: { id: 'cust-1', first_name: 'Alice' } },
        { id: 'lead-wt-sched', lead_number: 'LD-2B', status: 'CONTACTED', walkthrough_scheduled_at: new Date().toISOString(), customer_id: 'cust-1', customer: { id: 'cust-1', first_name: 'Alice' } },
        { id: 'lead-wt', lead_number: 'LD-3', status: 'CONTACTED', walkthrough_completed_at: new Date().toISOString(), customer_id: 'cust-2', customer: { id: 'cust-2', first_name: 'Bob' } },
        { id: 'lead-estimated', lead_number: 'LD-4', status: 'ESTIMATED', estimates: [{ id: 'e1' }], customer_id: 'cust-3', customer: { id: 'cust-3', first_name: 'Charlie' } },
        { id: 'lead-won', lead_number: 'LD-5', status: 'WON', customer_id: 'cust-4', customer: { id: 'cust-4', first_name: 'David' } },
      ];

      const watcherCustomers = buildWatcherCustomersFromLive(apiLeads, []);
      
      // Customer 1 has 2 qualifying leads (New, Contacted - excluding Walkthrough Scheduled)
      const c1 = watcherCustomers.find((c) => c.id === 'cust-1');
      expect(c1).toBeDefined();
      expect(c1!.leads.map((l) => l.id)).toEqual(['lead-new', 'lead-contacted']);

      // Customer 2 has 1 qualifying lead (Walkthrough Completed)
      const c2 = watcherCustomers.find((c) => c.id === 'cust-2');
      expect(c2).toBeDefined();
      expect(c2!.leads.map((l) => l.id)).toEqual(['lead-wt']);

      expect(watcherCustomers.find((c) => c.id === 'cust-3')).toBeUndefined();
      expect(watcherCustomers.find((c) => c.id === 'cust-4')).toBeUndefined();
    });

    it('ensures all leads in Select for Alerts remain unselected upon Spider deactivation and during background syncs', () => {
      // Initially active with selected leads
      useSpiderWatcherStore.setState({
        isActive: true,
        customers: TEST_CUSTOMERS,
        selectedCustomerIds: ['c1'],
        selectedLeadIds: ['l1', 'l2'],
        hasUserModifiedSelection: true,
      });

      // Deactivate Spider
      useSpiderWatcherStore.getState().deactivateSpider();

      const stateAfterDeactivation = useSpiderWatcherStore.getState();
      expect(stateAfterDeactivation.isActive).toBe(false);
      expect(stateAfterDeactivation.selectedCustomerIds).toEqual([]);
      expect(stateAfterDeactivation.selectedLeadIds).toEqual([]);

      // Simulate background refresh/sync of customers while deactivated
      useSpiderWatcherStore.getState().setCustomers(TEST_CUSTOMERS);

      const stateAfterCustomerSync = useSpiderWatcherStore.getState();
      // Should STILL remain unselected, not auto-select
      expect(stateAfterCustomerSync.selectedCustomerIds).toEqual([]);
      expect(stateAfterCustomerSync.selectedLeadIds).toEqual([]);

      // User manually selects a lead
      useSpiderWatcherStore.getState().toggleLeadSelection('l1', 'c1', ['l1', 'l2']);

      const stateAfterManualSelect = useSpiderWatcherStore.getState();
      expect(stateAfterManualSelect.selectedLeadIds).toEqual(['l1']);
      expect(stateAfterManualSelect.selectedCustomerIds).toEqual(['c1']);
    });

    it('toggles Auto-select new leads checkbox state between checked and unchecked', async () => {
      renderSpiderDetail(true);

      // Verify the auto-enroll checkbox is rendered and checked by default
      const autoEnrollCheckbox = await screen.findByRole('checkbox', {
        name: /auto-select new leads created during active spider session/i,
      });
      expect(autoEnrollCheckbox).toBeInTheDocument();
      expect(autoEnrollCheckbox).toHaveAttribute('data-state', 'checked');

      // Click to uncheck
      fireEvent.click(autoEnrollCheckbox);
      expect(autoEnrollCheckbox).toHaveAttribute('data-state', 'unchecked');

      // Click again to re-check
      fireEvent.click(autoEnrollCheckbox);
      expect(autoEnrollCheckbox).toHaveAttribute('data-state', 'checked');
    });

    it('does NOT auto-select newly arrived leads when autoEnrollAllLeads is false', () => {
      const now = new Date().toISOString();
      useSpiderWatcherStore.setState({
        isActive: true,
        activatedAt: now,
        autoEnrollAllLeads: false,
        customers: TEST_CUSTOMERS,
        selectedCustomerIds: ['c1'],
        selectedLeadIds: ['l1'],
        hasUserModifiedSelection: true,
      });

      // A new lead arrives during active session
      const updatedCustomers: WatcherCustomer[] = [
        ...TEST_CUSTOMERS,
        {
          id: 'cust-new',
          name: 'New Customer',
          leads: [
            {
              id: 'lead-new-8',
              leadNumber: 'LD-108',
              serviceRequest: 'New Service',
              serviceLocation: '123 Main St',
              stageId: 'new-contacted',
              stageLabel: 'New → Contacted',
              createdAt: new Date().toISOString(),
              status: 'NEW',
              elapsedValue: 0,
              elapsedUnit: 'Minute',
            },
          ],
        },
      ];

      useSpiderWatcherStore.getState().setCustomers(updatedCustomers);

      const state = useSpiderWatcherStore.getState();
      // Since autoEnrollAllLeads is false, lead-new-8 must NOT be in selectedLeadIds
      expect(state.selectedLeadIds).toEqual(['l1']);
      expect(state.selectedLeadIds).not.toContain('lead-new-8');
      expect(state.selectedCustomerIds).not.toContain('cust-new');

      // When autoEnrollAllLeads is true, newly arrived lead IS auto-selected
      useSpiderWatcherStore.setState({ autoEnrollAllLeads: true });
      const updatedCustomers2: WatcherCustomer[] = [
        ...updatedCustomers,
        {
          id: 'cust-new-2',
          name: 'Another Customer',
          leads: [
            {
              id: 'lead-new-9',
              leadNumber: 'LD-109',
              serviceRequest: 'Another Service',
              serviceLocation: '456 Elm St',
              stageId: 'new-contacted',
              stageLabel: 'New → Contacted',
              createdAt: new Date().toISOString(),
              status: 'NEW',
              elapsedValue: 0,
              elapsedUnit: 'Minute',
            },
          ],
        },
      ];

      useSpiderWatcherStore.getState().setCustomers(updatedCustomers2);
      const state2 = useSpiderWatcherStore.getState();
      expect(state2.selectedLeadIds).toContain('lead-new-9');
      expect(state2.selectedCustomerIds).toContain('cust-new-2');
    });

    it('traps keyboard focus within the slide-over preview drawer and restores focus on close (ACC-10)', async () => {
      vi.mocked(api.get).mockImplementation((url: string) => {
        if (typeof url === 'string' && url.includes('/api/ai-farm/spider/config')) {
          return Promise.resolve({ data: { ok: true, config: getMockSpiderConfig() } });
        }
        if (typeof url === 'string' && url.includes('/api/ai-farm/spider/logs')) {
          return Promise.resolve({
            data: {
              ok: true,
              records: [
                {
                  id: 'log-acc-1',
                  organization_id: 'org-1',
                  lead_id: 'l1',
                  lead_number: 'LD-101',
                  customer_name: 'John Smith',
                  stage_name: 'Contacted',
                  created_at: new Date().toISOString(),
                  channels: {
                    email: { enabled: true, status: 'SENT' },
                    sms: { enabled: true, status: 'SENT' },
                    inApp: { enabled: true, status: 'SENT' },
                  },
                  recipients: [{ name: 'Alex Morgan', email: 'alex@example.com' }],
                },
              ],
              total: 1,
            },
          });
        }
        return Promise.resolve({ data: {} });
      });

      renderSpiderDetail(true);

      // Switch to History tab
      const historyTabBtn = screen.getByRole('tab', { name: /History/i });
      fireEvent.click(historyTabBtn);

      // Find the preview button and click it
      const previewBtn = await screen.findByRole('button', { name: /Preview/i });
      previewBtn.focus();
      expect(document.activeElement).toBe(previewBtn);
      fireEvent.click(previewBtn);

      // Drawer dialog is rendered with role="dialog" and aria-modal="true"
      const dialog = await screen.findByRole('dialog', { name: /Delivered Message Preview/i });
      expect(dialog).toBeInTheDocument();
      expect(dialog).toHaveAttribute('aria-modal', 'true');

      // Wait for focus trap initial focus inside dialog
      await vi.waitFor(() => {
        expect(dialog.contains(document.activeElement)).toBe(true);
      });

      // Query focusables inside drawer
      const focusables = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => !el.hasAttribute('hidden') && el.style.display !== 'none' && el.style.visibility !== 'hidden');

      expect(focusables.length).toBeGreaterThan(1);
      const firstFocusable = focusables[0]!;
      const lastFocusable = focusables[focusables.length - 1]!;

      // Tab on the last element wraps focus back to the first element
      lastFocusable.focus();
      expect(document.activeElement).toBe(lastFocusable);
      fireEvent.keyDown(window, { key: 'Tab' });
      expect(document.activeElement).toBe(firstFocusable);

      // Shift+Tab on the first element wraps focus back to the last element
      firstFocusable.focus();
      expect(document.activeElement).toBe(firstFocusable);
      fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
      expect(document.activeElement).toBe(lastFocusable);

      // Pressing Escape closes drawer and restores focus to preview button
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByRole('dialog', { name: /Delivered Message Preview/i })).toBeNull();
      expect(document.activeElement).toBe(previewBtn);
    });
  });

  describe('Spider Query Error Handling & Visible Error States (Item #3)', () => {
    it('renders a visible error state with retry when leads or customers fail to load', async () => {
      vi.mocked(api.get).mockImplementation((url: string) => {
        if (typeof url === 'string' && url.includes('/api/ai-farm/spider/config')) {
          return Promise.resolve({ data: { ok: true, config: getMockSpiderConfig() } });
        }
        if (typeof url === 'string' && url.includes('/api/leads')) {
          return Promise.reject(new Error('Network error loading leads'));
        }
        if (typeof url === 'string' && url.includes('/api/customers')) {
          return Promise.reject(new Error('Network error loading customers'));
        }
        return Promise.resolve({ data: {} });
      });

      renderSpiderDetail(true);

      const errorText = await screen.findByText('Failed to load contacts and leads');
      expect(errorText).toBeInTheDocument();
      expect(screen.getByText(/Failed to load leads and customers from database/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Retry/i })).toBeInTheDocument();

      // Ensure it is NOT showing the legitimate empty search state
      expect(screen.queryByText('No contacts or leads found matching your search.')).toBeNull();
    });

    it('renders a visible error state with retry when history notification logs fail to load', async () => {
      vi.mocked(api.get).mockImplementation((url: string) => {
        if (typeof url === 'string' && url.includes('/api/ai-farm/spider/config')) {
          return Promise.resolve({ data: { ok: true, config: getMockSpiderConfig() } });
        }
        if (typeof url === 'string' && url.includes('/api/ai-farm/spider/logs')) {
          return Promise.reject(new Error('Internal database error'));
        }
        return Promise.resolve({ data: {} });
      });

      renderSpiderDetail(true);

      // Switch to History tab
      const historyTabBtn = screen.getByRole('tab', { name: /History/i });
      fireEvent.click(historyTabBtn);

      const errorHeader = await screen.findByText('Failed to load notification history');
      expect(errorHeader).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Retry/i })).toBeInTheDocument();

      // Ensure legitimate empty states are NOT shown
      expect(screen.queryByText('All Monitored Stage Leads are Healthy')).toBeNull();
      expect(screen.queryByText('No Historical Alert Logs')).toBeNull();
    });

    it('renders normal empty states when responses legitimately contain empty lists', async () => {
      useSpiderWatcherStore.setState({ customers: [] });
      vi.mocked(api.get).mockImplementation((url: string) => {
        if (typeof url === 'string' && url.includes('/api/ai-farm/spider/config')) {
          return Promise.resolve({ data: { ok: true, config: getMockSpiderConfig() } });
        }
        if (typeof url === 'string' && url.includes('/api/leads')) {
          return Promise.resolve({ data: { ok: true, leads: [] } });
        }
        if (typeof url === 'string' && url.includes('/api/customers')) {
          return Promise.resolve({ data: { ok: true, customers: [] } });
        }
        if (typeof url === 'string' && url.includes('/api/ai-farm/spider/logs')) {
          return Promise.resolve({ data: { ok: true, records: [], total: 0 } });
        }
        return Promise.resolve({ data: {} });
      });

      renderSpiderDetail(true);

      // Contact watchers legitimate empty state
      const emptyText = await screen.findByText('No contacts or leads found matching your search.');
      expect(emptyText).toBeInTheDocument();
      expect(screen.queryByText('Failed to load contacts and leads')).toBeNull();

      // Switch to History tab
      const historyTabBtn = screen.getByRole('tab', { name: /History/i });
      fireEvent.click(historyTabBtn);

      expect(screen.getByText(/All Monitored Stage Leads are Healthy|No Historical Alert Logs/i)).toBeInTheDocument();
      expect(screen.queryByText('Failed to load notification history')).toBeNull();
    });
  });
});


