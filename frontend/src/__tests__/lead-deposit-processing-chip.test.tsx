/**
 * Payments go-live slice 28b - the lead page's Deposit column. It reads the estimate's deposit
 * invoice (kind=DEPOSIT) the lead payload carries, and shows "Processing $X" beside the status
 * while a bank payment on it is still clearing, so nobody chases a customer who has already paid.
 * The routed page is `pages/v2/leads/LeadDetailPage`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders, LEAD_FIXTURE, NOTES_FIXTURE } from './helpers';
import { buildAbility } from '@/lib/ability';
import LeadDetailPage from '@/pages/v2/leads/LeadDetailPage';

vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => false,
}));
vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));
vi.mock('@/components/communication/LeadCommunicationsTab', () => ({ LeadCommunicationsTab: () => null }));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: 'e0000000-0000-0000-0000-000000000001' }) };
});
class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const mockApi = vi.mocked(api);
const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

function loadLeadWithDeposit(deposit: Record<string, unknown> | null) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.includes('/notes')) return { data: { notes: NOTES_FIXTURE } };
    if (url.includes('/api/leads/')) {
      return {
        data: {
          lead: {
            ...LEAD_FIXTURE,
            estimates: [{
              id: 'est-1', estimate_number: 'E00001', status: 'PENDING', total_amount: '1000.00',
              created_at: '2026-10-01T00:00:00Z', creator: { id: 'u1', first_name: 'Sam', last_name: 'Sales' },
              invoices: deposit ? [deposit] : [],
            }],
          },
        },
      };
    }
    if (url.includes('/api/tags')) return { data: { tags: [] } };
    return { data: {} };
  });
}

beforeEach(() => vi.clearAllMocks());

describe('lead page - the estimate\'s deposit', () => {
  it('shows "Processing $500.00" while a bank payment on the deposit is clearing', async () => {
    loadLeadWithDeposit({ kind: 'DEPOSIT', status: 'SENT', processing_amount: 500 });
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });
    await userEvent.click(await screen.findByText(/Estimates \(\d+\)/));

    expect(await screen.findByTestId('processing-badge')).toHaveTextContent('Processing $500.00');
  });

  it('shows the deposit status from the deposit invoice', async () => {
    loadLeadWithDeposit({ kind: 'DEPOSIT', status: 'PAID', processing_amount: 0 });
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });
    await userEvent.click(await screen.findByText(/Estimates \(\d+\)/));

    await screen.findByText('E00001');
    expect(screen.queryByTestId('processing-badge')).not.toBeInTheDocument();
    expect(screen.getAllByText(/paid/i).length).toBeGreaterThan(0);
  });
});
