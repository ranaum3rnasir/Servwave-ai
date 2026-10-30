/**
 * Needs attention: with the API returning the payments item first (payments go-live slice 33b), the six-row
 * widget shows it however many other items follow.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import NeedsAttention from '@/pages/v2/dashboard/widgets/needsAttention';

const other = (n: number) => ({
  id: `inv-${n}`, type: 'overdue_invoice', severity: 'danger' as const,
  title: `Invoice I${n} overdue`, meta: 'x', badge: '3d', link: `/invoices/${n}`,
});
const payments = {
  id: 'payments-attention', type: 'payments_attention', severity: 'warning' as const,
  title: '50 payments need attention', meta: 'Failed payments, refunds, disputes and payouts', badge: '50',
  link: '/payments?tab=payments&chip=attention',
};

describe('NeedsAttention: payments item among many', () => {
  it('renders the payments item when ten other items follow it', () => {
    render(<NeedsAttention items={[payments, ...Array.from({ length: 10 }, (_, i) => other(i))]} navigate={vi.fn()} />);
    expect(screen.getByRole('button', { name: /50 payments need attention/ })).toBeInTheDocument();
  });

  it('opens the Payments page on the attention chip when the row is clicked', () => {
    const navigate = vi.fn();
    render(<NeedsAttention items={[payments]} navigate={navigate} />);
    fireEvent.click(screen.getByRole('button', { name: /50 payments need attention/ }));
    expect(navigate).toHaveBeenCalledWith('/payments?tab=payments&chip=attention');
  });

  it('draws a row the person may not open, with no address, as text that cannot be clicked', () => {
    const navigate = vi.fn();
    render(<NeedsAttention items={[{ ...payments, link: null }]} navigate={navigate} />);
    expect(screen.getByText('50 payments need attention')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /50 payments need attention/ })).toBeNull();
    fireEvent.click(screen.getByText('50 payments need attention'));
    expect(navigate).not.toHaveBeenCalled();
  });
});
