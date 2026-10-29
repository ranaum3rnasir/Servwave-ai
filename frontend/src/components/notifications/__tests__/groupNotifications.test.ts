import { describe, it, expect } from 'vitest';
import { groupNotifications } from '../groupNotifications';
import type { NotificationView } from '@/lib/api/notifications';

function makeItem(overrides: Partial<NotificationView>): NotificationView {
  return {
    id: 'id-1',
    verb: 'created',
    category: 'JOB',
    priority: 'FEED',
    needs_action: false,
    title: 'Test notification',
    body: null,
    object_type: 'JOB',
    object_id: 'obj-1',
    object_label: null,
    action_type: null,
    data: {},
    created_at: '2026-06-17T10:00:00Z',
    seen_at: null,
    read_at: null,
    acted_at: null,
    ...overrides,
  };
}

describe('groupNotifications', () => {
  it('item with needs_action:true and acted_at:null lands in needsAction', () => {
    const item = makeItem({ needs_action: true, acted_at: null });
    const { needsAction, earlier } = groupNotifications([item]);
    expect(needsAction).toContain(item);
    expect(earlier).not.toContain(item);
  });

  it('item with needs_action:true but acted_at SET lands in earlier (not pinned)', () => {
    const item = makeItem({
      needs_action: true,
      acted_at: '2026-06-17T11:00:00Z',
    });
    const { needsAction, earlier } = groupNotifications([item]);
    expect(needsAction).not.toContain(item);
    expect(earlier).toContain(item);
  });

  it('informational items (needs_action:false) land in earlier', () => {
    const item = makeItem({ needs_action: false });
    const { needsAction, earlier } = groupNotifications([item]);
    expect(needsAction).not.toContain(item);
    expect(earlier).toContain(item);
  });

  it('both groups are sorted newest-first by created_at desc', () => {
    const older = makeItem({
      id: 'older',
      needs_action: true,
      acted_at: null,
      created_at: '2026-06-15T08:00:00Z',
    });
    const newer = makeItem({
      id: 'newer',
      needs_action: true,
      acted_at: null,
      created_at: '2026-06-17T12:00:00Z',
    });
    const olderEarlier = makeItem({
      id: 'older-info',
      needs_action: false,
      created_at: '2026-06-14T08:00:00Z',
    });
    const newerEarlier = makeItem({
      id: 'newer-info',
      needs_action: false,
      created_at: '2026-06-16T09:00:00Z',
    });

    const { needsAction, earlier } = groupNotifications([
      older,
      newer,
      olderEarlier,
      newerEarlier,
    ]);

    expect(needsAction[0]!.id).toBe('newer');
    expect(needsAction[1]!.id).toBe('older');
    expect(earlier[0]!.id).toBe('newer-info');
    expect(earlier[1]!.id).toBe('older-info');
  });

  it('returns empty arrays when no items', () => {
    const { needsAction, earlier } = groupNotifications([]);
    expect(needsAction).toEqual([]);
    expect(earlier).toEqual([]);
  });
});
