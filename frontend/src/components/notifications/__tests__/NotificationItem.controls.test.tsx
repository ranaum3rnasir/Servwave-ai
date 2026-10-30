import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';
import { renderWithProviders } from '@/__tests__/helpers';
import { NotificationItem } from '../NotificationItem';
import { notificationDeepLink } from '../notificationDeepLink';
import type { NotificationView } from '@/lib/api/notifications';

const ITEM: NotificationView = {
  id: 'n0000000-0000-0000-0000-000000000002',
  verb: 'LEAD_WON',
  category: 'LEAD',
  priority: 'FEED',
  needs_action: false,
  title: 'L00002-1 won',
  body: null,
  object_type: 'LEAD',
  object_id: 'l0000000-0000-0000-0000-000000000002',
  object_label: null,
  action_type: null,
  data: {},
  created_at: '2026-08-13T00:00:00.000Z',
  seen_at: null,
  read_at: null,
  acted_at: null,
};

const CONTROLS = 'button, a[href], [role="button"], [tabindex]';

// Mobile gate (a11y nested-interactive): the row's own control must not wrap the inline action buttons.
describe('NotificationItem - controls are not nested', () => {
  it('keeps the inline action button outside the control that opens the notification', () => {
    renderWithProviders(<NotificationItem item={{ ...ITEM, needs_action: true, action_type: 'SCHEDULE_JOB' }} />);

    expect(screen.getByRole('button', { name: 'Schedule job' })).toBeInTheDocument();
    for (const el of Array.from(document.querySelectorAll(CONTROLS))) {
      expect(el.querySelector(CONTROLS), `${el.tagName} "${el.textContent}" must not hold another control`).toBeNull();
    }
  });

  it('opens the notification from its title by keyboard', async () => {
    function Where() {
      return <div data-testid="where">{useLocation().pathname}</div>;
    }
    renderWithProviders(
      <>
        <NotificationItem item={ITEM} />
        <Where />
      </>,
    );
    screen.getByRole('button', { name: /L00002-1 won/ }).focus();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByTestId('where')).toHaveTextContent(notificationDeepLink(ITEM));
  });
});
