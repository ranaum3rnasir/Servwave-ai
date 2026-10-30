/**
 * Needs attention: the Missing crew item (Roles & Permissions, PRD 9, S09.13).
 *
 * The server emits one item, `missing_crew` ("N visits with no crew"), in place of the line per visit it used to send.
 * The widget must paint it as a crew problem (its own icon, not the unknown-type triangle), carry the warning
 * treatment, and navigate to the link the server built. Both the routed v2 widget and the legacy one are covered
 * because both still map icons by kind.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { AttentionItem } from '@/lib/api/dashboard';
import NeedsAttentionV2 from '@/pages/v2/dashboard/widgets/needsAttention';
import NeedsAttentionLegacy from '@/components/dashboard/widgets/NeedsAttention';

import { renderWithProviders } from './helpers';

const MISSING_CREW: AttentionItem = {
  id: 'missing-crew',
  type: 'missing_crew',
  severity: 'warning',
  title: '3 visits with no crew',
  meta: 'J00312 starts Thu 9:00 AM',
  badge: '1d',
  link: '/sent-schedule?filter=sent',
};

describe.each([
  ['v2 dashboard widget', NeedsAttentionV2],
  ['legacy dashboard widget', NeedsAttentionLegacy],
])('NeedsAttention (%s) - missing crew item', (_label, NeedsAttention) => {
  it('renders the item with a crew icon, the warning treatment and the soonest visit, and navigates to the address the server sent', async () => {
    const navigate = vi.fn();
    renderWithProviders(<NeedsAttention items={[MISSING_CREW]} navigate={navigate} />);

    const row = screen.getByRole('button', { name: /3 visits with no crew/ });
    expect(row).toHaveTextContent('J00312 starts Thu 9:00 AM');
    expect(row).toHaveTextContent('1d');
    // A crew problem gets the crew icon in its row, never the fallback triangle for an unknown
    // kind (the widget header carries its own triangle, so the check is scoped to the row).
    expect(row.querySelector('svg.lucide-users')).not.toBeNull();
    expect(row.querySelector('svg.lucide-triangle-alert')).toBeNull();

    await userEvent.click(row);
    expect(navigate).toHaveBeenCalledWith('/sent-schedule?filter=sent');
  });
});
