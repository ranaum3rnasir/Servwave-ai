/**
 * Mobile slice 61: the "View" action on a new-notification toast used to be a Radix `ToastAction`,
 * which pulled the Radix toast into the staff app's first download. It is a plain element now,
 * because the toast adapter only reads its label and its click handler. This pins that the toast
 * still carries both, and that clicking it still navigates to the notification's page.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const toastMock = vi.hoisted(() => vi.fn());
const navigateMock = vi.hoisted(() => vi.fn());
const notificationsState = vi.hoisted(() => ({ data: undefined as unknown }));

vi.mock('@/components/ui/use-toast', () => ({ toast: toastMock }));
vi.mock('react-router-dom', () => ({ useNavigate: () => navigateMock }));
vi.mock('@/lib/api/notifications', () => ({ useNotifications: () => ({ data: notificationsState.data }) }));

import { useInterruptToasts } from '../useInterruptToasts';

const item = (over: Record<string, unknown>) => ({
  id: 'n1',
  verb: 'job.assigned',
  category: 'JOB',
  priority: 'INTERRUPT',
  needs_action: false,
  title: 'New job',
  body: 'Assigned to you',
  object_type: 'JOB',
  object_id: 'job-9',
  object_label: null,
  action_type: null,
  data: {},
  created_at: '2026-10-04T10:00:00.000Z',
  seen_at: null,
  read_at: null,
  acted_at: null,
  ...over,
});
const page = (...items: unknown[]) => ({ pages: [{ items, nextCursor: null }] });

describe('useInterruptToasts', () => {
  beforeEach(() => {
    toastMock.mockClear();
    navigateMock.mockClear();
  });

  it('toasts a new INTERRUPT notification with a View action that goes to its page', () => {
    notificationsState.data = page(item({ id: 'old', created_at: '2026-10-04T09:00:00.000Z' }));
    const { rerender } = renderHook(() => useInterruptToasts());
    expect(toastMock).not.toHaveBeenCalled(); // the first load only sets the watermark

    notificationsState.data = page(item({}), item({ id: 'old', created_at: '2026-10-04T09:00:00.000Z' }));
    rerender();

    expect(toastMock).toHaveBeenCalledTimes(1);
    const call = toastMock.mock.calls[0]![0];
    expect(call.title).toBe('New job');
    expect(call.variant).toBe('default');
    // What the toast adapter reads off the action: its label and its click handler.
    expect(call.action.props.children).toBe('View');
    call.action.props.onClick();
    expect(navigateMock).toHaveBeenCalledWith('/jobs/job-9');
  });

  it('does not import the Radix toast: the action is not one of its parts', () => {
    notificationsState.data = page();
    const { rerender } = renderHook(() => useInterruptToasts());
    notificationsState.data = page(item({ category: 'SECURITY' }));
    rerender();
    const call = toastMock.mock.calls[0]![0];
    expect(call.variant).toBe('destructive');
    expect(typeof call.action.type).toBe('string'); // a plain host element ('button'), not a component
  });
});
