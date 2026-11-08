/**
 * Email slice 5 — the delivery pill next to InvoiceDetailPage's "Sent {date}"
 * line. Email carries no invoice_id column (verified against schema.prisma),
 * so the page correlates via the SAME job-scoped comm timeline the Job page's
 * Communication tab already reads (invoice sends stamp job_id on the Email
 * row) filtered to this invoice's own deterministic subject prefix — see
 * findTransactionalEmail's doc comment (lib/api/jobCommunications.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import InvoiceDetailPage from '@/pages/InvoiceDetailPage';
import { buildAbility } from '@/lib/ability';
import type { CommItem } from '@/lib/api/jobCommunications';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: 'inv-bounce-001' }),
    useNavigate: () => vi.fn(),
  };
});

const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);
const mockApi = vi.mocked(api);

const CUSTOMER = {
  id: 'c0000000-0000-0000-0000-000000000001',
  first_name: 'John',
  last_name: 'Doe',
  email: 'john@doe.com',
  phone: '5551234567',
};

const JOB = {
  id: 'job-bounce-1',
  job_number: 'J00099',
  status: 'COMPLETED',
  assignees: [],
  customer: CUSTOMER,
  service_location: {
    id: 'loc-1',
    address_line1: '100 Test St',
    address_line2: null,
    city: 'Boston',
    state: 'MA',
    zip: '02101',
  },
  estimate: null,
};

const INVOICE = {
  id: 'inv-bounce-001',
  invoice_number: 'I00042',
  status: 'SENT',
  subtotal: 550,
  discount_amount: 0,
  tax_rate: 0,
  tax_amount: 0,
  tip: 0,
  deposit_credit: 0,
  total_amount: 550,
  amount_due: 550,
  public_token: 'tok-1',
  sent_at: '2026-08-01T00:00:00.000Z',
  paid_at: null,
  due_date: null,
  voided_at: null,
  voided_reason: null,
  refunded_at: null,
  total_refunded: 0,
  refund_reason: null,
  refund_reason_category: null,
  line_items: [],
  scopes: [],
  net_collected: 0,
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:00:00.000Z',
  customer: CUSTOMER,
  job: JOB,
  payments: [],
};

function emailItem(overrides: Partial<CommItem> = {}): CommItem {
  return {
    id: 'email-1',
    channel: 'email',
    direction: 'out',
    who: 'John Doe',
    title: 'Invoice I00042 from ServWave',
    preview: 'Your invoice is ready.',
    at: '2026-08-01T09:00:00.000Z',
    ...overrides,
  };
}

function setupMocks(jobItems: CommItem[]) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.endsWith('/notes')) return { data: { notes: [] } };
    if (url.endsWith('/timeline')) return { data: { events: [] } };
    if (url.includes('/api/logistic-orders')) return { data: { data: [], page: 1, limit: 50, total: 0 } };
    if (url.includes('/communications')) return { data: { items: jobItems } };
    if (url.includes('/api/invoices/')) return { data: { invoice: INVOICE } };
    return { data: [] };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('InvoiceDetailPage — delivery pill (email slice 5)', () => {
  it('renders nothing extra when no matching send is found', async () => {
    setupMocks([]);
    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });

    await waitFor(() => {
      expect(screen.getByTestId('invoice-detail')).toBeInTheDocument();
    });
    expect(screen.queryByText('Bounced')).not.toBeInTheDocument();
    expect(screen.queryByText('Delivered')).not.toBeInTheDocument();
  });

  it('renders the Bounced pill for a hard-bounced send matching this invoice', async () => {
    setupMocks([emailItem({ deliveryStatus: 'BOUNCED', bounceKind: 'HARD' })]);
    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });

    await waitFor(() => {
      expect(screen.getByText('Bounced')).toBeInTheDocument();
    });
  });

  it('renders the Delivered pill as fact once confirmed', async () => {
    setupMocks([emailItem({ deliveryStatus: 'DELIVERED' })]);
    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });

    await waitFor(() => {
      expect(screen.getByText('Delivered')).toBeInTheDocument();
    });
  });

  it('ignores a send whose subject belongs to a different invoice on the same job', async () => {
    setupMocks([emailItem({ title: 'Invoice I00999 from ServWave', deliveryStatus: 'BOUNCED', bounceKind: 'HARD' })]);
    renderWithProviders(<InvoiceDetailPage />, { ability: adminAbility });

    await waitFor(() => {
      expect(screen.getByTestId('invoice-detail')).toBeInTheDocument();
    });
    expect(screen.queryByText('Bounced')).not.toBeInTheDocument();
  });
});
