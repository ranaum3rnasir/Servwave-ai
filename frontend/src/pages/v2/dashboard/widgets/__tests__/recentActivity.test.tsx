/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import type { ActivityEvent } from '@/lib/api/dashboard';
import { dashboardSeed } from '@/lib/api/_mock/dashboard';

import { RecentActivity } from '../catalog';

// Issue 04 - a task's timeline outlives the task, and this feed is org-wide with
// no entity filter, so it now receives events whose entity is gone. They must
// read as belonging to something deleted, never as a blank and never as a link
// to a row that would 404.

const live: ActivityEvent = {
  id: 'live-1',
  event_type: 'ASSIGNED',
  description: 'assigned Dana',
  created_at: new Date().toISOString(),
  creator_name: 'Priya',
  entity_deleted: false,
  entity_label: null,
};

const deleted: ActivityEvent = {
  id: 'gone-1',
  event_type: 'DELETED',
  description: 'deleted the task',
  created_at: new Date().toISOString(),
  creator_name: 'Priya',
  entity_deleted: true,
  entity_label: 'T00001 · Inspect compressor',
};

describe('RecentActivity - events whose entity is gone', () => {
  it('renders a deleted-entity event with its snapshot label and a Deleted marker', () => {
    render(<RecentActivity events={[deleted]} />);

    expect(screen.getByText('deleted the task')).toBeInTheDocument();
    const label = screen.getByText('T00001 · Inspect compressor');
    expect(label).toBeInTheDocument();
    // Not a blank: the label the backend snapshotted is the only identity left.
    expect(label.textContent?.trim()).not.toBe('');
    expect(label).toHaveAttribute('title', 'T00001 · Inspect compressor');
    expect(screen.getByText('Deleted')).toBeInTheDocument();
  });

  it('offers nothing to navigate to for a deleted entity', () => {
    const { container } = render(<RecentActivity events={[deleted]} />);

    expect(within(container).queryAllByRole('link')).toHaveLength(0);
    expect(within(container).queryAllByRole('button')).toHaveLength(0);
  });

  it('leaves a live event untouched', () => {
    render(<RecentActivity events={[live]} />);

    expect(screen.getByText('assigned Dana')).toBeInTheDocument();
    expect(screen.queryByText('Deleted')).not.toBeInTheDocument();
  });

  it('renders a mixed feed without erroring, marking only the deleted row', () => {
    render(<RecentActivity events={[live, deleted]} />);

    expect(screen.getByText('assigned Dana')).toBeInTheDocument();
    expect(screen.getByText('deleted the task')).toBeInTheDocument();
    expect(screen.getAllByText('Deleted')).toHaveLength(1);
  });
});

describe('dashboard mock seed', () => {
  it('carries the same activity shape the live payload does', () => {
    // Typed as the seam's ActivityEvent, so a seed row missing either new field
    // is a compile error, not a runtime surprise.
    const rows: ActivityEvent[] = dashboardSeed.activity;
    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      expect(typeof row.entity_deleted).toBe('boolean');
      // entity_label is non-null exactly when entity_deleted, and never empty.
      if (row.entity_deleted) {
        expect(row.entity_label).toBeTruthy();
      } else {
        expect(row.entity_label).toBeNull();
      }
    }

    // The deleted branch has a fixture, so mock mode exercises the same render path.
    expect(rows.some((r) => r.entity_deleted)).toBe(true);
  });

  it('renders the whole seed feed, deleted row included', () => {
    render(<RecentActivity events={dashboardSeed.activity} />);

    expect(screen.getByText('T00042 · Inspect compressor')).toBeInTheDocument();
    expect(screen.getByText('Deleted')).toBeInTheDocument();
  });
});
