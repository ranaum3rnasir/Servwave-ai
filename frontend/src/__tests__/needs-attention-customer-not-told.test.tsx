/**
 * Needs attention: the "customer not told" kind (scheduling-notifications slice 06).
 *
 * The server decides the type; the widget only paints it. A kind the widget does not know
 * falls back to the warning triangle, so the one observable difference for a NEW kind is
 * that it gets its own icon, while title, meta, badge and the server-built link render as
 * for every other row.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import NeedsAttention from '@/pages/v2/dashboard/widgets/needsAttention';

const item = {
  id: 'customer-not-told-job-1',
  type: 'customer_not_told',
  severity: 'warning' as const,
  title: 'J00312 starts Thu 9:00 AM, customer not told',
  meta: 'Pat Customer · no scheduling notification has reached the customer',
  badge: '21h',
  link: '/jobs/job-1',
};

describe('NeedsAttention: customer_not_told', () => {
  it('renders the row with its own icon (not the unknown-kind fallback) and navigates to the server link', async () => {
    const navigate = vi.fn();
    render(<NeedsAttention items={[item]} navigate={navigate} />);

    // The ROW, not the card: the card header paints its own warning triangle for every list.
    const row = screen.getByRole('button', { name: /J00312 starts Thu 9:00 AM, customer not told/ });
    expect(within(row).getByText('Pat Customer · no scheduling notification has reached the customer')).toBeInTheDocument();
    expect(within(row).getByText('21h')).toBeInTheDocument();
    expect(row.querySelector('.lucide-mail-x')).toBeInTheDocument();
    expect(row.querySelector('.lucide-triangle-alert')).toBeNull();

    await userEvent.click(row);
    expect(navigate).toHaveBeenCalledWith('/jobs/job-1');
  });
});
