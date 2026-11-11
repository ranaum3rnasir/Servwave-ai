import api from '@/lib/axios';

export interface BeeFunnelData {
  queued: number;
  totalCalls: number;
  reached: number;
  reachRate: number;
}

export interface BeeCallsPerDayItem {
  date: string;
  dayLabel: string;
  total: number;
  outcomes: Record<string, number>;
}

export interface BeeNeedsHumanItem {
  id: string;
  customerName: string;
  customerPhone: string;
  tag: string;
  reason: string;
  callTime: string;
  createdAt: string;
  callLogId?: string;
}

export interface BeeUpcomingExpirationItem {
  id: string;
  customerName: string;
  customerPhone?: string;
  job: string;
  warrantyEndDate: string;
  daysRemaining: number;
  status: string;
}

export interface BeeRecentCallItem {
  id: string;
  customer_id?: string;
  customer_name?: string;
  customer_phone?: string;
  job_id?: string;
  job_number?: string;
  job_type?: string;
  t: string;
  c: string;
  p: string;
  j: string;
  jt?: string;
  we: string;
  ag: string;
  at: string;
  d: string;
  o: string;
  outcome?: string;
  outcomes?: string[];
  is_answered?: boolean;
  lf?: string;
  bk: string;
  v: string;
  ai_summary?: string;
  transcript?: any;
  audio_url?: string;
}

export interface BeeMetricsResponse {
  ok: boolean;
  isActive: boolean;
  callWindow: {
    start: string;
    end: string;
    timezone: string;
  };
  kpis: {
    customersCalled?: { value: number; subtitle: string };
    reached?: { value: number; subtitle: string };
    warrantyLeads?: { value: number; subtitle: string; count?: number };
    newWorkLeads?: { value: number; subtitle: string; count?: number };
    inQueue?: { value: number; subtitle: string };
    needsHumanCount?: { value: number; subtitle: string };
    reachRate?: { value: number; target: number; unit: string };
    warrantyLeadRate?: { value: number; target: number; unit: string };
    newWorkLeadRate?: { value: number; target: number; unit: string };
    pipelineRevenue?: { value: number; unit: string };
    optOutRate?: { value: number; target: number; unit: string };
    needsHumanRate?: { value: number; unit: string };
  };
  funnel?: BeeFunnelData;
  callsPerDay?: BeeCallsPerDayItem[];
  needsHuman?: BeeNeedsHumanItem[];
  upcomingExpirations?: BeeUpcomingExpirationItem[];
  recentCalls?: BeeRecentCallItem[];
  counts: {
    totalCalls: number;
    answeredCalls: number;
    queueCount: number;
    activeAgentsCount: number;
    warrantyLeadsCount?: number;
    newWorkLeadsCount?: number;
    leadsCreated?: number;
  };
}

export interface BeeCallLogItem {
  id: string;
  customer_name: string;
  customer_phone: string;
  customer_id?: string;
  job_id?: string;
  job_number?: string;
  job_type?: string;
  job_title?: string;
  warranty_ends?: string;
  agent_id?: string;
  agent_name?: string;
  agent_version?: string;
  attempt?: string;
  duration_seconds: number;
  duration_formatted?: string;
  outcome: string;
  outcomes?: string[];
  is_answered?: boolean;
  outcome_label?: string;
  lead_format?: string | null;
  lead_id?: string;
  lead_label?: string;
  value?: string;
  sentiment?: string;
  objections?: string[];
  task?: {
    id: string;
    task_number: string;
    title: string;
    status: string;
  } | null;
  task_id?: string | null;
  task_number?: string | null;
  task_title?: string | null;
  task_status?: string | null;
  wants?: string[];
  didnt_want?: string[];
  transcript?: any;
  ai_summary?: string;
  audio_url?: string;
  needs_human_alert: boolean;
  called_at: string;
  // Direct mockup fields
  t?: string;
  c?: string;
  p?: string;
  j?: string;
  jt?: string;
  we?: string;
  ag?: string;
  at?: string;
  d?: string;
  o?: string;
  lf?: string | null;
  bk?: string;
  v?: string;
  sent?: string;
  ver?: string;
  sum?: string;
  got?: string[];
  miss?: string[];
  obj?: string[];
}

export interface BeeQueueItem {
  id: string;
  customer_id?: string;
  customer_name: string;
  customer_phone: string;
  job_id?: string;
  job_number?: string;
  job_type?: string;
  service_request?: string;
  scope_notes?: string;
  completion_notes?: string;
  service_address?: string;
  completed_at?: string | null;
  line_items?: Array<{
    id?: string;
    description: string;
    quantity: number;
    unit_price?: number;
    line_total?: number;
  }>;
  job_info?: {
    job_id?: string;
    job_number?: string;
    job_type?: string;
    status?: string;
    service_request?: string;
    scope_notes?: string;
    completion_notes?: string;
    service_address?: string;
    completed_at?: string | null;
    line_items_summary?: string;
    warranty_start_date?: string | null;
    warranty_end_date?: string | null;
    warranty_status?: string;
  };
  status: string;
  attempt_count: number;
  scheduled_for: string;
  total_amount?: number;
  last_attempted_at?: string | null;
  archived_at?: string | null;
  warranty_started_on?: 'Job Complete' | 'Invoice Sent' | string | null;
  original_scheduled_for?: string | null;
  is_rescheduled?: boolean;
  rescheduled_at?: string | null;
  customer_timezone?: string | null;
  timezone_source?: 'customer_address' | 'zip_code' | 'city_state' | 'state' | 'state_estimate' | 'system_default' | string | null;
  is_timezone_estimated?: boolean;
  skip_reason?: string;
  created_at?: string;
  updated_at?: string;
  warranty_record?: {
    job_id?: string;
    customer_id?: string;
    job_type?: string;
    warranty_start_date?: string;
    warranty_end_date: string;
    warranty_started_on?: 'Job Complete' | 'Invoice Sent' | string | null;
    status?: string;
  };
}

export interface BeeAgentConversationFlow {
  greeting_pitch?: string;
  checkin_flow?: string;
  warranty_offer_pitch?: string;
  new_work_pitch?: string;
  objection_handling?: string;
  custom_instructions?: string;
}

export interface BeeAvailablePhoneNumber {
  id: string;
  vapiPhoneNumberId?: string;
  phoneNumber: string;
  friendlyName: string;
  e164?: string;
  formatted?: string;
  label?: string;
  isDefault: boolean;
  source?: string;
  status?: string;
  createdAt?: string;
}

export interface BeeSampleJobContext {
  id: string;
  job_number: string;
  title?: string;
  job_type: string;
  status: string;
  customer_name: string;
  customer_phone: string;
  service_request?: string;
  service_address?: string;
  warranty_end_date?: string;
  dynamic_variables?: Record<string, string>;
  job_context_variables?: Record<string, string>;
}

export interface BeeAgentItem {
  id: string;
  name: string;
  persona_name: string;
  voice_id: string;
  trade_focus?: string;
  trigger_days_before?: number;
  eligible_job_types?: string[];
  warranty_offer_pitch?: string;
  new_work_pitch?: string;
  is_active: boolean;
  job_context_fields?: string[];
  conversation_flow?: BeeAgentConversationFlow;
  default_from_number?: string;
  default_from_number_id?: string;
  vapi_assistant_id?: string;
  voice_engine?: string;
  language?: string;
  languages?: string[];
  tone?: string;
  created_at?: string;
  calls_today?: number;
  lead_rate?: string;
  version?: number | string;
  override_caller_id?: boolean;
  goal?: string;
  updated_at?: string;
}

export interface BeeAgentsResponse {
  ok: boolean;
  agents: BeeAgentItem[];
  availableNumbers?: BeeAvailablePhoneNumber[];
  sampleJobs?: BeeSampleJobContext[];
  companyName?: string;
  masterPromptTemplate?: string;
}

export interface BeeTestCallPayload {
  phoneNumber?: string;
  toNumber?: string;
  fromNumber?: string;
  phoneNumberId?: string;
  agentId?: string;
  jobId?: string;
  conversationFlow?: BeeAgentConversationFlow;
  selectedJobContextFields?: string[];
}

export interface BeeTestCallResponse {
  ok: boolean;
  message?: string;
  error?: string;
  callResult?: any;
  mergedPrompt?: string;
  dynamicVariables?: Record<string, string>;
}

export interface BeePlanFileItem {
  name: string;
  type?: string;
  size?: number;
  url?: string;
}

export interface BeePlanItem {
  id: string;
  name: string;
  duration_months: number;
  price: string | number;
  billing_interval: string;
  description?: string;
  inclusions?: string[] | any;
  eligible_job_types: string[];
  is_active: boolean;
  // Mockup extended properties
  per?: string;
  len?: string;
  billing?: string;
  covered?: string;
  files?: BeePlanFileItem[];
  for?: string;
}

export interface JobTypeWarrantyItem {
  job_type: string;
  included_warranty: string;
  warranty_days: number;
  call_threshold_days: number;
  agent_id?: string | null;
  phone_number?: string | null;
  is_active?: boolean;
}

export interface BeeDncItem {
  id: string;
  phone_number: string;
  reason?: string;
  source: string;
  created_at: string;
}

export interface BeeSettingsItem {
  id: string;
  is_active: boolean;
  call_window_start: string;
  call_window_end: string;
  timezone: string;
  max_retries: number;
  retry_interval_hours: number;
  default_lead_owner_id?: string;
  alert_email?: string;
  alert_phone?: string;
  voice_provider: string;
  voice_provider_api_key?: string;
  job_type_warranties?: JobTypeWarrantyItem[];
  setup_config?: Record<string, any>;
}

export const beeApi = {
  getMetrics: (range?: string) => api.get<BeeMetricsResponse>('/api/ai-farm/bee/metrics', { params: { range } }).then((r) => r.data),
  toggleStatus: (isActive: boolean) => api.post<{ ok: boolean; isActive: boolean; settings?: BeeSettingsItem }>('/api/ai-farm/bee/toggle-status', { isActive }).then((r) => r.data),
  
  getCalls: (params?: { page?: number; limit?: number; outcome?: string; search?: string }) =>
    api.get<{ ok: boolean; records: BeeCallLogItem[]; total: number; totalPages: number }>('/api/ai-farm/bee/calls', { params }).then((r) => r.data),
  getCallDetail: (id: string) =>
    api.get<{ ok: boolean; call: BeeCallLogItem }>(`/api/ai-farm/bee/calls/${id}`).then((r) => r.data),
  updateCallOutcome: (id: string, outcome: string) =>
    api.patch<{ ok: boolean; count: number }>(`/api/ai-farm/bee/calls/${id}`, { outcome }).then((r) => r.data),

  getQueue: (status?: string) =>
    api.get<{ ok: boolean; items: BeeQueueItem[] }>('/api/ai-farm/bee/queue', { params: { status } }).then((r) => r.data),
  callNow: (queueItemId: string) =>
    api.post<{ ok: boolean; callResult: any }>('/api/ai-farm/bee/queue/call-now', { queueItemId }).then((r) => r.data),
  skipQueueItem: (queueItemId: string, reason?: string) =>
    api.post<{ ok: boolean; count: number }>('/api/ai-farm/bee/queue/skip', { queueItemId, reason }).then((r) => r.data),
  rescheduleQueueItem: (queueItemId: string, scheduledFor: string) =>
    api.patch<{ ok: boolean; item: BeeQueueItem }>(`/api/ai-farm/bee/queue/${queueItemId}/reschedule`, { scheduledFor }).then((r) => r.data),

  getAgents: () =>
    api.get<BeeAgentsResponse>('/api/ai-farm/bee/agents').then((r) => r.data),
  getSampleJobs: (params?: { search?: string; limit?: number; offset?: number; jobId?: string }) =>
    api
      .get<{
        ok: boolean;
        jobs: BeeSampleJobContext[];
        total: number;
        hasMore: boolean;
        offset: number;
        limit: number;
      }>('/api/ai-farm/bee/sample-jobs', { params })
      .then((r) => r.data),
  createAgent: (data: Partial<BeeAgentItem>) =>
    api.post<{ ok: boolean; agent: BeeAgentItem; engineSync?: any }>('/api/ai-farm/bee/agents', data).then((r) => r.data),
  updateAgent: (id: string, data: Partial<BeeAgentItem>) =>
    api.put<{ ok: boolean; agent: BeeAgentItem; engineSync?: any }>(`/api/ai-farm/bee/agents/${id}`, data).then((r) => r.data),
  deleteAgent: (id: string) =>
    api.delete<{ ok: boolean; deleted: boolean }>(`/api/ai-farm/bee/agents/${id}`).then((r) => r.data),
  triggerTestCall: (
    phoneNumberOrPayload: string | BeeTestCallPayload,
    agentId?: string
  ) => {
    const payload: BeeTestCallPayload =
      typeof phoneNumberOrPayload === 'string'
        ? { phoneNumber: phoneNumberOrPayload, toNumber: phoneNumberOrPayload, agentId }
        : phoneNumberOrPayload;
    return api
      .post<BeeTestCallResponse>('/api/ai-farm/bee/agents/test-call', payload)
      .then((r) => r.data);
  },

  getPlans: () =>
    api.get<{ ok: boolean; plans: BeePlanItem[] }>('/api/ai-farm/bee/plans').then((r) => r.data),
  createPlan: (data: Partial<BeePlanItem>) =>
    api.post<{ ok: boolean; plan: BeePlanItem }>('/api/ai-farm/bee/plans', data).then((r) => r.data),
  updatePlan: (id: string, data: Partial<BeePlanItem>) =>
    api.put<{ ok: boolean; plan: BeePlanItem }>(`/api/ai-farm/bee/plans/${id}`, data).then((r) => r.data),
  deletePlan: (id: string) =>
    api.delete<{ ok: boolean }>(`/api/ai-farm/bee/plans/${id}`).then((r) => r.data),

  getJobTypeWarranties: () =>
    api.get<{ ok: boolean; jobTypeWarranties: JobTypeWarrantyItem[] }>('/api/ai-farm/bee/job-type-warranties').then((r) => r.data),
  updateJobTypeWarranties: (jobTypeWarranties: JobTypeWarrantyItem[]) =>
    api.put<{ ok: boolean; jobTypeWarranties: JobTypeWarrantyItem[] }>('/api/ai-farm/bee/job-type-warranties', { jobTypeWarranties }).then((r) => r.data),
  syncWarranties: () =>
    api.post<{ ok: boolean; result: any }>('/api/ai-farm/bee/warranties/sync').then((r) => r.data),

  getDnc: () =>
    api.get<{ ok: boolean; dncList: BeeDncItem[] }>('/api/ai-farm/bee/dnc').then((r) => r.data),
  addDnc: (phone_number: string, reason?: string) =>
    api.post<{ ok: boolean; entry: BeeDncItem }>('/api/ai-farm/bee/dnc', { phone_number, reason }).then((r) => r.data),
  deleteDnc: (id: string) =>
    api.delete<{ ok: boolean }>(`/api/ai-farm/bee/dnc/${id}`).then((r) => r.data),

  getSettings: () =>
    api.get<{ ok: boolean; settings: BeeSettingsItem }>('/api/ai-farm/bee/settings').then((r) => r.data),
  updateSettings: (data: Partial<BeeSettingsItem>) =>
    api.put<{ ok: boolean; settings: BeeSettingsItem }>('/api/ai-farm/bee/settings', data).then((r) => r.data),

  // Bee Phone System
  getPhoneNumbers: () =>
    api
      .get<{ ok: boolean; phoneNumbers: BeeAvailablePhoneNumber[] }>('/api/ai-farm/bee/phone-numbers')
      .then((r) => r.data),
  buyPhoneNumber: (data: { areaCode?: string; name?: string; provider?: string }) =>
    api
      .post<{ ok: boolean; phoneNumber: BeeAvailablePhoneNumber }>('/api/ai-farm/bee/phone-numbers/buy', data)
      .then((r) => r.data),
  releasePhoneNumber: (id: string) =>
    api
      .delete<{ ok: boolean; released: boolean }>(`/api/ai-farm/bee/phone-numbers/${id}`)
      .then((r) => r.data),
};

