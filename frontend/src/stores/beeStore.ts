import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { registerStoreReset } from '@/lib/storeReset';
import {
  beeApi,
  BeeMetricsResponse,
  BeeCallLogItem,
  BeeQueueItem,
  BeeAgentItem,
  BeeAvailablePhoneNumber,
  BeeSampleJobContext,
  BeeTestCallPayload,
  BeeTestCallResponse,
  BeePlanItem,
  BeeDncItem,
  BeeSettingsItem,
} from '@/lib/api/bee';

interface BeeState {
  // Navigation
  activeTab: 'home' | 'calls' | 'queue' | 'agents' | 'plans' | 'dnc' | 'setup';
  setActiveTab: (tab: 'home' | 'calls' | 'queue' | 'agents' | 'plans' | 'dnc' | 'setup') => void;

  // Global loading
  isLoading: boolean;
  error: string | null;

  // Home
  metrics: BeeMetricsResponse | null;
  homeDateRange: string;
  setHomeDateRange: (range: string) => Promise<void>;
  homeAgentFilter: string;
  setHomeAgentFilter: (agent: string) => void;
  loadMetrics: (range?: string) => Promise<void>;
  toggleMasterStatus: (isActive: boolean) => Promise<void>;

  // Call Logs
  calls: BeeCallLogItem[];
  callsTotal: number;
  callsPage: number;
  callsFilterOutcome: string;
  callsSearch: string;
  selectedCallDetail: BeeCallLogItem | null;
  loadCalls: (page?: number) => Promise<void>;
  setCallsFilterOutcome: (outcome: string) => void;
  setCallsSearch: (search: string) => void;
  openCallDetail: (call: BeeCallLogItem) => void;
  closeCallDetail: () => void;

  // Queue
  queueItems: BeeQueueItem[];
  skippedItems: BeeQueueItem[];
  loadQueue: () => Promise<void>;
  callNow: (queueItemId: string) => Promise<void>;
  skipQueueItem: (queueItemId: string, reason?: string) => Promise<void>;
  rescheduleQueueItem: (queueItemId: string, scheduledFor: string) => Promise<void>;

  // Agents
  agents: BeeAgentItem[];
  availableNumbers: BeeAvailablePhoneNumber[];
  sampleJobs: BeeSampleJobContext[];
  agentCompanyName: string;
  masterPromptTemplate: string;
  loadAgents: () => Promise<void>;
  createAgent: (data: Partial<BeeAgentItem>) => Promise<void>;
  updateAgent: (id: string, data: Partial<BeeAgentItem>) => Promise<void>;
  deleteAgent: (id: string) => Promise<void>;
  testCall: (phone: string, agentId?: string) => Promise<string>;
  triggerTestCallFull: (payload: BeeTestCallPayload) => Promise<BeeTestCallResponse>;

  // Phone Numbers (Dedicated Bee Phone System)
  loadPhoneNumbers: () => Promise<void>;
  buyPhoneNumber: (data: { areaCode?: string; name?: string; provider?: string }) => Promise<BeeAvailablePhoneNumber>;
  releasePhoneNumber: (id: string) => Promise<void>;

  // Plans
  plans: BeePlanItem[];
  loadPlans: () => Promise<void>;
  createPlan: (data: Partial<BeePlanItem>) => Promise<void>;
  updatePlan: (id: string, data: Partial<BeePlanItem>) => Promise<void>;
  deletePlan: (id: string) => Promise<void>;

  // Job Type Warranties
  jobTypeWarranties: import('@/lib/api/bee').JobTypeWarrantyItem[];
  loadJobTypeWarranties: () => Promise<void>;
  saveJobTypeWarranties: (items: import('@/lib/api/bee').JobTypeWarrantyItem[]) => Promise<void>;
  syncWarranties: () => Promise<void>;

  // DNC
  dncList: BeeDncItem[];
  loadDnc: () => Promise<void>;
  addDnc: (phone: string, reason?: string) => Promise<void>;
  deleteDnc: (id: string) => Promise<void>;

  // Setup
  settings: BeeSettingsItem | null;
  setupDone: number[];
  setSetupDone: (done: number[]) => void;
  loadSettings: () => Promise<void>;
  updateSettings: (data: Partial<BeeSettingsItem>) => Promise<void>;
}

export const useBeeStore = create<BeeState>()(
  persist(
    (set, get) => ({
      activeTab: 'home',
      setActiveTab: (tab) => set({ activeTab: tab }),

      isLoading: false,
      error: null,
      setupDone: [1, 1, 1, 1, 1, 1, 0, 0],
      setSetupDone: (done) => set({ setupDone: done }),

      // Home
      metrics: null,
      homeDateRange: '7d',
      homeAgentFilter: 'all',
      setHomeDateRange: async (range: string) => {
        set({ homeDateRange: range });
        await get().loadMetrics(range);
      },
      setHomeAgentFilter: (agent: string) => set({ homeAgentFilter: agent }),
      loadMetrics: async (range?: string) => {
        try {
          if (!get().metrics) set({ isLoading: true, error: null });
          const targetRange = range || get().homeDateRange;
          const data = await beeApi.getMetrics(targetRange);
          set({ metrics: data, isLoading: false, error: null });
        } catch (err: any) {
          const errMsg =
            err.response?.data?.error === 'FEATURE_DISABLED'
              ? 'Bee is not enabled for your organization.'
              : err.response?.data?.message || err.response?.data?.error || err.message || 'Failed to load Bee metrics';
          if (!get().metrics) {
            set({ metrics: null, error: errMsg, isLoading: false });
          } else {
            set({ error: errMsg, isLoading: false });
          }
        }
      },
      toggleMasterStatus: async (isActive: boolean) => {
        try {
          const res = await beeApi.toggleStatus(isActive);
          const metrics = get().metrics;
          const currentSettings = get().settings;
          if (!isActive) {
            const resetDone = [0, 0, 0, 0, 0, 0, 0, 0];
            set({
              metrics: metrics ? { ...metrics, isActive: false } : null,
              settings: res.settings
                ? res.settings
                : currentSettings
                  ? {
                      ...currentSettings,
                      is_active: false,
                      job_type_warranties: [],
                      setup_config: { setupDone: resetDone, testPassed: false },
                    }
                  : null,
              setupDone: resetDone,
              jobTypeWarranties: [],
            });
            void get().loadJobTypeWarranties();
          } else {
            set({
              metrics: metrics ? { ...metrics, isActive: true } : null,
              settings: res.settings
                ? res.settings
                : currentSettings
                  ? { ...currentSettings, is_active: true }
                  : null,
            });
          }
          void get().loadQueue();
          void get().loadMetrics();
        } catch (err: any) {
          set({ error: err.message || 'Failed to toggle status' });
        }
      },

      // Calls
      calls: [],
      callsTotal: 0,
      callsPage: 1,
      callsFilterOutcome: 'all',
      callsSearch: '',
      selectedCallDetail: null,
      loadCalls: async (page = 1, limit = 100) => {
        try {
          if (get().calls.length === 0) set({ isLoading: true, error: null });
          const { callsFilterOutcome, callsSearch } = get();
          const res = await beeApi.getCalls({
            page,
            limit,
            outcome: callsFilterOutcome,
            search: callsSearch,
          });
          set({
            calls: res.records,
            callsTotal: res.total,
            callsPage: page,
            isLoading: false,
          });
        } catch (err: any) {
          set({ error: err.message || 'Failed to load call logs', isLoading: false });
        }
      },
  setCallsFilterOutcome: (outcome) => {
    set({ callsFilterOutcome: outcome });
    get().loadCalls(1);
  },
  setCallsSearch: (search) => {
    set({ callsSearch: search });
    get().loadCalls(1);
  },
  openCallDetail: (call) => {
    set({ selectedCallDetail: call });
    beeApi
      .getCallDetail(call.id)
      .then((res) => {
        if (res?.call) {
          const freshAudioUrl = res.call.audio_url || call.audio_url;
          const freshTranscript =
            Array.isArray(res.call.transcript) && res.call.transcript.length > 0
              ? res.call.transcript
              : call.transcript;
          const freshDuration = res.call.duration_seconds || call.duration_seconds;
          const freshSummary = res.call.ai_summary || call.ai_summary;
          set((state) => {
            if (!state.selectedCallDetail || state.selectedCallDetail.id !== call.id) {
              return state;
            }
            const merged: BeeCallLogItem = {
              ...state.selectedCallDetail,
              audio_url: freshAudioUrl,
              transcript: freshTranscript,
              duration_seconds: freshDuration,
              ai_summary: freshSummary,
              sum: freshSummary || state.selectedCallDetail.sum,
              task: res.call.task ?? state.selectedCallDetail.task,
              task_id: res.call.task_id ?? state.selectedCallDetail.task_id,
              task_number: res.call.task_number ?? state.selectedCallDetail.task_number,
              task_title: res.call.task_title ?? state.selectedCallDetail.task_title,
              task_status: res.call.task_status ?? state.selectedCallDetail.task_status,
            };
            return {
              selectedCallDetail: merged,
              calls: state.calls.map((c) => (c.id === call.id ? merged : c)),
            };
          });
        }
      })
      .catch(() => {});
  },
  closeCallDetail: () => set({ selectedCallDetail: null }),

  // Queue
  queueItems: [],
  skippedItems: [],
  loadQueue: async () => {
    try {
      if (get().queueItems.length === 0 && get().skippedItems.length === 0) {
        set({ isLoading: true, error: null });
      }
      const [scheduledRes, skippedRes] = await Promise.all([
        beeApi.getQueue('scheduled'),
        beeApi.getQueue('skipped'),
      ]);
      set({
        queueItems: scheduledRes.items,
        skippedItems: skippedRes.items,
        isLoading: false,
      });
    } catch (err: any) {
      set({ error: err.message || 'Failed to load queue', isLoading: false });
    }
  },
  callNow: async (queueItemId) => {
    try {
      // Optimistically mark the item as in progress so the UI responds instantly
      set((state) => ({
        queueItems: state.queueItems.map((q) =>
          q.id === queueItemId ? ({ ...q, status: 'in_progress' } as BeeQueueItem) : q
        ),
        skippedItems: state.skippedItems.map((q) =>
          q.id === queueItemId ? ({ ...q, status: 'in_progress' } as BeeQueueItem) : q
        ),
      }));
      await beeApi.callNow(queueItemId);
      // Refresh queue, call logs and metrics in the background (non-blocking)
      void get().loadQueue();
      void get().loadCalls(1);
      void get().loadMetrics();
    } catch (err: any) {
      set({ error: err.message || 'Call trigger failed' });
      void get().loadQueue();
      throw err;
    }
  },
  skipQueueItem: async (queueItemId, reason) => {
    try {
      await beeApi.skipQueueItem(queueItemId, reason);
      await get().loadQueue();
    } catch (err: any) {
      set({ error: err.message || 'Skip failed' });
    }
  },
  rescheduleQueueItem: async (queueItemId, scheduledFor) => {
    const prevQueue = get().queueItems;
    set((state) => ({
      queueItems: state.queueItems.map((q) =>
        q.id === queueItemId
          ? ({
              ...q,
              scheduled_for: scheduledFor,
              original_scheduled_for: q.original_scheduled_for || q.scheduled_for,
              is_rescheduled: true,
              rescheduled_at: new Date().toISOString(),
            } as BeeQueueItem)
          : q
      ),
    }));

    try {
      const res = await beeApi.rescheduleQueueItem(queueItemId, scheduledFor);
      if (res?.item) {
        set((state) => ({
          queueItems: state.queueItems.map((q) => (q.id === queueItemId ? res.item : q)),
        }));
      }
      void get().loadQueue();
    } catch (err: any) {
      set({ queueItems: prevQueue, error: err.message || 'Reschedule failed' });
      throw err;
    }
  },

  // Agents
  agents: [],
  availableNumbers: [],
  sampleJobs: [],
  agentCompanyName: '',
  masterPromptTemplate: '',
  loadAgents: async () => {
    try {
      if (get().agents.length === 0) set({ isLoading: true, error: null });
      const res = await beeApi.getAgents();
      set({
        agents: res.agents || [],
        availableNumbers: res.availableNumbers || [],
        sampleJobs: res.sampleJobs || [],
        agentCompanyName: res.companyName || '',
        masterPromptTemplate: res.masterPromptTemplate || '',
        isLoading: false,
      });
    } catch (err: any) {
      set({ error: err.message || 'Failed to load agents', isLoading: false });
    }
  },
  createAgent: async (data) => {
    try {
      await beeApi.createAgent(data);
      await get().loadAgents();
    } catch (err: any) {
      set({ error: err.message || 'Failed to deploy agent' });
      throw err;
    }
  },
  updateAgent: async (id, data) => {
    try {
      await beeApi.updateAgent(id, data);
      await get().loadAgents();
    } catch (err: any) {
      set({ error: err.message || 'Failed to update agent' });
      throw err;
    }
  },
  deleteAgent: async (id) => {
    try {
      await beeApi.deleteAgent(id);
      await get().loadAgents();
    } catch (err: any) {
      set({ error: err.message || 'Failed to delete agent' });
      throw err;
    }
  },
  testCall: async (phone, agentId) => {
    const res = await beeApi.triggerTestCall(phone, agentId);
    return res.message || 'Test call initiated.';
  },
  triggerTestCallFull: async (payload) => {
    try {
      const res = await beeApi.triggerTestCall(payload);
      return res;
    } catch (err: any) {
      if (err.response?.data) {
        return err.response.data as BeeTestCallResponse;
      }
      throw err;
    }
  },

  // Phone Numbers (Dedicated Bee Phone System)
  loadPhoneNumbers: async () => {
    try {
      const res = await beeApi.getPhoneNumbers();
      if (res.ok) {
        set({ availableNumbers: res.phoneNumbers || [] });
      }
    } catch (err: any) {
      console.error('Failed to load Bee phone numbers:', err);
    }
  },
  buyPhoneNumber: async (data) => {
    try {
      const res = await beeApi.buyPhoneNumber(data);
      if (res.ok && res.phoneNumber) {
        set((state) => ({
          availableNumbers: [res.phoneNumber, ...state.availableNumbers.filter((n) => n.id !== res.phoneNumber.id)],
        }));
        return res.phoneNumber;
      }
      throw new Error('Failed to buy phone number');
    } catch (err: any) {
      console.error('Failed to buy phone number:', err);
      throw err;
    }
  },
  releasePhoneNumber: async (id) => {
    try {
      await beeApi.releasePhoneNumber(id);
      set((state) => ({
        availableNumbers: state.availableNumbers.filter((n) => n.id !== id),
      }));
    } catch (err: any) {
      console.error('Failed to release phone number:', err);
      throw err;
    }
  },

  // Plans
  plans: [],
  loadPlans: async () => {
    try {
      if (get().plans.length === 0) set({ isLoading: true, error: null });
      const res = await beeApi.getPlans();
      set({ plans: res.plans, isLoading: false });
    } catch (err: any) {
      set({ error: err.message || 'Failed to load warranty plans', isLoading: false });
    }
  },
  createPlan: async (data) => {
    try {
      await beeApi.createPlan(data);
      await get().loadPlans();
    } catch (err: any) {
      set({ error: err.message || 'Failed to create plan' });
      throw err;
    }
  },
  updatePlan: async (id, data) => {
    try {
      await beeApi.updatePlan(id, data);
      await get().loadPlans();
    } catch (err: any) {
      set({ error: err.message || 'Failed to update plan' });
      throw err;
    }
  },
  deletePlan: async (id) => {
    try {
      await beeApi.deletePlan(id);
      await get().loadPlans();
    } catch (err: any) {
      set({ error: err.message || 'Failed to delete plan' });
      throw err;
    }
  },

  // Job Type Warranties
  jobTypeWarranties: [],
  loadJobTypeWarranties: async () => {
    try {
      const res = await beeApi.getJobTypeWarranties();
      set({ jobTypeWarranties: res.jobTypeWarranties });
    } catch (err: any) {
      set({ error: err.message || 'Failed to load job type warranties' });
    }
  },
  saveJobTypeWarranties: async (items) => {
    try {
      const res = await beeApi.updateJobTypeWarranties(items);
      set({ jobTypeWarranties: res.jobTypeWarranties });
      void get().loadQueue();
      void get().loadMetrics();
    } catch (err: any) {
      set({ error: err.message || 'Failed to save job type warranties' });
      throw err;
    }
  },
  syncWarranties: async () => {
    try {
      await beeApi.syncWarranties();
      await Promise.all([
        get().loadJobTypeWarranties(),
        get().loadMetrics(),
        get().loadQueue(),
      ]);
    } catch (err: any) {
      set({ error: err.message || 'Failed to sync warranties' });
      throw err;
    }
  },

  // DNC
  dncList: [],
  loadDnc: async () => {
    try {
      if (get().dncList.length === 0) set({ isLoading: true, error: null });
      const res = await beeApi.getDnc();
      set({ dncList: res.dncList, isLoading: false });
    } catch (err: any) {
      set({ error: err.message || 'Failed to load DNC list', isLoading: false });
    }
  },
  addDnc: async (phone, reason) => {
    try {
      await beeApi.addDnc(phone, reason);
      await get().loadDnc();
    } catch (err: any) {
      set({ error: err.message || 'Failed to add DNC number' });
      throw err;
    }
  },
  deleteDnc: async (id) => {
    const prevList = get().dncList;
    // Optimistic removal so UI updates immediately
    set({
      dncList: prevList.filter((item) => item.id !== id && item.phone_number !== id),
      error: null,
    });
    try {
      await beeApi.deleteDnc(id);
      await get().loadDnc();
    } catch (err: any) {
      // Rollback on failure
      set({ dncList: prevList, error: err.response?.data?.error || err.message || 'Failed to delete DNC number' });
      throw err;
    }
  },

  // Setup
  settings: null,
  loadSettings: async () => {
    try {
      if (!get().settings) set({ isLoading: true, error: null });
      const res = await beeApi.getSettings();
      const cfgDone = res.settings?.setup_config?.setupDone;
      set({
        settings: res.settings,
        ...(Array.isArray(cfgDone) && cfgDone.length > 0 ? { setupDone: cfgDone } : {}),
        isLoading: false,
      });
    } catch (err: any) {
      set({ error: err.message || 'Failed to load settings', isLoading: false });
    }
  },
  updateSettings: async (data) => {
    try {
      const res = await beeApi.updateSettings(data);
      const cfgDone = res.settings?.setup_config?.setupDone;
      const updatedJobRules = res.settings?.job_type_warranties;
      set({
        settings: res.settings,
        ...(Array.isArray(cfgDone) && cfgDone.length > 0 ? { setupDone: cfgDone } : {}),
        ...(Array.isArray(updatedJobRules) && updatedJobRules.length > 0
          ? { jobTypeWarranties: updatedJobRules }
          : {}),
      });
      void get().loadQueue();
      void get().loadMetrics();
    } catch (err: any) {
      set({ error: err.message || 'Failed to save settings' });
      throw err;
    }
  },
    }),
    {
      name: 'servwave_bee_store',
      partialize: (state) => ({
        activeTab: state.activeTab,
        metrics: state.metrics,
        homeDateRange: state.homeDateRange,
        homeAgentFilter: state.homeAgentFilter,
        calls: state.calls,
        callsTotal: state.callsTotal,
        callsPage: state.callsPage,
        callsFilterOutcome: state.callsFilterOutcome,
        queueItems: state.queueItems,
        skippedItems: state.skippedItems,
        agents: state.agents,
        availableNumbers: state.availableNumbers,
        sampleJobs: state.sampleJobs,
        agentCompanyName: state.agentCompanyName,
        masterPromptTemplate: state.masterPromptTemplate,
        plans: state.plans,
        jobTypeWarranties: state.jobTypeWarranties,
        dncList: state.dncList,
        settings: state.settings,
        setupDone: state.setupDone,
      }),
    }
  )
);

// Register account-scoped store reset on logout
registerStoreReset(() => {
  useBeeStore.persist.clearStorage();
  useBeeStore.setState({
    metrics: null,
    calls: [],
    callsTotal: 0,
    callsPage: 1,
    callsFilterOutcome: 'all',
    callsSearch: '',
    selectedCallDetail: null,
    queueItems: [],
    skippedItems: [],
    agents: [],
    availableNumbers: [],
    sampleJobs: [],
    agentCompanyName: '',
    masterPromptTemplate: '',
    plans: [],
    jobTypeWarranties: [],
    dncList: [],
    settings: null,
    setupDone: [1, 1, 1, 1, 1, 1, 0, 0],
    isLoading: false,
    error: null,
  });
});

