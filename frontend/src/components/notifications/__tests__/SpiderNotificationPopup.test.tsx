import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SpiderNotificationPopup } from '../SpiderNotificationPopup';
import {
  useSpiderWatcherStore,
  formatHumanReadableTimeSpan,
  formatNotificationMessageReadableTime,
  formatSpiderDynamicStageDuration,
  formatSpiderStageSentence,
  type WatcherCustomer,
} from '@/stores/spiderWatcherStore';
import api from '@/lib/axios';

function renderWithClient(ui: React.ReactElement, client?: QueryClient) {
  const testClient =
    client ||
    new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
      },
    });
  return render(
    <QueryClientProvider client={testClient}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

const TEST_CUSTOMERS: WatcherCustomer[] = [
  {
    id: 'c1',
    name: 'John Smith',
    company: 'Apex Plumbing Co.',
    leads: [
      {
        id: 'l1',
        leadNumber: 'LD-101',
        serviceRequest: 'Main Line Leak',
        serviceLocation: '9462 Highland Ave, Suite 414, Paterson, NJ 07501',
        stageId: 'new-contacted',
        stageLabel: 'New → Contacted',
        elapsedValue: 4,
        elapsedUnit: 'Day',
        elapsedSeconds: 4 * 86400,
      },
      {
        id: 'l2',
        leadNumber: 'LD-102',
        serviceRequest: 'Water Heater',
        serviceLocation: '1048 Industrial Pkwy, Suite 300, Portland, OR 97201',
        stageId: 'contacted-walkthrough-scheduled',
        stageLabel: 'Contacted → Walkthrough Scheduled',
        elapsedValue: 6,
        elapsedUnit: 'Day',
        elapsedSeconds: 6 * 86400,
      },
      {
        id: 'l3',
        leadNumber: 'LD-103',
        serviceRequest: 'Valve Testing',
        serviceLocation: '520 Commercial St, Suite 100, Salem, OR 97301',
        stageId: 'walkthrough-completed-estimate',
        stageLabel: 'Walkthrough Completed → Estimate',
        elapsedValue: 12,
        elapsedUnit: 'Hour',
        elapsedSeconds: 12 * 3600,
      },
    ],
  },
];

describe('SpiderNotificationPopup', () => {
  beforeEach(() => {
    useSpiderWatcherStore.setState({
      isActive: true,
      activatedAt: new Date().toISOString(),
      autoEnrollAllLeads: true,
      notifications: { email: true, sms: true, inApp: true, redFrame: true },
      days: '0',
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
        {
          id: 'walkthrough-completed-estimate',
          label: 'Walkthrough Completed → Estimate',
          fromStage: 'Walkthrough Completed',
          toStage: 'Estimate',
          duration: 0,
          unit: 'Second',
        },
      ],
      customers: TEST_CUSTOMERS,
      selectedCustomerIds: ['c1'],
      selectedLeadIds: ['l1', 'l2', 'l3'],
      isRedBorderActive: false,
      activeNotificationId: null,
      isWindowOpen: true, // open panel to test dialog contents
      readNotificationIds: [],
    });
  });

  it('renders lower section pop-up box with Bell trigger icon when inApp is enabled and unread notifications exist for selected leads', () => {
    renderWithClient(<SpiderNotificationPopup />);

    // Bell trigger button exists
    expect(screen.getByRole('button', { name: /Spider notification/i })).toBeInTheDocument();

    // Dialog renders
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Spider Notifications')).toBeInTheDocument();
    expect(screen.getAllByText('John Smith').length).toBe(3); // one per notification item at the top row only

    // "Mark all read" and "Send Message" buttons are removed
    expect(screen.queryByText('Mark all read')).toBeNull();
    expect(screen.queryByText('Send Message')).toBeNull();

    // Displays Lead ID (e.g. 'LD-101', 'LD-102', 'LD-103') next to the contact name
    expect(screen.getByText('LD-101')).toBeInTheDocument();
    expect(screen.getByText('LD-102')).toBeInTheDocument();
    expect(screen.getByText('LD-103')).toBeInTheDocument();

    // Displays Stage (e.g. 'New', 'Contacted', 'Walkthrough Completed') after the Lead ID
    expect(screen.getAllByText('New').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Contacted').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Walkthrough Completed').length).toBeGreaterThan(0);

    // Displays complete service address for the lead
    expect(screen.getByText('9462 Highland Ave, Suite 414, Paterson, NJ 07501')).toBeInTheDocument();
    expect(screen.getByText('1048 Industrial Pkwy, Suite 300, Portland, OR 97201')).toBeInTheDocument();
    expect(screen.getByText('520 Commercial St, Suite 100, Salem, OR 97301')).toBeInTheDocument();

    // Stage-specific alert messages for all 3 stages
    expect(screen.getByText(/This lead was created 4 Days ago and has not yet been contacted/i)).toBeInTheDocument();
    expect(screen.getByText(/This lead was contacted 6 Days ago, but a walkthrough has not yet been scheduled/i)).toBeInTheDocument();
    expect(screen.getByText(/The walkthrough was completed 12 Hours ago, but an estimate has not yet been sent/i)).toBeInTheDocument();
    expect(screen.getByText('Need to contact')).toBeInTheDocument();
    expect(screen.getByText('Schedule walkthrough')).toBeInTheDocument();
    expect(screen.getByText('Send estimate')).toBeInTheDocument();
  });

  it('displays empty notification state when no customer or lead is selected and autoEnrollAllLeads is disabled', () => {
    useSpiderWatcherStore.getState().deselectAllCustomers();

    renderWithClient(<SpiderNotificationPopup />);

    // No notifications triggered, bell icon hidden
    expect(screen.queryByRole('button', { name: /Spider notification/i })).not.toBeInTheDocument();
  });

  it('automatically enrolls new incoming leads when autoEnrollAllLeads is active', () => {
    // Current 3 leads exist
    expect(useSpiderWatcherStore.getState().getComputedNotifications().length).toBe(3);

    // A brand new lead arrives in the system
    const newCustomer: WatcherCustomer = {
      id: 'c2',
      name: 'Sarah Jenkins',
      company: 'Jenkins HVAC',
      leads: [
        {
          id: 'l4',
          leadNumber: 'LD-104',
          serviceRequest: 'Emergency AC Repair',
          serviceLocation: '120 Broadway, New York, NY 10005',
          stageId: 'new-contacted',
          stageLabel: 'New → Contacted',
          elapsedValue: 15,
          elapsedUnit: 'Minute',
          elapsedSeconds: 15 * 60,
        },
      ],
    };

    useSpiderWatcherStore.getState().setCustomers([...TEST_CUSTOMERS, newCustomer]);

    // The new lead is automatically enrolled and triggers its notification without manual checkbox selection
    const updatedNotifs = useSpiderWatcherStore.getState().getComputedNotifications();
    expect(updatedNotifs.length).toBe(4);
    const newLeadNotif = updatedNotifs.find((n) => n.leadId === 'l4');
    expect(newLeadNotif).toBeDefined();
    expect(newLeadNotif?.contactName).toBe('Sarah Jenkins');
    expect(newLeadNotif?.leadStage).toBe('New');
  });

  it('automatically progresses across stage thresholds without being blocked by prior stage dismissal', () => {
    // Lead l1 starts in Stage 1: New -> Contacted
    const notifs1 = useSpiderWatcherStore.getState().getComputedNotifications();
    const l1Stage1 = notifs1.find((n) => n.leadId === 'l1');
    expect(l1Stage1).toBeDefined();
    expect(l1Stage1?.leadStage).toBe('New');

    // 1. User contacts lead l1 -> marks Stage 1 alert as read/resolved
    useSpiderWatcherStore.getState().markLeadNotificationsRead('l1', 'new-contacted');
    expect(useSpiderWatcherStore.getState().getComputedNotifications().find((n) => n.leadId === 'l1')).toBeUndefined();

    // 2. Lead l1 moves to Stage 2: Contacted -> Walkthrough Scheduled
    const updatedCustomer: WatcherCustomer = {
      id: 'c1',
      name: 'John Smith',
      company: 'Apex Plumbing Co.',
      leads: [
        {
          id: 'l1',
          leadNumber: 'LD-101',
          serviceRequest: 'Main Line Leak',
          serviceLocation: '9462 Highland Ave, Suite 414, Paterson, NJ 07501',
          stageId: 'contacted-walkthrough-scheduled',
          stageLabel: 'Contacted → Walkthrough Scheduled',
          status: 'CONTACTED',
          contactedAt: new Date(Date.now() - 10 * 86400 * 1000).toISOString(),
          elapsedValue: 10,
          elapsedUnit: 'Day',
          elapsedSeconds: 10 * 86400,
        },
        TEST_CUSTOMERS[0]!.leads[1]!,
        TEST_CUSTOMERS[0]!.leads[2]!,
      ],
    };

    useSpiderWatcherStore.getState().setCustomers([updatedCustomer]);

    // Stage 2 alert fires automatically for lead l1 because notification tracking is stage-scoped!
    const notifs2 = useSpiderWatcherStore.getState().getComputedNotifications();
    const l1Stage2 = notifs2.find((n) => n.leadId === 'l1');
    expect(l1Stage2).toBeDefined();
    expect(l1Stage2?.leadStage).toBe('Contacted');

    // 3. User schedules walkthrough -> marks Stage 2 alert resolved
    useSpiderWatcherStore.getState().markLeadNotificationsRead('l1', 'contacted-walkthrough-scheduled');
    expect(useSpiderWatcherStore.getState().getComputedNotifications().find((n) => n.leadId === 'l1')).toBeUndefined();

    // 4. Walkthrough completed -> moves to Stage 3: Walkthrough Completed -> Estimate
    const completedCustomer: WatcherCustomer = {
      id: 'c1',
      name: 'John Smith',
      company: 'Apex Plumbing Co.',
      leads: [
        {
          id: 'l1',
          leadNumber: 'LD-101',
          serviceRequest: 'Main Line Leak',
          serviceLocation: '9462 Highland Ave, Suite 414, Paterson, NJ 07501',
          stageId: 'walkthrough-completed-estimate',
          stageLabel: 'Walkthrough Completed → Estimate',
          status: 'WALKTHROUGH_COMPLETED',
          walkthroughCompletedAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
          elapsedValue: 2,
          elapsedUnit: 'Hour',
          elapsedSeconds: 2 * 3600,
        },
        TEST_CUSTOMERS[0]!.leads[1]!,
        TEST_CUSTOMERS[0]!.leads[2]!,
      ],
    };

    useSpiderWatcherStore.getState().setCustomers([completedCustomer]);

    // Stage 3 alert fires automatically for lead l1!
    const notifs3 = useSpiderWatcherStore.getState().getComputedNotifications();
    const l1Stage3 = notifs3.find((n) => n.leadId === 'l1');
    expect(l1Stage3).toBeDefined();
    expect(l1Stage3?.leadStage).toBe('Walkthrough Completed');
  });

  it('immediately starts counting from stage transition time and only triggers popup once full threshold elapses', () => {
    // Set 10-minute thresholds for all 3 stages
    useSpiderWatcherStore.setState({
      isActive: true,
      activatedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(), // Activated 30 mins ago
      leadStages: [
        { id: 'new-contacted', label: 'New → Contacted', fromStage: 'New', toStage: 'Contacted', duration: 10, unit: 'Minute', enabled: true },
        { id: 'contacted-walkthrough-scheduled', label: 'Contacted → Walkthrough Scheduled', fromStage: 'Contacted', toStage: 'Walkthrough Scheduled', duration: 10, unit: 'Minute', enabled: true },
        { id: 'walkthrough-completed-estimate', label: 'Walkthrough Completed → Estimate', fromStage: 'Walkthrough Completed', toStage: 'Estimate', duration: 10, unit: 'Minute', enabled: true },
      ],
      selectedLeadIds: ['lead-stage-test'],
      selectedCustomerIds: ['cust-stage-test'],
      readNotificationIds: [],
    });

    const initialCustomer: WatcherCustomer = {
      id: 'cust-stage-test',
      name: 'Stage Transition Customer',
      leads: [
        {
          id: 'lead-stage-test',
          leadNumber: 'LD-999',
          stageId: 'new-contacted',
          stageLabel: 'New → Contacted',
          status: 'NEW',
          createdAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
          elapsedValue: 15,
          elapsedUnit: 'Minute',
        },
      ],
    };

    useSpiderWatcherStore.getState().setCustomers([initialCustomer]);

    // In New stage, 15 mins > 10 min threshold -> popup triggered
    expect(useSpiderWatcherStore.getState().getComputedNotifications().length).toBe(1);

    // Now transition the lead to CONTACTED stage right now
    const transitionedCustomer: WatcherCustomer = {
      id: 'cust-stage-test',
      name: 'Stage Transition Customer',
      leads: [
        {
          id: 'lead-stage-test',
          leadNumber: 'LD-999',
          stageId: 'contacted-walkthrough-scheduled',
          stageLabel: 'Contacted → Walkthrough Scheduled',
          status: 'CONTACTED',
          contactedAt: new Date().toISOString(), // Transitioned just now
          elapsedValue: 0,
          elapsedUnit: 'Second',
        },
      ],
    };

    useSpiderWatcherStore.getState().setCustomers([transitionedCustomer]);

    // Immediately upon transition: elapsed time is 0 mins < 10 mins threshold -> NO notification triggered yet!
    const notifsImmediately = useSpiderWatcherStore.getState().getComputedNotifications();
    expect(notifsImmediately.find((n) => n.leadId === 'lead-stage-test')).toBeUndefined();

    // After 11 minutes elapse on the Contacted stage
    const overdueCustomer: WatcherCustomer = {
      id: 'cust-stage-test',
      name: 'Stage Transition Customer',
      leads: [
        {
          id: 'lead-stage-test',
          leadNumber: 'LD-999',
          stageId: 'contacted-walkthrough-scheduled',
          stageLabel: 'Contacted → Walkthrough Scheduled',
          status: 'CONTACTED',
          contactedAt: new Date(Date.now() - 11 * 60 * 1000).toISOString(), // 11 mins ago
          elapsedValue: 11,
          elapsedUnit: 'Minute',
        },
      ],
    };

    useSpiderWatcherStore.getState().setCustomers([overdueCustomer]);

    // Now threshold has elapsed -> popup notification triggers!
    const notifsAfterThreshold = useSpiderWatcherStore.getState().getComputedNotifications();
    const alert = notifsAfterThreshold.find((n) => n.leadId === 'lead-stage-test');
    expect(alert).toBeDefined();
    expect(alert?.leadStage).toBe('Contacted');
  });

  it('does not auto-select pre-existing new stage leads on refresh, but auto-selects leads created after activation', () => {
    const activationTime = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // Activated 1 hr ago

    // Reset store to simulate fresh page load while Spider is active
    useSpiderWatcherStore.setState({
      isActive: true,
      activatedAt: activationTime,
      autoEnrollAllLeads: true,
      customers: [],
      selectedCustomerIds: [],
      selectedLeadIds: [],
      hasUserModifiedSelection: false,
    });

    const mockCustomers: WatcherCustomer[] = [
      {
        id: 'cust-old',
        name: 'Pre-existing Customer',
        leads: [
          {
            id: 'lead-pre-existing',
            leadNumber: 'LD-OLD',
            stageId: 'new-contacted',
            stageLabel: 'New → Contacted',
            status: 'NEW',
            createdAt: new Date(Date.now() - 5 * 86400 * 1000).toISOString(), // Created 5 days ago (BEFORE activation)
            elapsedValue: 5,
            elapsedUnit: 'Day',
          },
        ],
      },
      {
        id: 'cust-new',
        name: 'Active Session Customer',
        leads: [
          {
            id: 'lead-active-session',
            leadNumber: 'LD-NEW',
            stageId: 'new-contacted',
            stageLabel: 'New → Contacted',
            status: 'NEW',
            createdAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(), // Created 15 mins ago (AFTER activation)
            elapsedValue: 15,
            elapsedUnit: 'Minute',
          },
        ],
      },
    ];

    // Simulate page refresh / API sync populating customers
    useSpiderWatcherStore.getState().setCustomers(mockCustomers);

    const state = useSpiderWatcherStore.getState();

    // The pre-existing lead created before activation is NOT auto-selected
    expect(state.selectedLeadIds).not.toContain('lead-pre-existing');
    expect(state.selectedCustomerIds).not.toContain('cust-old');

    // The new lead created during active Spider session IS auto-selected
    expect(state.selectedLeadIds).toContain('lead-active-session');
    expect(state.selectedCustomerIds).toContain('cust-new');

    // Only the post-activation lead triggers a notification
    const notifs = state.getComputedNotifications();
    expect(notifs.find((n) => n.leadId === 'lead-pre-existing')).toBeUndefined();
    expect(notifs.find((n) => n.leadId === 'lead-active-session')).toBeDefined();
  });

  it('clicking a notification activates indicator and selects it, and calls markRead API for server-persisted notifications', async () => {
    const patchSpy = vi.spyOn(api, 'patch').mockResolvedValue({ data: { ok: true } });

    renderWithClient(<SpiderNotificationPopup />);

    const initialNotifs = useSpiderWatcherStore.getState().getComputedNotifications();
    expect(initialNotifs.length).toBeGreaterThan(0);
    const targetNotif = initialNotifs[0]!;

    const card = screen.getAllByText(targetNotif.contactName)[0]?.closest('div[class*="cursor-pointer"]');
    expect(card).not.toBeNull();
    fireEvent.click(card!);

    const state = useSpiderWatcherStore.getState();
    expect(state.isRedBorderActive).toBe(true);
    expect(state.activeNotificationId).toBe(targetNotif.id);

    patchSpy.mockRestore();
  });

  it('marking lead notifications as read removes the notification from list', () => {
    const initialNotifs = useSpiderWatcherStore.getState().getComputedNotifications();
    expect(initialNotifs.length).toBe(3);

    // Simulate successful message dispatch to lead l1
    useSpiderWatcherStore.getState().markLeadNotificationsRead('l1');

    const remaining = useSpiderWatcherStore.getState().getComputedNotifications();
    expect(remaining.length).toBe(2);
    expect(remaining.find((n) => n.leadId === 'l1')).toBeUndefined();
  });

  it('marking lead notifications as read on scheduling walkthrough removes Contacted lead notification', () => {
    const initialNotifs = useSpiderWatcherStore.getState().getComputedNotifications();
    const contactedNotif = initialNotifs.find((n) => n.leadStage === 'Contacted');
    expect(contactedNotif).toBeDefined();

    // Mark as read by lead number (e.g. LD-102) or leadId
    useSpiderWatcherStore.getState().markLeadNotificationsRead(contactedNotif!.leadNumber!);

    const remaining = useSpiderWatcherStore.getState().getComputedNotifications();
    expect(remaining.find((n) => n.leadId === contactedNotif!.leadId)).toBeUndefined();
  });

  it('keeps icon completely hidden when unreadCount is 0 or all notifications are read', () => {
    const allNotifs = useSpiderWatcherStore.getState().getComputedNotifications();
    useSpiderWatcherStore.setState({
      readNotificationIds: allNotifs.map((n) => n.id),
    });

    const { container } = renderWithClient(<SpiderNotificationPopup />);

    // No button or popup should render
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole('button', { name: /Spider notification/i })).not.toBeInTheDocument();
  });

  it('renders server-persisted unread notification and keeps it visible even when Spider is deactivated', () => {
    // 1. Configure queryClient cache with a server-persisted spider.alert notification
    const testClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    testClient.setQueryData(['notifications', { needsAction: false, verb: 'spider.alert', unread: true, limit: 'all' }], {
      pages: [
        {
          items: [
            {
              id: 'server-notif-uuid-1',
              verb: 'spider.alert',
              category: 'LEAD',
              priority: 'INTERRUPT',
              needs_action: false,
              title: 'Spider Alert - Acme Corp (LD-500)',
              body: 'This lead was created 3 Days ago and has not yet been contacted.',
              object_type: 'LEAD',
              object_id: 'lead-uuid-500',
              object_label: 'LD-500',
              action_type: null,
              data: {
                lead_id: 'lead-uuid-500',
                lead_number: 'LD-500',
                customer_name: 'Acme Corp',
                stage_name: 'New',
                time_in_stage: '3 Days',
                service_location: '123 Main St, Springfield, IL 62701',
              },
              created_at: new Date(Date.now() - 3600 * 1000).toISOString(),
              seen_at: null,
              read_at: null, // UNREAD
              acted_at: null,
            },
          ],
          nextCursor: null,
        },
      ],
      pageParams: [undefined],
    });

    // 2. Deactivate Spider in store
    useSpiderWatcherStore.setState({
      isActive: false,
      activatedAt: null,
      customers: [],
      selectedLeadIds: [],
      isWindowOpen: true,
    });

    // 3. Render popup while Spider is deactivated
    renderWithClient(<SpiderNotificationPopup />, testClient);

    // Persisted unread notification from DB is still visible!
    expect(screen.getByRole('button', { name: /Spider notification/i })).toBeInTheDocument();
    expect(screen.getByText('Spider Notifications')).toBeInTheDocument();
    expect(screen.getByText('Acme Corp')).toBeInTheDocument();
    expect(screen.getByText('LD-500')).toBeInTheDocument();
  });

  it('clicking a server-persisted notification does NOT mark read on click (remains UNREAD until stage action succeeds)', async () => {
    const patchSpy = vi.spyOn(api, 'patch').mockResolvedValue({ data: { ok: true } });

    const testClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    testClient.setQueryData(['notifications', { needsAction: false, verb: 'spider.alert', unread: true, limit: 'all' }], {
      pages: [
        {
          items: [
            {
              id: 'server-notif-uuid-1',
              verb: 'spider.alert',
              category: 'LEAD',
              priority: 'INTERRUPT',
              needs_action: false,
              title: 'Spider Alert - Acme Corp (LD-500)',
              body: 'This lead was created 3 Days ago and has not yet been contacted.',
              object_type: 'LEAD',
              object_id: 'lead-uuid-500',
              object_label: 'LD-500',
              action_type: null,
              data: {
                lead_id: 'lead-uuid-500',
                lead_number: 'LD-500',
                customer_name: 'Acme Corp',
                stage_name: 'New',
                time_in_stage: '3 Days',
                service_location: '123 Main St, Springfield, IL 62701',
              },
              created_at: new Date(Date.now() - 3600 * 1000).toISOString(),
              seen_at: null,
              read_at: null, // UNREAD
              acted_at: null,
            },
          ],
          nextCursor: null,
        },
      ],
      pageParams: [undefined],
    });

    useSpiderWatcherStore.setState({
      isActive: false,
      activatedAt: null,
      customers: [],
      selectedLeadIds: [],
      isWindowOpen: true,
    });

    renderWithClient(<SpiderNotificationPopup />, testClient);

    const card = screen.getByText('Acme Corp').closest('div[role="button"]');
    expect(card).not.toBeNull();
    fireEvent.click(card!);

    // Verified: clicking a non-Estimate notification leaves it unread (no patch call)
    expect(patchSpy).not.toHaveBeenCalled();

    patchSpy.mockRestore();
  });

  it('Case 1: when lead is in Estimate stage, clicking notification immediately marks it as read and updates DB', async () => {
    const patchSpy = vi.spyOn(api, 'patch').mockResolvedValue({ data: { ok: true } });

    const testClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    testClient.setQueryData(['notifications', { needsAction: false, verb: 'spider.alert', unread: true, limit: 'all' }], {
      pages: [
        {
          items: [
            {
              id: 'server-notif-estimate-1',
              verb: 'spider.alert',
              category: 'LEAD',
              priority: 'INTERRUPT',
              needs_action: false,
              title: 'Spider Alert - Estimate Lead (LD-700)',
              body: 'The walkthrough was completed 3 minutes ago, but an estimate has not yet been sent.',
              object_type: 'LEAD',
              object_id: 'lead-uuid-700',
              object_label: 'LD-700',
              action_type: null,
              data: {
                lead_id: 'lead-uuid-700',
                lead_number: 'LD-700',
                customer_name: 'Estimate Client',
                stage_name: 'Estimate',
                service_location: '789 Pine St, Portland, OR 97201',
              },
              created_at: new Date().toISOString(),
              seen_at: null,
              read_at: null, // UNREAD
              acted_at: null,
            },
          ],
          nextCursor: null,
        },
      ],
      pageParams: [undefined],
    });

    useSpiderWatcherStore.setState({
      isActive: true,
      activatedAt: new Date().toISOString(),
      customers: [],
      selectedLeadIds: [],
      isWindowOpen: true,
      readNotificationIds: [],
    });

    renderWithClient(<SpiderNotificationPopup />, testClient);

    const card = screen.getByText('Estimate Client').closest('div[role="button"]');
    expect(card).not.toBeNull();
    fireEvent.click(card!);

    // Verified: clicking while in Estimate stage immediately calls markRead API endpoint
    expect(patchSpy).toHaveBeenCalledWith('/api/notifications/server-notif-estimate-1/read');

    patchSpy.mockRestore();
  });

  it('displays all unread notifications without 25-limit cap and reflects accurate unread total (e.g. 80 items)', () => {
    const testClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });

    // 80 unread server notifications
    const items = Array.from({ length: 80 }, (_, i) => ({
      id: `server-notif-${i + 1}`,
      verb: 'spider.alert',
      category: 'LEAD',
      priority: 'INTERRUPT',
      needs_action: false,
      title: `Spider Alert - Company ${i + 1} (LD-${100 + i})`,
      body: 'Overdue lead',
      object_type: 'LEAD',
      object_id: `lead-${i + 1}`,
      object_label: `LD-${100 + i}`,
      action_type: null,
      data: {
        lead_id: `lead-${i + 1}`,
        lead_number: `LD-${100 + i}`,
        customer_name: `Company ${i + 1}`,
        stage_name: 'New',
        time_in_stage: '3 Days',
        service_location: 'Paterson, NJ',
      },
      created_at: new Date(Date.now() - (i + 1) * 60 * 1000).toISOString(),
      seen_at: null,
      read_at: null,
      acted_at: null,
    }));

    testClient.setQueryData(['notifications', { needsAction: false, verb: 'spider.alert', unread: true, limit: 'all' }], {
      pages: [{ items, nextCursor: null }],
      pageParams: [undefined],
    });

    useSpiderWatcherStore.setState({
      isActive: true,
      activatedAt: new Date().toISOString(),
      customers: [],
      selectedLeadIds: [],
      isWindowOpen: true,
    });

    renderWithClient(<SpiderNotificationPopup />, testClient);

    // Popup shows exact total 80 awaiting
    expect(screen.getByText('80 Awaiting')).toBeInTheDocument();
    // Verifies items are not truncated at 25
    expect(screen.getByText('Company 1')).toBeInTheDocument();
    expect(screen.getByText('Company 80')).toBeInTheDocument();
  });

  it('formats elapsed time into human-readable multi-unit strings across all thresholds', () => {
    // 20 minutes
    expect(formatHumanReadableTimeSpan(20 * 60)).toBe('20 minutes');

    // 2 hours 15 minutes
    expect(formatHumanReadableTimeSpan(2 * 3600 + 15 * 60)).toBe('2 hours 15 minutes');

    // 1 day 5 hours 20 minutes
    expect(formatHumanReadableTimeSpan(86400 + 5 * 3600 + 20 * 60)).toBe('1 day 5 hours 20 minutes');

    // 3 days 2 hours
    expect(formatHumanReadableTimeSpan(3 * 86400 + 2 * 3600)).toBe('3 days 2 hours');

    // 2 months 5 days
    expect(formatHumanReadableTimeSpan((2 * 30 + 5) * 86400)).toBe('2 months 5 days');

    // 1 year 2 months
    expect(formatHumanReadableTimeSpan((365 + 60) * 86400)).toBe('1 year 2 months');

    // 15773 minutes -> 10 days 22 hours 53 minutes
    expect(formatHumanReadableTimeSpan(15773 * 60)).toBe('10 days 22 hours 53 minutes');
  });

  it('converts raw minutes in server-persisted notification messages to human-readable format', () => {
    const rawMsg =
      'This lead was contacted 15773 Minutes ago, but a walkthrough has not yet been scheduled.';
    const formatted = formatNotificationMessageReadableTime(rawMsg);
    expect(formatted).toBe(
      'This lead was contacted 10 days 22 hours ago, but a walkthrough has not yet been scheduled.'
    );
  });

  it('renders human-readable elapsed time in the popup message card for 15773 minutes', () => {
    const testClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });

    testClient.setQueryData(
      ['notifications', { needsAction: false, verb: 'spider.alert', unread: true, limit: 'all' }],
      {
        pages: [
          {
            items: [
              {
                id: 'notif-15773-min',
                verb: 'spider.alert',
                category: 'LEAD',
                priority: 'INTERRUPT',
                needs_action: false,
                title: 'Spider Alert - Apex Plumbing (LD-101)',
                body: 'This lead was contacted 15773 Minutes ago, but a walkthrough has not yet been scheduled.',
                object_type: 'LEAD',
                object_id: 'lead-101',
                object_label: 'LD-101',
                action_type: null,
                data: {
                  lead_id: 'lead-101',
                  lead_number: 'LD-101',
                  customer_name: 'Apex Plumbing',
                  stage_name: 'Contacted',
                  time_in_stage: '15773 Minutes',
                  service_location: 'Paterson, NJ',
                },
                created_at: new Date().toISOString(),
                seen_at: null,
                read_at: null,
                acted_at: null,
              },
            ],
            nextCursor: null,
          },
        ],
        pageParams: [undefined],
      }
    );

    useSpiderWatcherStore.setState({
      isActive: true,
      activatedAt: new Date().toISOString(),
      customers: [],
      selectedLeadIds: [],
      isWindowOpen: true,
    });

    renderWithClient(<SpiderNotificationPopup />, testClient);

    // Verify converted message appears in popup using days + hours only ("10 days 22 hours ago")
    expect(
      screen.getByText(/This lead was contacted 10 days 22 hours ago/i)
    ).toBeInTheDocument();
    expect(screen.queryByText(/15773 Minutes ago/)).not.toBeInTheDocument();
    expect(screen.queryByText(/53 minutes/)).not.toBeInTheDocument();
  });

  it('displays stage elapsed time using the 3 exact display rules (<1h: minutes only, 1h-24h: hours+min, >=24h: days+hours only)', () => {
    const testClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });

    // 1. Minutes (< 1 hour): 59m 40s ago -> "59 minutes ago"
    const min59Timestamp = new Date(Date.now() - (59 * 60 + 40) * 1000).toISOString();
    // 2. Hours (1 hr to < 1 day): 2h 45m ago -> "2 hours 45 min ago"
    const hour2Timestamp = new Date(Date.now() - (2 * 3600 + 45 * 60) * 1000).toISOString();
    // 3. Days (>= 1 day): 10d 22h 53m ago -> "10 days 22 hours ago" (minutes completely ignored)
    const day10Timestamp = new Date(Date.now() - (10 * 86400 + 22 * 3600 + 53 * 60) * 1000).toISOString();

    testClient.setQueryData(
      ['notifications', { needsAction: false, verb: 'spider.alert', unread: true, limit: 'all' }],
      {
        pages: [
          {
            items: [
              {
                id: 'notif-lead-min',
                verb: 'spider.alert',
                category: 'LEAD',
                title: 'Spider Alert - Lead Min (LD-001)',
                body: 'This lead was created 59 minutes ago and has not yet been contacted.',
                object_type: 'LEAD',
                object_id: 'lead-001',
                object_label: 'LD-001',
                data: {
                  lead_id: 'lead-001',
                  lead_number: 'LD-001',
                  customer_name: 'Customer Min',
                  stage_name: 'New',
                  stage_entered_at: min59Timestamp,
                },
                created_at: new Date().toISOString(),
                seen_at: null,
                read_at: null,
              },
              {
                id: 'notif-lead-hr',
                verb: 'spider.alert',
                category: 'LEAD',
                title: 'Spider Alert - Lead Hr (LD-002)',
                body: 'This lead was contacted 2 hours 45 min ago, but a walkthrough has not yet been scheduled.',
                object_type: 'LEAD',
                object_id: 'lead-002',
                object_label: 'LD-002',
                data: {
                  lead_id: 'lead-002',
                  lead_number: 'LD-002',
                  customer_name: 'Customer Hr',
                  stage_name: 'Contacted',
                  stage_entered_at: hour2Timestamp,
                },
                created_at: new Date().toISOString(),
                seen_at: null,
                read_at: null,
              },
              {
                id: 'notif-lead-day',
                verb: 'spider.alert',
                category: 'LEAD',
                title: 'Spider Alert - Lead Day (LD-003)',
                body: 'The walkthrough was completed 10 days 22 hours ago, but an estimate has not yet been sent.',
                object_type: 'LEAD',
                object_id: 'lead-003',
                object_label: 'LD-003',
                data: {
                  lead_id: 'lead-003',
                  lead_number: 'LD-003',
                  customer_name: 'Customer Day',
                  stage_name: 'Walkthrough Completed',
                  stage_entered_at: day10Timestamp,
                },
                created_at: new Date().toISOString(),
                seen_at: null,
                read_at: null,
              },
            ],
            nextCursor: null,
          },
        ],
        pageParams: [undefined],
      }
    );

    useSpiderWatcherStore.setState({
      isActive: true,
      activatedAt: new Date().toISOString(),
      customers: [],
      selectedLeadIds: [],
      isWindowOpen: true,
    });

    renderWithClient(<SpiderNotificationPopup />, testClient);

    // Rule 1: < 1 hour shows only minutes ("59 minutes ago")
    expect(screen.getByText(/This lead was created 59 minutes ago and has not yet been contacted/i)).toBeInTheDocument();

    // Rule 2: 1 hour to < 1 day shows hours + minutes as "min" ("2 hours 45 min ago")
    expect(screen.getByText(/This lead was contacted 2 hours 45 min ago, but a walkthrough has not yet been scheduled/i)).toBeInTheDocument();

    // Rule 3: >= 1 day shows only days + hours ("10 days 22 hours ago", completely ignoring minutes)
    expect(screen.getByText(/The walkthrough was completed 10 days 22 hours ago, but an estimate has not yet been sent/i)).toBeInTheDocument();
    expect(screen.queryByText(/53 minutes/)).not.toBeInTheDocument();

    // Existing action buttons are preserved
    expect(screen.getByText('Need to contact')).toBeInTheDocument();
    expect(screen.getByText('Schedule walkthrough')).toBeInTheDocument();
    expect(screen.getByText('Send estimate')).toBeInTheDocument();
  });

  it('renders "See more" for long notification messages and toggles expansion on click', () => {
    const testClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });

    const longSentence =
      'This lead was contacted 10 days ago, but a walkthrough has not yet been scheduled. Please follow up with the customer and schedule the walkthrough when appropriate.';

    testClient.setQueryData(
      ['notifications', { needsAction: false, verb: 'spider.alert', unread: true, limit: 'all' }],
      {
        pages: [
          {
            items: [
              {
                id: 'notif-long-msg',
                verb: 'spider.alert',
                category: 'LEAD',
                title: 'Spider Alert - Long Message (LD-999)',
                body: longSentence,
                object_type: 'LEAD',
                object_id: 'lead-999',
                object_label: 'LD-999',
                data: {
                  lead_id: 'lead-999',
                  lead_number: 'LD-999',
                  customer_name: 'Long Message Customer',
                  stage_name: 'Contacted',
                  message: longSentence,
                },
                created_at: new Date().toISOString(),
                seen_at: null,
                read_at: null,
              },
            ],
            nextCursor: null,
          },
        ],
        pageParams: [undefined],
      }
    );

    useSpiderWatcherStore.setState({
      isActive: true,
      activatedAt: new Date().toISOString(),
      customers: [],
      selectedLeadIds: [],
      isWindowOpen: true,
    });

    renderWithClient(<SpiderNotificationPopup />, testClient);

    // Initial state: truncated preview with "See more" button
    const seeMoreBtn = screen.getByRole('button', { name: 'See more' });
    expect(seeMoreBtn).toBeInTheDocument();

    // Click "See more" -> expands and shows full text and "See less"
    fireEvent.click(seeMoreBtn);
    expect(screen.getByText(new RegExp('schedule the walkthrough when appropriate', 'i'))).toBeInTheDocument();
    const seeLessBtn = screen.getByRole('button', { name: 'See less' });
    expect(seeLessBtn).toBeInTheDocument();

    // Click "See less" -> collapses back
    fireEvent.click(seeLessBtn);
    expect(screen.getByRole('button', { name: 'See more' })).toBeInTheDocument();

    // Existing action button "Schedule walkthrough" is preserved
    expect(screen.getByText('Schedule walkthrough')).toBeInTheDocument();
  });

  it('dynamically computes stage sentence from stage_entered_at timestamp for Walkthrough Completed lead', () => {
    const testClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });

    const threeMinutesAgo = new Date(Date.now() - 3 * 60 * 1000).toISOString();

    testClient.setQueryData(
      ['notifications', { needsAction: false, verb: 'spider.alert', unread: true, limit: 'all' }],
      {
        pages: [
          {
            items: [
              {
                id: 'notif-wt-dynamic',
                verb: 'spider.alert',
                category: 'LEAD',
                priority: 'INTERRUPT',
                needs_action: false,
                title: 'Spider Alert - Laura Sanchez (LD-202)',
                body: 'The walkthrough was completed 3 minutes ago, but an estimate has not yet been sent.',
                object_type: 'LEAD',
                object_id: 'lead-202',
                object_label: 'LD-202',
                action_type: null,
                data: {
                  lead_id: 'lead-202',
                  lead_number: 'LD-202',
                  customer_name: 'Laura Sanchez',
                  stage_name: 'Walkthrough Completed',
                  stage_entered_at: threeMinutesAgo,
                  time_in_stage: '3 minutes',
                  service_location: 'Portland, OR',
                },
                created_at: new Date(Date.now() - 170 * 60 * 1000).toISOString(), // 2h 50m ago for top time
                seen_at: null,
                read_at: null,
                acted_at: null,
              },
            ],
            nextCursor: null,
          },
        ],
        pageParams: [undefined],
      }
    );

    useSpiderWatcherStore.setState({
      isActive: true,
      activatedAt: new Date().toISOString(),
      customers: [],
      selectedLeadIds: [],
      isWindowOpen: true,
    });

    renderWithClient(<SpiderNotificationPopup />, testClient);

    // Dynamic stage sentence is generated from stage_entered_at
    expect(
      screen.getByText(/The walkthrough was completed 3 minutes ago, but an estimate has not yet been sent/i)
    ).toBeInTheDocument();

    // Top notification time (2 hours 50 minutes ago) is separate and preserved
    expect(screen.getByText(/2 hours 50 minutes ago/i)).toBeInTheDocument();
  });

  it('formats exact stage time display rules and natural sentence wording across all scenarios', () => {

    // Scenario A: Less than 1 hour (< 3600 seconds) -> minutes only, spelled out
    expect(formatSpiderDynamicStageDuration(60)).toBe('1 minute');
    expect(formatSpiderDynamicStageDuration(5 * 60)).toBe('5 minutes');
    expect(formatSpiderDynamicStageDuration(35 * 60)).toBe('35 minutes');
    expect(formatSpiderDynamicStageDuration(45 * 60)).toBe('45 minutes');

    // Scenario B: 1 hour or more, but less than 1 day -> hours + min (not spelled out)
    expect(formatSpiderDynamicStageDuration(3600 + 10 * 60)).toBe('1 hour 10 min');
    expect(formatSpiderDynamicStageDuration(5 * 3600 + 25 * 60)).toBe('5 hours 25 min');
    expect(formatSpiderDynamicStageDuration(23 * 3600 + 45 * 60)).toBe('23 hours 45 min');
    expect(formatSpiderDynamicStageDuration(3600)).toBe('1 hour');

    // Scenario C: 1 day or more -> days + hours only (minutes completely ignored)
    expect(formatSpiderDynamicStageDuration(86400)).toBe('1 day');
    expect(formatSpiderDynamicStageDuration(86400 + 5 * 3600)).toBe('1 day 5 hours');
    expect(formatSpiderDynamicStageDuration(10 * 86400 + 22 * 3600 + 53 * 60)).toBe('10 days 22 hours');

    // Natural sentence wording
    const shortSentence = formatSpiderStageSentence({
      stageLabelOrId: 'contacted',
      timeElapsedStr: formatSpiderDynamicStageDuration(35 * 60),
    });
    expect(shortSentence).toBe('This lead was contacted 35 minutes ago, but a walkthrough has not yet been scheduled.');

    const hoursSentence = formatSpiderStageSentence({
      stageLabelOrId: 'contacted',
      timeElapsedStr: formatSpiderDynamicStageDuration(5 * 3600 + 25 * 60),
    });
    expect(hoursSentence).toBe('This lead was contacted 5 hours 25 min ago, but a walkthrough has not yet been scheduled.');

    const daysSentence = formatSpiderStageSentence({
      stageLabelOrId: 'contacted',
      timeElapsedStr: formatSpiderDynamicStageDuration(10 * 86400 + 22 * 3600 + 53 * 60),
    });
    expect(daysSentence).toBe('This lead was contacted 10 days 22 hours ago, but a walkthrough has not yet been scheduled.');
  });

  it('clicking a New stage notification redirects the user to the communication tab for that lead', () => {
    const testClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });

    testClient.setQueryData(
      ['notifications', { needsAction: false, verb: 'spider.alert', unread: true, limit: 'all' }],
      {
        pages: [
          {
            items: [
              {
                id: 'notif-new-lead-1',
                verb: 'spider.alert',
                category: 'LEAD',
                title: 'Spider Alert - Jane Doe (LD-101)',
                body: 'This lead was created 2 hours ago and has not yet been contacted.',
                object_type: 'LEAD',
                object_id: 'lead-uuid-new-1',
                object_label: 'LD-101',
                data: {
                  lead_id: 'lead-uuid-new-1',
                  lead_number: 'LD-101',
                  customer_name: 'Jane Doe',
                  stage_name: 'New',
                  service_request: 'Leak Repair',
                  service_location: '123 Main St, NJ',
                },
                created_at: new Date().toISOString(),
                seen_at: null,
                read_at: null,
              },
            ],
            nextCursor: null,
          },
        ],
        pageParams: [undefined],
      }
    );

    useSpiderWatcherStore.setState({
      isActive: true,
      activatedAt: new Date().toISOString(),
      customers: [],
      selectedLeadIds: [],
      isWindowOpen: true,
    });

    renderWithClient(<SpiderNotificationPopup />, testClient);

    const card = screen.getByText('Jane Doe').closest('div[role="button"]');
    expect(card).not.toBeNull();
    fireEvent.click(card!);

    // When clicked, the notification for New stage lead routes to the communication tab
    // and closes the notification window
    expect(useSpiderWatcherStore.getState().isWindowOpen).toBe(false);
  });

  it('marks stale New notification as read when lead is already Contacted', () => {
    const testClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });

    testClient.setQueryData(
      ['notifications', { needsAction: false, verb: 'spider.alert', unread: true, limit: 'all' }],
      {
        pages: [
          {
            items: [
              {
                id: 'notif-stale-new-1',
                verb: 'spider.alert',
                category: 'LEAD',
                title: 'Spider Alert - Alice (LD-102)',
                body: 'This lead has not yet been contacted.',
                object_type: 'LEAD',
                object_id: 'lead-stale-1',
                object_label: 'LD-102',
                data: {
                  lead_id: 'lead-stale-1',
                  lead_number: 'LD-102',
                  customer_name: 'Alice',
                  stage_name: 'New',
                },
                created_at: new Date().toISOString(),
                seen_at: null,
                read_at: null,
              },
            ],
            nextCursor: null,
          },
        ],
        pageParams: [undefined],
      }
    );

    useSpiderWatcherStore.setState({
      isActive: true,
      activatedAt: new Date().toISOString(),
      notifications: { inApp: false, email: false, sms: false },
      customers: [
        {
          id: 'cust-1',
          name: 'Alice',
          leads: [
            {
              id: 'lead-stale-1',
              leadNumber: 'LD-102',
              stageLabel: 'Contacted',
              stageId: 'lead_contacted',
            } as any,
          ],
        } as any,
      ],
      selectedLeadIds: ['lead-stale-1'],
      isWindowOpen: true,
    });

    renderWithClient(<SpiderNotificationPopup />, testClient);

    // Stale New notification for Contacted lead is marked as read
    expect(screen.queryByText('This lead has not yet been contacted.')).toBeNull();
  });

  it('marks stale Contacted notification as read when lead is Walkthrough Scheduled', () => {
    const testClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });

    testClient.setQueryData(
      ['notifications', { needsAction: false, verb: 'spider.alert', unread: true, limit: 'all' }],
      {
        pages: [
          {
            items: [
              {
                id: 'notif-stale-contacted-1',
                verb: 'spider.alert',
                category: 'LEAD',
                title: 'Spider Alert - Bob (LD-103)',
                body: 'This lead was contacted but walkthrough not scheduled.',
                object_type: 'LEAD',
                object_id: 'lead-stale-2',
                object_label: 'LD-103',
                data: {
                  lead_id: 'lead-stale-2',
                  lead_number: 'LD-103',
                  customer_name: 'Bob',
                  stage_name: 'Contacted',
                },
                created_at: new Date().toISOString(),
                seen_at: null,
                read_at: null,
              },
            ],
            nextCursor: null,
          },
        ],
        pageParams: [undefined],
      }
    );

    useSpiderWatcherStore.setState({
      isActive: true,
      activatedAt: new Date().toISOString(),
      notifications: { inApp: false, email: false, sms: false },
      customers: [
        {
          id: 'cust-2',
          name: 'Bob',
          leads: [
            {
              id: 'lead-stale-2',
              leadNumber: 'LD-103',
              stageLabel: 'Walkthrough Scheduled',
              stageId: 'lead_walkthrough_scheduled',
            } as any,
          ],
        } as any,
      ],
      selectedLeadIds: ['lead-stale-2'],
      isWindowOpen: true,
    });

    renderWithClient(<SpiderNotificationPopup />, testClient);

    expect(screen.queryByText('This lead was contacted but walkthrough not scheduled.')).toBeNull();
  });

  it('marks stale Walkthrough Completed notification as read when lead is Estimate', () => {
    const testClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });

    testClient.setQueryData(
      ['notifications', { needsAction: false, verb: 'spider.alert', unread: true, limit: 'all' }],
      {
        pages: [
          {
            items: [
              {
                id: 'notif-stale-wt-1',
                verb: 'spider.alert',
                category: 'LEAD',
                title: 'Spider Alert - Charlie (LD-104)',
                body: 'Walkthrough was completed but estimate not sent.',
                object_type: 'LEAD',
                object_id: 'lead-stale-3',
                object_label: 'LD-104',
                data: {
                  lead_id: 'lead-stale-3',
                  lead_number: 'LD-104',
                  customer_name: 'Charlie',
                  stage_name: 'Walkthrough Completed',
                },
                created_at: new Date().toISOString(),
                seen_at: null,
                read_at: null,
              },
            ],
            nextCursor: null,
          },
        ],
        pageParams: [undefined],
      }
    );

    useSpiderWatcherStore.setState({
      isActive: true,
      activatedAt: new Date().toISOString(),
      notifications: { inApp: false, email: false, sms: false },
      customers: [
        {
          id: 'cust-3',
          name: 'Charlie',
          leads: [
            {
              id: 'lead-stale-3',
              leadNumber: 'LD-104',
              stageLabel: 'Estimate',
              stageId: 'lead_estimate',
            } as any,
          ],
        } as any,
      ],
      selectedLeadIds: ['lead-stale-3'],
      isWindowOpen: true,
    });

    renderWithClient(<SpiderNotificationPopup />, testClient);

    expect(screen.queryByText('Walkthrough was completed but estimate not sent.')).toBeNull();
  });
});



