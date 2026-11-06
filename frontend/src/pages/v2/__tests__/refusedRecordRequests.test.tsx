/**
 * Roles & Permissions, PRD 6, S06.27 (scenario pass 3 fix) - a bell link to a record the person can no longer open.
 *
 * The routed record pages (job, lead, estimate, invoice) show the "You don't have access to this page" screen when the record's own
 * read is refused (403). They used to keep asking for the record's sections after that (the job page's visits, money, line items,
 * notes and files; the lead page's attachments) and to repeat the refused read, so the browser console filled with failed
 * requests. The record's own read is now asked for once, and nothing about the record is asked for after it.
 *
 * The real pages and their real data hooks render here; only the network (the app's axios instance) is replaced, by a server that
 * refuses the record's own read and answers everything else. Every request that names the record is counted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import type { ComponentType } from 'react';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';

import JobDetailPage from '../jobs/JobDetailPage';
import LeadDetailPage from '../leads/LeadDetailPage';
import EstimateWorkspacePage from '../estimates/EstimateWorkspacePage';
import InvoiceDetailPage from '../invoices/InvoiceDetailPage';
import { retryUnlessRefused } from '../_shared/loadErrorState';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const RECORD_ID = 'f0000000-0000-0000-0000-0000000000a1';

vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: 'f0000000-0000-0000-0000-0000000000a1' }), useNavigate: () => vi.fn() };
});

const mockApi = vi.mocked(api);
const refusal = { isAxiosError: true, message: 'Request failed with status code 403', response: { status: 403, data: { error: 'Forbidden' } } };

const PAGES: Array<[string, ComponentType, string]> = [
  ['job', JobDetailPage, `/api/jobs/${RECORD_ID}`],
  ['lead', LeadDetailPage, `/api/leads/${RECORD_ID}`],
  ['estimate', EstimateWorkspacePage, `/api/estimates/${RECORD_ID}`],
  ['invoice', InvoiceDetailPage, `/api/invoices/${RECORD_ID}`],
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('a record the person may not open', () => {
  it.each(PAGES)('the %s page asks for the record once, shows the no-access page, and asks for nothing else about it', async (_name, Page, ownRead) => {
    mockApi.get.mockImplementation(async (url: string) => {
      if (url === ownRead) throw refusal;
      return { data: {} };
    });
    renderWithProviders(<Page />, {
      ability: buildAbility([{ action: 'manage', subject: 'all' }]),
      initialEntries: [`/${_name}s/${RECORD_ID}`],
    });

    expect(await screen.findByText(/You don.t have access to this page/)).toBeInTheDocument();
    // Anything the page would still send has had time to leave.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const namingTheRecord = mockApi.get.mock.calls.map((call) => String(call[0])).filter((url) => url.includes(RECORD_ID));
    expect(namingTheRecord).toEqual([ownRead]);
  });

  it('a record that opens still gets its sections after its own answer', async () => {
    mockApi.get.mockImplementation(async (url: string) => {
      if (url === `/api/jobs/${RECORD_ID}`) {
        return {
          data: {
            job: {
              id: RECORD_ID, job_number: 'J00001', status: 'SCHEDULED', job_type: 'Repair', description: null, scope_notes: null,
              customer: { id: 'c-1', first_name: 'Sarah', last_name: 'Johnson', company_name: null, email: null, phone: null },
              assignees: [], visits: [], service_location: null, estimate: null, invoices: [], linked_estimates: [], tags: [],
              source_plan_id: null, source_plan: null, actions: [],
            },
          },
        };
      }
      if (url.includes('/visits')) return { data: { visits: [] } };
      if (url.includes('/notes')) return { data: { notes: [] } };
      if (url.includes('/api/attachments/')) return { data: { attachments: [] } };
      return { data: {} };
    });
    renderWithProviders(<JobDetailPage />, {
      ability: buildAbility([{ action: 'manage', subject: 'all' }]),
      initialEntries: [`/jobs/${RECORD_ID}`],
    });

    await waitFor(() => {
      const urls = mockApi.get.mock.calls.map((call) => String(call[0]));
      expect(urls).toContain(`/api/jobs/${RECORD_ID}/visits`);
      expect(urls).toContain(`/api/jobs/${RECORD_ID}/notes?include_lead=true`);
    });
  });
});

describe('retryUnlessRefused', () => {
  it('never asks again after a refusal, and keeps the app\'s one retry for any other failure', () => {
    expect(retryUnlessRefused(0, refusal)).toBe(false);
    expect(retryUnlessRefused(0, { response: { status: 500 } })).toBe(true);
    expect(retryUnlessRefused(1, { response: { status: 500 } })).toBe(false);
  });

  it.each([400, 404, 409, 422, 429])('never asks again after a %i', (status) => {
    expect(retryUnlessRefused(0, { response: { status } })).toBe(false);
  });

  it('keeps the one retry after a 401 (the session-refresh path) and after a network error', () => {
    expect(retryUnlessRefused(0, { response: { status: 401 } })).toBe(true);
    expect(retryUnlessRefused(1, { response: { status: 401 } })).toBe(false);
    expect(retryUnlessRefused(0, new Error('Network Error'))).toBe(true);
  });
});
