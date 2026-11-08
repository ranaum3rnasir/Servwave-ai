import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import { NotificationItem, notificationDeepLink } from '../NotificationItem';
import type { NotificationView } from '@/lib/api/notifications';

const NOTIFICATION_FIXTURE: NotificationView = {
  id: 'n0000000-0000-0000-0000-000000000001',
  verb: 'LEAD_CREATED',
  category: 'LEAD',
  priority: 'FEED',
  needs_action: false,
  title: 'New lead: Jane Doe',
  body: null,
  object_type: 'LEAD',
  object_id: 'l0000000-0000-0000-0000-000000000001',
  object_label: null,
  action_type: null,
  data: {},
  created_at: '2026-08-13T00:00:00.000Z',
  seen_at: null,
  read_at: null,
  acted_at: null,
};

// SRVW-265: notification rows should not paint a hover background.
describe('NotificationItem - hover state', () => {
  it('does not carry a hover background class on the row, and still shows the unread dot', () => {
    renderWithProviders(<NotificationItem item={NOTIFICATION_FIXTURE} />);

    const row = screen.getByRole('button');
    expect(row.className).not.toContain('hover:bg-background-light');

    expect(document.querySelector('.bg-notify')).not.toBeNull();
  });
});

/**
 * The six `task.*` verbs all land as `object_type: 'TASK'` + the task uuid.
 * Before the TASK case existed they fell through the switch to `'/'`, so a "you
 * were assigned" notification navigated to the dashboard.
 *
 * The link CANNOT be `/tasks/${id}`: `TASKS_V2_PATHS` is exactly `['/tasks']`,
 * with the six views held as component state and the detail as a drawer, so a
 * path segment would fall into the catch-all redirect. The id rides as a query
 * param the hub consumes and strips (see tasks-hub-notification-deeplink).
 */
describe('notificationDeepLink - TASK', () => {
  const taskNotification = (overrides: Partial<NotificationView> = {}): NotificationView => ({
    ...NOTIFICATION_FIXTURE,
    verb: 'task.assigned',
    category: 'TEAM',
    title: 'Priya assigned you a task',
    object_type: 'TASK',
    object_id: '7a1c0000-0000-4000-8000-000000000001',
    ...overrides,
  });

  it('deep-links to the hub with the task id as a query param, not a path segment', () => {
    expect(notificationDeepLink(taskNotification())).toBe(
      '/tasks?task=7a1c0000-0000-4000-8000-000000000001',
    );
  });

  it('covers every task.* verb, since the switch keys on object_type not verb', () => {
    for (const verb of ['task.assigned', 'task.watching', 'task.completed', 'task.cancelled', 'task.removed', 'task.deleted']) {
      expect(notificationDeepLink(taskNotification({ verb }))).toBe(
        '/tasks?task=7a1c0000-0000-4000-8000-000000000001',
      );
    }
  });

  it('falls back to the bare hub when there is no object id', () => {
    expect(notificationDeepLink(taskNotification({ object_id: '' }))).toBe('/tasks');
  });

  it('no longer sends a task notification to the dashboard', () => {
    expect(notificationDeepLink(taskNotification())).not.toBe('/');
  });
});
