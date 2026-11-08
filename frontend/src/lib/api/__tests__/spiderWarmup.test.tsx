import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import api from '@/lib/axios';
import { useSpiderWatcherStore } from '@/stores/spiderWatcherStore';
import {
  useSpiderDataWarmup,
  SPIDER_CONFIG_QUERY_KEY,
  SPIDER_LEADS_QUERY_KEY,
  SPIDER_CUSTOMERS_QUERY_KEY,
  SPIDER_LOGS_QUERY_KEY,
} from '../spider';

const makeWrapper = (qc: QueryClient) =>
  function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: qc }, children);
  };

describe('Spider background data warmup (preload)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSpiderWatcherStore.setState({
      isActive: true,
      customers: [],
      selectedLeadIds: [],
    });
  });

  it('prefetches config, logs, leads, and customers and populates storeCustomers in background', async () => {
    const mockLeads = [
      {
        id: 'lead-1',
        leadNumber: 'LD-101',
        serviceRequest: 'Plumbing Repair',
        serviceLocation: '123 Main St',
        customer_id: 'cust-1',
        status: 'NEW',
        created_at: new Date().toISOString(),
      },
    ];

    const mockCustomers = [
      {
        id: 'cust-1',
        name: 'Acme Plumbing',
        company_name: 'Acme Corp',
        email: 'acme@example.com',
      },
    ];

    vi.mocked(api.get).mockImplementation(async (url: string) => {
      if (url.includes('/api/ai-farm/spider/config')) {
        return { data: { ok: true, config: { isActive: true } } } as any;
      }
      if (url.includes('/api/ai-farm/spider/logs')) {
        return { data: { ok: true, records: [], total: 0 } } as any;
      }
      if (url.includes('/api/leads')) {
        return { data: { leads: mockLeads } } as any;
      }
      if (url.includes('/api/customers')) {
        return { data: { customers: mockCustomers } } as any;
      }
      return { data: {} } as any;
    });

    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });

    renderHook(() => useSpiderDataWarmup(), { wrapper: makeWrapper(qc) });

    // Verify all four key endpoints were requested in background
    await waitFor(() => {
      expect(api.get).toHaveBeenCalledWith('/api/ai-farm/spider/config');
      expect(api.get).toHaveBeenCalledWith('/api/ai-farm/spider/logs', {
        params: { page: 1, limit: 25 },
      });
      expect(api.get).toHaveBeenCalledWith('/api/leads', {
        params: { limit: 100 },
      });
      expect(api.get).toHaveBeenCalledWith('/api/customers', {
        params: { limit: 100 },
      });
    });

    // Verify query cache is populated
    await waitFor(() => {
      expect(qc.getQueryData(SPIDER_CONFIG_QUERY_KEY)).toBeDefined();
      expect(qc.getQueryData(SPIDER_LOGS_QUERY_KEY(1, 25))).toBeDefined();
      expect(qc.getQueryData(SPIDER_LEADS_QUERY_KEY)).toBeDefined();
      expect(qc.getQueryData(SPIDER_CUSTOMERS_QUERY_KEY)).toBeDefined();
    });

    // Verify storeCustomers was automatically populated with live lead/customer data
    await waitFor(() => {
      const customers = useSpiderWatcherStore.getState().customers;
      expect(customers.length).toBeGreaterThan(0);
      expect(customers[0]?.leads.some((l) => l.id === 'lead-1')).toBe(true);
    });
  });
});
