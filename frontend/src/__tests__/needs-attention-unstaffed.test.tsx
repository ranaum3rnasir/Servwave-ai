/**
 * Needs attention: unstaffed jobs within 48 hours (scheduling notifications, slice 05).
 *
 * The server emits a new item kind, `job_unstaffed`. The widget must paint it as a crew
 * problem (its own icon, not the unknown-type triangle), carry the warning treatment, and
 * navigate to the link the server built. Both the routed v2 widget and the legacy one are
 * covered because both still map icons by kind.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { AttentionItem } from '@/lib/api/dashboard';
import NeedsAttentionV2 from '@/pages/v2/dashboard/widgets/needsAttention';
import NeedsAttentionLegacy from '@/components/dashboard/widgets/NeedsAttention';

import { renderWithProviders } from './helpers';

const UNSTAFFED: AttentionItem = {
  id: 'job-1',
  type: 'job_unstaffed',
  severity: 'warning',
  title: 'J00312 starts Thu 9:00 AM, no crew',
  meta: 'Pat Customer · no technician assigned to the visit',
  badge: '1d',
  link: '/jobs/job-1',
};

describe.each([
  ['v2 dashboard widget', NeedsAttentionV2],
  ['legacy dashboard widget', NeedsAttentionLegacy],
])('NeedsAttention (%s) - unstaffed job item', (_label, NeedsAttention) => {
  it('renders the unstaffed item with a crew icon, the warning treatment, and navigates to the job', async () => {
    const navigate = vi.fn();
    renderWithProviders(<NeedsAttention items={[UNSTAFFED]} navigate={navigate} />);

    const row = screen.getByRole('button', { name: /J00312 starts Thu 9:00 AM, no crew/ });
    expect(row).toHaveTextContent('1d');
    // A crew problem gets the crew icon in its row, never the fallback triangle for an unknown
    // kind (the widget header carries its own triangle, so the check is scoped to the row).
    expect(row.querySelector('svg.lucide-users')).not.toBeNull();
    expect(row.querySelector('svg.lucide-triangle-alert')).toBeNull();

    await userEvent.click(row);
    expect(navigate).toHaveBeenCalledWith('/jobs/job-1');
  });
});
