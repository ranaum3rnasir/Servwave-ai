import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';
import { renderWithProviders } from '@/__tests__/helpers';
import { NotificationItem } from '../NotificationItem';
import { notificationDeepLink } from '../notificationDeepLink';
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

// S06.24: the Office review attention alert lists its items one to a line, then the why line.
describe('NotificationItem - a body that lists items', () => {
  it('keeps each line of the body on its own line', () => {
    renderWithProviders(
      <NotificationItem
        item={{
          ...NOTIFICATION_FIXTURE, verb: 'job.review_attention', category: 'JOB', priority: 'INTERRUPT', title: 'J00123 needs your attention',
          object_type: 'JOB', object_id: 'j1', data: { panel: 'review' },
          body: 'A price was lowered: Line: Door\nA file was deleted: File: Front door.png\nThis job has no Dispatcher.',
        }}
      />,
    );
    const body = screen.getByText(/A price was lowered/);
    expect(body.textContent).toBe('A price was lowered: Line: Door\nA file was deleted: File: Front door.png\nThis job has no Dispatcher.');
    expect(body.className).toContain('whitespace-pre-line');
  });
});

// S08.23: an inbound text alert carries the first 80 characters of what the customer wrote, and a customer can write anything.
describe('NotificationItem - the preview of an inbound text', () => {
  it('prints markup in the text as plain characters and interprets none of it', () => {
    const written = '<b>Gate</b> code <img src="x"> <script>alert(1)</script> 4412';
    const { container } = renderWithProviders(
      <NotificationItem
        item={{
          ...NOTIFICATION_FIXTURE, verb: 'communication.sms_inbound', category: 'COMMUNICATION', priority: 'FEED', title: 'New text — Pat Payer',
          object_type: 'MESSAGE_THREAD', object_id: 't1', body: written,
        }}
      />,
    );
    expect(screen.getByText(written, { exact: true }).textContent).toBe(written);
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
  });

  it('shows only who texted for a text with no words', () => {
    renderWithProviders(
      <NotificationItem
        item={{
          ...NOTIFICATION_FIXTURE, verb: 'communication.sms_inbound', category: 'COMMUNICATION', priority: 'FEED', title: 'New text — Pat Payer',
          object_type: 'MESSAGE_THREAD', object_id: 't1', body: null,
        }}
      />,
    );
    expect(screen.getByText('New text — Pat Payer')).toBeTruthy();
  });
});

/**
 * A logistic order submitted for approval names a LOGISTIC_ORDER. It used to fall through to the dashboard, so an approver whose
 * View logistic orders list access was off never reached the order. It opens the order's own record page,
 * a route that carries no list guard (S07.9).
 */
describe('notificationDeepLink - LOGISTIC_ORDER', () => {
  const ORDER_ID = 'b0000000-0000-4000-8000-0000000000a1';
  const submitted: NotificationView = {
    ...NOTIFICATION_FIXTURE,
    verb: 'lo.submitted',
    category: 'INVENTORY',
    priority: 'INTERRUPT',
    needs_action: true,
    title: 'Logistic order submitted for approval: LO-J00001-1',
    object_type: 'LOGISTIC_ORDER',
    object_id: ORDER_ID,
  };

  it('points the submitted and approved alerts at the order itself, not the dashboard', () => {
    expect(notificationDeepLink(submitted)).toBe(`/inventory/logistic-orders/${ORDER_ID}`);
    expect(notificationDeepLink({ ...submitted, verb: 'lo.approved' })).toBe(`/inventory/logistic-orders/${ORDER_ID}`);
  });

  it('opens the order when the bell row is clicked', async () => {
    function Where() {
      return <div data-testid="where">{useLocation().pathname}</div>;
    }
    renderWithProviders(<><NotificationItem item={submitted} /><Where /></>);

    await userEvent.click(screen.getByRole('button'));

    expect(screen.getByTestId('where')).toHaveTextContent(`/inventory/logistic-orders/${ORDER_ID}`);
  });
});

/**
 * The three communication alerts (S08.21) each open the page of their kind. The call lands on the call log, the text on its own
 * conversation, the email on the Inbox: every one of them lists or opens only what the server's single-read rule lets the
 * person read, so an alert delivered before access was removed leads to a page that no longer shows the conversation.
 */
describe('notificationDeepLink - communication alerts', () => {
  const alert = (object_type: string, object_id: string, verb: string): NotificationView => ({
    ...NOTIFICATION_FIXTURE, verb, category: 'COMMUNICATION', title: 'New alert', object_type, object_id,
  });

  it('opens the call log for a missed call', () => {
    expect(notificationDeepLink(alert('CALL', 'c1', 'communication.call_missed'))).toBe('/communication/phone');
  });

  it('opens the text conversation itself for an inbound text', () => {
    expect(notificationDeepLink(alert('MESSAGE_THREAD', 't1', 'communication.sms_inbound'))).toBe('/communication/text?threadId=t1');
  });

  // An alert made before the server named the conversation in its data has no link of its own; the Email page is still where it belongs.
  it('opens the Inbox for an inbound email that names no conversation, not the dashboard', () => {
    const link = notificationDeepLink(alert('EMAIL_THREAD', 'e1', 'communication.email_inbound'));
    expect(link).toBe('/communication/inbox');
    expect(link).not.toBe('/');
  });

  // The server puts the conversation's address into the alert's data when it makes the alert (the mailbox it sits in and the
  // conversation), so the bell opens the conversation itself and not the person's own, possibly empty, mailbox.
  it('opens the conversation an inbound email alert names', () => {
    const named: NotificationView = {
      ...alert('EMAIL_THREAD', 'e1', 'communication.email_inbound'),
      data: { link_path: '/communication/inbox?mailbox=box-main&thread=e1' },
    };
    expect(notificationDeepLink(named)).toBe('/communication/inbox?mailbox=box-main&thread=e1');
  });
});

function Where() {
  const location = useLocation();
  return <div data-testid="where">{location.pathname + location.search}</div>;
}

describe('NotificationItem - a received email', () => {
  const email = (data: Record<string, unknown> = {}): NotificationView => ({
    ...NOTIFICATION_FIXTURE, verb: 'communication.email_inbound', category: 'COMMUNICATION', title: 'New email — pat@example.com',
    object_type: 'EMAIL_THREAD', object_id: 'e1', data,
  });

  it('navigates to the conversation the alert names when the row is clicked', async () => {
    renderWithProviders(<><NotificationItem item={email({ link_path: '/communication/inbox?mailbox=box-main&thread=e1' })} /><Where /></>);
    await userEvent.click(screen.getByRole('button'));
    expect(screen.getByTestId('where')).toHaveTextContent('/communication/inbox?mailbox=box-main&thread=e1');
  });

  it('shows an envelope, not a handset', () => {
    const { container } = renderWithProviders(<NotificationItem item={email()} />);
    expect(container.querySelector('.lucide-mail')).not.toBeNull();
    expect(container.querySelector('.lucide-phone')).toBeNull();
  });

  it('keeps the handset for a missed call and for a text', () => {
    for (const [verb, object_type] of [['communication.call_missed', 'CALL'], ['communication.sms_inbound', 'MESSAGE_THREAD']] as const) {
      const { container, unmount } = renderWithProviders(<NotificationItem item={{ ...email(), verb, object_type }} />);
      expect(container.querySelector('.lucide-phone')).not.toBeNull();
      expect(container.querySelector('.lucide-mail')).toBeNull();
      unmount();
    }
  });
});
