/**
 * The dashboard activity feed and a task's files (fix pass, conformance audit).
 *
 * A task's files are as private as the task (slice 12: `checkEntityAccess`'s TASK branch - admin
 * always, assignee or watcher always, anyone else only through the linked record). The feed is
 * org-wide, and every upload, rename and delete of a task file writes a timeline event whose
 * description carries the file's name. So a dispatcher refused a task's files still read their
 * names on the dashboard. The feed keeps the event (the activity happened) but drops the name for a
 * viewer who cannot open the task.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, ALPHA_ORG_ID, TEST_USERS } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

const TASK_ID = 'bb000000-0000-4000-8000-0000000000f1';
const JOB_ID = 'bb000000-0000-4000-8000-0000000000f2';
const DISPATCHER = TEST_USERS.dispatcher.id;

function stubEveryDashboardQuery() {
  (prisma.job.groupBy as Mock).mockResolvedValue([]);
  (prisma.job.count as Mock).mockResolvedValue(0);
  (prisma.invoice.aggregate as Mock).mockResolvedValue({ _sum: {}, _avg: {}, _count: { _all: 0 } });
  (prisma.estimate.aggregate as Mock).mockResolvedValue({ _sum: {} });
  (prisma.job.aggregate as Mock).mockResolvedValue({ _sum: {} });
  (prisma.payment.aggregate as Mock).mockResolvedValue({ _sum: {} });
  (prisma.appSetting.findUnique as Mock).mockResolvedValue(null);
  (prisma.lead.findMany as Mock).mockResolvedValue([]);
  (prisma.lead.groupBy as Mock).mockResolvedValue([]);
  (prisma.lead.count as Mock).mockResolvedValue(0);
  (prisma.estimate.findMany as Mock).mockResolvedValue([]);
  (prisma.job.findMany as Mock).mockResolvedValue([]);
  (prisma.servicePlan.findMany as Mock).mockResolvedValue([]);
  (prisma.user.findMany as Mock).mockResolvedValue([]);
  (prisma.invoice.findMany as Mock).mockResolvedValue([]);
  (prisma.visit.findMany as Mock).mockResolvedValue([]);
  (prisma.$queryRaw as Mock).mockResolvedValue([]);
}

const at = (m: number) => new Date(Date.UTC(2026, 8, 20, 15, m));
const FEED = [
  { id: 'ev-1', event_type: 'ATTACHMENT_UPLOADED', description: 'File uploaded: salary-review.pdf', entity_type: 'TASK', entity_id: TASK_ID, created_at: at(5), creator: null },
  { id: 'ev-2', event_type: 'ATTACHMENT_UPDATED', description: 'Attachment updated: salary-review-final.pdf', entity_type: 'TASK', entity_id: TASK_ID, created_at: at(4), creator: null },
  { id: 'ev-3', event_type: 'ATTACHMENT_DELETED', description: 'Attachment deleted: salary-review-final.pdf', entity_type: 'TASK', entity_id: TASK_ID, created_at: at(3), creator: null },
  { id: 'ev-4', event_type: 'ATTACHMENT_UPLOADED', description: 'File uploaded: door-photo.jpg', entity_type: 'JOB', entity_id: JOB_ID, created_at: at(2), creator: null },
];

/** The task, as the feed's access check reads it (tenant-scoped, by id). */
function stubTask(task: { assignee_ids: string[]; watcher_ids: string[] } | null) {
  (prisma.task.findMany as Mock).mockImplementation(async (args: any) => {
    const ids: string[] = args?.where?.id?.in ?? [];
    if (!task || args?.where?.organization_id !== ALPHA_ORG_ID || !ids.includes(TASK_ID)) return [];
    return [{ id: TASK_ID, linked_entity_type: null, linked_entity_id: null, ...task }];
  });
}

const descriptions = (res: request.Response) => res.body.activity.map((e: any) => e.description);

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  stubEveryDashboardQuery();
  (prisma.timelineEvent.findMany as Mock).mockImplementation(async (args: any) =>
    args?.where?.event_type ? [] : FEED.map((e) => ({ ...e })),
  );
});

describe('GET /api/dashboard - task file names in the activity feed', () => {
  it('a dispatcher who is not on the task sees the file activity without the file names', async () => {
    mockAuthAs('dispatcher');
    stubTask({ assignee_ids: [TEST_USERS.technician.id], watcher_ids: [] });

    const res = await request(app).get('/api/dashboard').set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    expect(descriptions(res)).toEqual(['File uploaded', 'Attachment updated', 'Attachment deleted', 'File uploaded: door-photo.jpg']);
    expect(JSON.stringify(res.body.activity)).not.toContain('salary-review');
  });

  it('a dispatcher on the task sees the names', async () => {
    mockAuthAs('dispatcher');
    stubTask({ assignee_ids: [], watcher_ids: [DISPATCHER] });

    const res = await request(app).get('/api/dashboard').set(authHeader('dispatcher'));

    expect(descriptions(res)).toEqual(FEED.map((e) => e.description));
  });

  it('a task that no longer exists hides the names from a non-admin', async () => {
    mockAuthAs('dispatcher');
    stubTask(null);

    const res = await request(app).get('/api/dashboard').set(authHeader('dispatcher'));

    expect(JSON.stringify(res.body.activity)).not.toContain('salary-review');
  });

  it('an admin sees every name', async () => {
    mockAuthAs('admin');
    stubTask({ assignee_ids: [TEST_USERS.technician.id], watcher_ids: [] });

    const res = await request(app).get('/api/dashboard').set(authHeader('admin'));

    expect(descriptions(res)).toEqual(FEED.map((e) => e.description));
  });
});
