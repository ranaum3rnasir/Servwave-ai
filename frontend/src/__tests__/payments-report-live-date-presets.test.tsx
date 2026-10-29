// Bug found during live QA of SRVW-55 (tips on manual payments), fixed separately:
// relative-date presets (Today, Last 7 days, This month, …) must resolve against
// the real clock for real orgs — not the fixed demo anchor (BASE_MS =
// 2026-06-07) that exists only so the deterministic mock dataset renders
// consistently. Before the fix, PaymentsReport never passed `base` to
// resolveRange, so every preset silently fell back to BASE_MS for every org.
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import api from '@/lib/axios';
import PaymentsReport from '@/pages/reports/PaymentsReport';

vi.mock('@/lib/useIsDemoOrg', () => ({
  useIsDemoOrg: () => false,
}));

vi.mock('@/lib/axios', () => ({
  default: { get: vi.fn() },
}));

const mockGet = vi.mocked(api.get);

describe('PaymentsReport — real-org date presets resolve against actual current time', () => {
  it('"Today" surfaces a payment dated right now, not against the fixed demo anchor', async () => {
    mockGet.mockResolvedValue({
      data: {
        payments: [
          {
            id: '1',
            date: Date.now(),
            amount: 250,
            tip: 0,
            method: 'Credit card',
            category: 'Invoice',
            status: 'Succeeded',
            client: 'Acme Facilities',
            email: 'ap@acmefacilities.com',
            card: '',
            technician: 'Alice',
            txnKind: 'Keyed',
            confirmation: 'Approved',
          },
        ],
      },
    });

    const user = userEvent.setup();
    renderWithProviders(<PaymentsReport />);

    // Default preset is "Last 3 months" — switch to "Today".
    await user.click(await screen.findByText('Last 3 months'));
    await user.click(await screen.findByText('Today'));

    // If resolveRange still fell back to the fixed BASE_MS (2026-06-07), a
    // payment dated "now" would fall outside the resolved window and the
    // report would show $0.00 for everything.
    expect(await screen.findAllByText('$250.00')).not.toHaveLength(0);
  });
});
