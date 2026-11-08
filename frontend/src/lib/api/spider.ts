import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';
import {
  useSpiderWatcherStore,
  buildWatcherCustomersFromLive,
  type SpiderAssignmentsConfig,
  type SpiderNotificationsConfig,
} from '@/stores/spiderWatcherStore';

export interface ChannelDeliveryDetail {
  enabled: boolean;
  status: 'SENT' | 'SUCCESS' | 'FAILED' | 'SKIPPED';
  sent?: number;
  failed?: number;
  error?: string | null;
}

export interface SpiderAlertLogDbRecord {
  id: string;
  organization_id: string;
  lead_id?: string | null;
  lead_number?: string | null;
  customer_id?: string | null;
  customer_name?: string | null;
  company_name?: string | null;
  service_request?: string | null;
  service_location?: string | null;
  stage_name?: string | null;
  inactive_days?: number | null;
  inactive_unit?: string | null;
  channels?: {
    email?: boolean | ChannelDeliveryDetail;
    sms?: boolean | ChannelDeliveryDetail;
    inApp?: boolean | ChannelDeliveryDetail;
    redFrame?: boolean | ChannelDeliveryDetail;
  } | null;
  recipients?: Array<{
    id?: string;
    name?: string;
    email?: string;
    phone?: string;
    role?: string;
    type?: string;
  }> | null;
  email_subject?: string | null;
  email_body?: string | null;
  sms_message?: string | null;
  in_app_message?: string | null;
  status?: string | null;
  created_at: string;
}

export interface GetSpiderAlertLogsParams {
  page?: number;
  limit?: number;
}

export interface GetSpiderAlertLogsResponse {
  ok: boolean;
  records?: SpiderAlertLogDbRecord[];
  total?: number;
  page?: number;
  limit?: number;
  totalPages?: number;
  error?: string;
}

export interface SpiderServerConfig {
  isActive: boolean;
  autoEnrollAllLeads?: boolean;
  selectedLeadIds?: string[];
  stageThresholds?: Record<
    string,
    | {
        value?: number;
        unit?: string;
        enabled?: boolean;
        days?: number;
        duration?: number;
      }
    | number
  >;
  notifications?: SpiderNotificationsConfig;
  assignments?: SpiderAssignmentsConfig;
  updatedAt?: string;
}

export interface GetSpiderConfigResponse {
  ok: boolean;
  config: SpiderServerConfig;
  error?: string;
}

export const SPIDER_CONFIG_QUERY_KEY = ['spider-server-config'] as const;
export const SPIDER_LEADS_QUERY_KEY = ['spider-watcher-leads-real'] as const;
export const SPIDER_CUSTOMERS_QUERY_KEY = ['spider-watcher-customers-real'] as const;
export const SPIDER_LOGS_QUERY_KEY = (page = 1, limit = 25) =>
  ['spider-alert-db-logs', page, limit] as const;

/**
 * Fetches leads from the API for Spider Watcher
 */
export async function fetchSpiderLeadsApi() {
  const res = await api.get('/api/leads', { params: { limit: 100 } });
  if (res?.data && typeof res.data === 'object' && res.data.ok === false) {
    throw new Error(res.data.error || 'Failed to fetch leads');
  }
  const raw =
    res?.data?.leads ||
    res?.data?.data ||
    (Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : null);
  if (raw === null || raw === undefined) {
    throw new Error('Failed to load leads from server');
  }
  return Array.isArray(raw) ? raw : [];
}

/**
 * Fetches customers from the API for Spider Watcher
 */
export async function fetchSpiderCustomersApi() {
  const res = await api.get('/api/customers', { params: { limit: 100 } });
  if (res?.data && typeof res.data === 'object' && res.data.ok === false) {
    throw new Error(res.data.error || 'Failed to fetch customers');
  }
  const raw =
    res?.data?.customers ||
    res?.data?.data ||
    (Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : null);
  if (raw === null || raw === undefined) {
    throw new Error('Failed to load customers from server');
  }
  return Array.isArray(raw) ? raw : [];
}

/**
 * Fetches current Spider configuration from the server/database.
 */
export async function getSpiderConfigApi(): Promise<SpiderServerConfig> {
  const response = await api.get<GetSpiderConfigResponse>('/api/ai-farm/spider/config');
  if (response?.data?.ok === false) {
    throw new Error(response.data.error || 'Failed to load Spider configuration');
  }
  if (!response?.data?.config) {
    throw new Error('Failed to load Spider configuration');
  }
  return response.data.config;
}

/**
 * Updates Spider configuration on the server/database.
 */
export async function updateSpiderConfigApi(
  payload: Partial<SpiderServerConfig>
): Promise<SpiderServerConfig> {
  const response = await api.put<GetSpiderConfigResponse>('/api/ai-farm/spider/config', payload);
  return response.data.config;
}

/**
 * React Query hook providing the authoritative, database-backed Spider configuration.
 * Automatically synchronizes the received server state into Zustand.
 */
export function useSpiderServerConfig(options?: { enabled?: boolean }) {
  const query = useQuery({
    queryKey: SPIDER_CONFIG_QUERY_KEY,
    queryFn: getSpiderConfigApi,
    staleTime: 30_000,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
    enabled: options?.enabled ?? true,
  });

  useEffect(() => {
    if (query.data) {
      useSpiderWatcherStore.getState().syncServerConfig?.(query.data);
    }
  }, [query.data]);

  return query;
}

/**
 * Fetches dispatched alert notification logs from the Spider database table
 */
export async function getSpiderAlertLogsApi(
  paramsOrLimit?: GetSpiderAlertLogsParams | number | 'all'
): Promise<GetSpiderAlertLogsResponse> {
  const queryParams: Record<string, number> = {};
  if (typeof paramsOrLimit === 'number') {
    queryParams.page = 1;
    queryParams.limit = Math.min(100, Math.max(1, paramsOrLimit));
  } else if (paramsOrLimit && typeof paramsOrLimit === 'object') {
    if (paramsOrLimit.page !== undefined) queryParams.page = Math.max(1, paramsOrLimit.page);
    if (paramsOrLimit.limit !== undefined)
      queryParams.limit = Math.min(100, Math.max(1, paramsOrLimit.limit));
  } else {
    queryParams.page = 1;
    queryParams.limit = 50;
  }

  const response = await api.get<GetSpiderAlertLogsResponse>('/api/ai-farm/spider/logs', {
    params: queryParams,
  });
  if (response?.data && typeof response.data === 'object' && response.data.ok === false) {
    throw new Error(response.data.error || 'Failed to load notification history');
  }
  return response?.data;
}

/**
 * Warms Spider leads, customers, configuration, and logs in the background
 * immediately upon CRM session start (V2AppLayout mount), so Spider data is already
 * loaded when the user opens Spider.
 */
export function useSpiderDataWarmup() {
  const queryClient = useQueryClient();
  const setStoreCustomers = useSpiderWatcherStore((s) => s.setCustomers);
  const activatedAt = useSpiderWatcherStore((s) => s.activatedAt);

  useEffect(() => {
    let isCancelled = false;

    const warmup = async () => {
      try {
        // 1. Prefetch Spider server configuration
        queryClient.prefetchQuery({
          queryKey: SPIDER_CONFIG_QUERY_KEY,
          queryFn: getSpiderConfigApi,
          staleTime: 60_000,
        });

        // 2. Prefetch default History logs (page 1, limit 25)
        queryClient.prefetchQuery({
          queryKey: SPIDER_LOGS_QUERY_KEY(1, 25),
          queryFn: () => getSpiderAlertLogsApi({ page: 1, limit: 25 }),
          staleTime: 30_000,
        });

        // 3. Fetch leads & customers in parallel and sync into Zustand store
        const [leads, customers] = await Promise.all([
          queryClient.fetchQuery({
            queryKey: SPIDER_LEADS_QUERY_KEY,
            queryFn: fetchSpiderLeadsApi,
            staleTime: 60_000,
          }),
          queryClient.fetchQuery({
            queryKey: SPIDER_CUSTOMERS_QUERY_KEY,
            queryFn: fetchSpiderCustomersApi,
            staleTime: 60_000,
          }),
        ]);

        if (!isCancelled && (leads?.length > 0 || customers?.length > 0)) {
          const live = buildWatcherCustomersFromLive(leads || [], customers || [], activatedAt);
          setStoreCustomers(live);
        }
      } catch {
        // Non-fatal background prefetch; individual views fetch on demand if required
      }
    };

    warmup();

    return () => {
      isCancelled = true;
    };
  }, [queryClient, setStoreCustomers, activatedAt]);
}

/**
 * Invisible component mounted in the authenticated app layout to run background Spider data preloading.
 */
export function SpiderDataWarmup() {
  useSpiderDataWarmup();
  return null;
}



