import { describe, it, expect, vi, beforeEach } from 'vitest';
import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LEAD_FIXTURE, NOTES_FIXTURE } from './helpers';
import { renderLeadDetail, serveLeadDetail, stubBrowser } from '@/__tests__/harness/leadDetailPage';

vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => false,
}));
vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));
vi.mock('@/components/communication/LeadCommunicationsTab', () => ({ LeadCommunicationsTab: () => null }));
vi.mock('react-router-dom', async () => (await import('@/__tests__/harness/leadDetailRouter')).leadDetailRouter());

// Each source used to be a file of its own, so each started from the setup file's signed-in user and bare client calls.
// `clearAllMocks` keeps implementations: reset them here, so a block states its own user and answers in its own `beforeEach`.
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useAuthStore).mockReset();
  vi.mocked(api.get).mockReset();
  vi.mocked(api.post).mockReset();
  vi.mocked(api.patch).mockReset();
  vi.mocked(api.put).mockReset();
  vi.mocked(api.delete).mockReset();
});

describe('lead-deposit-processing-chip', () => {
  /**
   * Payments go-live slice 28b - the lead page's Deposit column. It reads the estimate's deposit
   * invoice (kind=DEPOSIT) the lead payload carries, and shows "Processing $X" beside the status
   * while a bank payment on it is still clearing, so nobody chases a customer who has already paid.
   * The routed page is `pages/v2/leads/LeadDetailPage`.
   */

  stubBrowser();

  function loadLeadWithDeposit(deposit: Record<string, unknown> | null) {
    serveLeadDetail({
      lead: {
        ...LEAD_FIXTURE,
        estimates: [{
          id: 'est-1', estimate_number: 'E00001', status: 'PENDING', total_amount: '1000.00',
          created_at: '2026-10-01T00:00:00Z', creator: { id: 'u1', first_name: 'Sam', last_name: 'Sales' },
          invoices: deposit ? [deposit] : [],
        }],
      },
      notes: NOTES_FIXTURE,
    });
  }

  beforeEach(() => vi.clearAllMocks());

  describe('lead page - the estimate\'s deposit', () => {
    it('shows "Processing $500.00" while a bank payment on the deposit is clearing', async () => {
      loadLeadWithDeposit({ kind: 'DEPOSIT', status: 'SENT', processing_amount: 500 });
      renderLeadDetail();
      await userEvent.click(await screen.findByText(/Estimates \(\d+\)/));

      expect(await screen.findByTestId('processing-badge')).toHaveTextContent('Processing $500.00');
    });

    it('shows the deposit status from the deposit invoice', async () => {
      loadLeadWithDeposit({ kind: 'DEPOSIT', status: 'PAID', processing_amount: 0 });
      renderLeadDetail();
      await userEvent.click(await screen.findByText(/Estimates \(\d+\)/));

      await screen.findByText('E00001');
      expect(screen.queryByTestId('processing-badge')).not.toBeInTheDocument();
      expect(screen.getAllByText(/paid/i).length).toBeGreaterThan(0);
    });
  });
});
