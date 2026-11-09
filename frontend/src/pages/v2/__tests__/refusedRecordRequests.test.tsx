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

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';

import { jobRecord, renderJobDetail, serveJobDetail, stubBrowser } from '@/__tests__/harness/jobDetailPage';
import { renderLeadDetail, serveLeadDetail } from '@/__tests__/harness/leadDetailPage';
import { renderEstimateWorkspace, serveEstimateWorkspace } from '@/__tests__/harness/estimateWorkspacePage';
import { renderInvoiceDetail, serveInvoiceDetail } from '@/__tests__/harness/invoiceDetailPage';
import { retryUnlessRefused } from '../_shared/loadErrorState';

stubBrowser();

const RECORD_ID = 'f0000000-0000-0000-0000-0000000000a1';

vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: 'f0000000-0000-0000-0000-0000000000a1' }), useNavigate: () => vi.fn() };
});

const mockApi = vi.mocked(api);
const refusal = { isAxiosError: true, message: 'Request failed with status code 403', response: { status: 403, data: { error: 'Forbidden' } } };

const everything = buildAbility([{ action: 'manage', subject: 'all' }]);

/** The job page goes through the job detail harness: its server refuses the job's own read. */
const refusingJobPage = () => {
  serveJobDetail({ jobId: RECORD_ID, job: () => { throw refusal; } });
  return renderJobDetail({ ability: everything, entry: `/jobs/${RECORD_ID}` });
};

/** The lead page goes through the lead detail harness: its server refuses the lead's own read. */
const refusingLeadPage = () => {
  serveLeadDetail({ lead: () => { throw refusal; } });
  return renderLeadDetail({ ability: everything, entry: `/leads/${RECORD_ID}` });
};

/** The estimate page goes through the estimate workspace harness: its server refuses the estimate's own read. */
const refusingEstimatePage = () => {
  serveEstimateWorkspace({ estimate: () => { throw refusal; } });
  return renderEstimateWorkspace({ ability: everything, entry: `/estimates/${RECORD_ID}` });
};

/** The invoice page goes through the invoice detail harness: its server refuses the invoice's own read. */
const refusingInvoicePage = () => {
  serveInvoiceDetail({ invoice: () => { throw refusal; } });
  return renderInvoiceDetail({ id: RECORD_ID, ability: everything, entry: `/invoices/${RECORD_ID}` });
};

const PAGES: Array<[string, () => unknown, string]> = [
  ['job', refusingJobPage, `/api/jobs/${RECORD_ID}`],
  ['lead', refusingLeadPage, `/api/leads/${RECORD_ID}`],
  ['estimate', refusingEstimatePage, `/api/estimates/${RECORD_ID}`],
  ['invoice', refusingInvoicePage, `/api/invoices/${RECORD_ID}`],
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('a record the person may not open', () => {
  it.each(PAGES)('the %s page asks for the record once, shows the no-access page, and asks for nothing else about it', async (_name, mount, ownRead) => {
    mount();

    expect(await screen.findByText(/You don.t have access to this page/)).toBeInTheDocument();
    // Anything the page would still send has had time to leave.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const namingTheRecord = mockApi.get.mock.calls.map((call) => String(call[0])).filter((url) => url.includes(RECORD_ID));
    expect(namingTheRecord).toEqual([ownRead]);
  });

  it('a record that opens still gets its sections after its own answer', async () => {
    serveJobDetail({
      jobId: RECORD_ID,
      job: jobRecord(
        {
          job_type: 'Repair', description: null,
          customer: { id: 'c-1', first_name: 'Sarah', last_name: 'Johnson', company_name: null, email: null, phone: null },
          actions: [],
        },
        RECORD_ID,
      ),
      routes: [
        { match: (url) => url.includes('/notes'), data: { notes: [] } },
        { match: (url) => url.includes('/api/attachments/'), data: { attachments: [] } },
      ],
    });
    renderJobDetail({ ability: everything, entry: `/jobs/${RECORD_ID}` });

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
