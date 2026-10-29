/**
 * Files on a task (visits-and-task-categories slice 12) - who may touch a TASK attachment.
 *
 * A task's files are exactly as private as the task. Access is the task visibility rule
 * (`canAccessTask`): admin always; an assignee or a watcher always; anybody else only through
 * the task's linked record, and an unlinked task is closed to them. That rule replaces the
 * per-role switch for TASK, and it is evaluated BEFORE the admin/dispatcher shortcut, which
 * would otherwise hand every dispatcher every task's files.
 *
 * Prior art: attachment-visit-crew-access.test.ts. The task fake HONOURS the tenant filter the
 * controller sends, so a TASK lookup that forgot `tenantWhere` would read another org's task
 * and this file would say so.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { supabaseAdmin } from '../lib/supabase';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { clearUserOverrideCache } from '../lib/permissions/userOverrideCache';
import { signUploadTicket } from '../lib/attachment-direct-upload';
import { MAX_ENTITY_SIZE, MAX_FILE_SIZE, MAX_VIDEO_FILE_SIZE } from '../controllers/attachment.controller';
import { sizeLimitLabel } from '../middleware/multerErrors';
import { mockAuthAs, authHeader, TEST_USERS, ALPHA_ORG_ID, type TestUserKey } from './helpers';

const mockPrisma = prisma as unknown as Record<string, any>;

const TASK_ID = 'aa000000-0000-0000-0000-0000000000c1';
const JOB_ID = '10000000-0000-0000-0000-0000000000c1';
const ATT_ID = 'ab000000-0000-0000-0000-0000000000c1';
const TECH_ID = TEST_USERS.technician.id;
const STRANGER_ID = '00000000-0000-0000-0000-0000000000c9';

interface TaskShape {
  assignee_ids: string[];
  watcher_ids: string[];
  linked_entity_type: string | null;
  linked_entity_id: string | null;
}

const UNLINKED: TaskShape = { assignee_ids: [STRANGER_ID], watcher_ids: [], linked_entity_type: null, linked_entity_id: null };

/** A task that exists ONLY in ALPHA_ORG_ID, answered only when the lookup is tenant-scoped. */
function givenTask(shape: TaskShape) {
  mockPrisma.task.findFirst.mockImplementation(async (args: any) => {
    const where = args?.where ?? {};
    if (where.id !== TASK_ID || where.organization_id !== ALPHA_ORG_ID) return null;
    return { id: TASK_ID, organization_id: ALPHA_ORG_ID, ...shape };
  });
}

function as(user: TestUserKey) {
  mockAuthAs(user);
  return authHeader(user);
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  clearUserOverrideCache();
  mockPrisma.attachment.findMany.mockResolvedValue([]);
  mockPrisma.attachment.aggregate.mockResolvedValue({ _sum: { file_size: 0 } });
  mockPrisma.timelineEvent.create.mockResolvedValue({ id: 'ev-1' });
  mockPrisma.job.findFirst.mockResolvedValue(null);
});

describe('GET /api/attachments/task/:id - reading a task\'s files follows task visibility', () => {
  it('lets an admin list the files of any task in the org', async () => {
    givenTask(UNLINKED);
    const res = await request(app).get(`/api/attachments/task/${TASK_ID}`).set(as('admin'));
    expect(res.status).toBe(200);
    expect(res.body.attachments).toEqual([]);
    expect(mockPrisma.attachment.findMany.mock.calls[0][0].where).toMatchObject({
      entity_type: 'TASK',
      entity_id: TASK_ID,
      organization_id: ALPHA_ORG_ID,
    });
  });
});

const storage = supabaseAdmin.storage.from('attachments') as unknown as {
  upload: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
};

const LINKED_TO_JOB: TaskShape = { assignee_ids: [STRANGER_ID], watcher_ids: [], linked_entity_type: 'JOB', linked_entity_id: JOB_ID };

/** A JPEG the F-35 sniff accepts. */
function jpeg(size = 1024): Buffer {
  const b = Buffer.alloc(size);
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff;
  return b;
}

function upload(headers: Record<string, string>) {
  return request(app)
    .post(`/api/attachments/task/${TASK_ID}`)
    .set(headers)
    .field('display_name', 'Gate photo')
    .field('description', '')
    .attach('file', jpeg(), { filename: 'gate.jpg', contentType: 'image/jpeg' });
}

describe('the access matrix - assignee, watcher and admin in; a stranger out', () => {
  it('lets the technician ASSIGNED to the task list its files', async () => {
    givenTask({ ...UNLINKED, assignee_ids: [TECH_ID] });
    const res = await request(app).get(`/api/attachments/task/${TASK_ID}`).set(as('technician'));
    expect(res.status).toBe(200);
  });

  it('lets a WATCHER list its files', async () => {
    givenTask({ ...UNLINKED, watcher_ids: [TECH_ID] });
    const res = await request(app).get(`/api/attachments/task/${TASK_ID}`).set(as('technician'));
    expect(res.status).toBe(200);
  });

  it('lets the assignee upload a file, stored under the task and nowhere else', async () => {
    givenTask({ ...LINKED_TO_JOB, assignee_ids: [TECH_ID] });
    mockPrisma.attachment.create.mockImplementation(async (args: any) => ({ id: ATT_ID, ...args.data }));

    const res = await upload(as('technician'));

    expect(res.status).toBe(201);
    const data = mockPrisma.attachment.create.mock.calls[0][0].data;
    // The task's, never the linked job's: the row names the TASK and the object lives under
    // the per-entity `task` segment the orphan sweep owns.
    expect(data).toMatchObject({ entity_type: 'TASK', entity_id: TASK_ID, organization_id: ALPHA_ORG_ID, uploaded_by: TECH_ID });
    expect(data.storage_path).toMatch(new RegExp(`^${ALPHA_ORG_ID}/task/${TASK_ID}/\\d+-gate\\.jpg$`));
    expect(storage.upload.mock.calls[0][0]).toBe(data.storage_path);
  });

  it('lets an admin upload to a task they are not on', async () => {
    givenTask(UNLINKED);
    mockPrisma.attachment.create.mockImplementation(async (args: any) => ({ id: ATT_ID, ...args.data }));
    const res = await upload(as('admin'));
    expect(res.status).toBe(201);
  });

  it('records the upload on the TASK timeline, which is the drawer activity feed', async () => {
    givenTask({ ...UNLINKED, assignee_ids: [TECH_ID] });
    mockPrisma.attachment.create.mockImplementation(async (args: any) => ({ id: ATT_ID, ...args.data }));

    await upload(as('technician'));

    expect(mockPrisma.timelineEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ entity_type: 'TASK', entity_id: TASK_ID, event_type: 'ATTACHMENT_UPLOADED' }),
    });
  });

  it('refuses a DISPATCHER on an unlinked task they are not on - the role shortcut does not apply to TASK', async () => {
    givenTask(UNLINKED);
    const res = await request(app).get(`/api/attachments/task/${TASK_ID}`).set(as('dispatcher'));
    expect(res.status).toBe(403);
  });

  it('lets a DISPATCHER in through a linked record they can open', async () => {
    givenTask(LINKED_TO_JOB);
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });
    const res = await request(app).get(`/api/attachments/task/${TASK_ID}`).set(as('dispatcher'));
    expect(res.status).toBe(200);
  });

  it('refuses a task in another org, even to an admin', async () => {
    mockPrisma.task.findFirst.mockResolvedValue(null);
    const list = await request(app).get(`/api/attachments/task/${TASK_ID}`).set(as('admin'));
    expect(list.status).toBe(403);
    const up = await upload(authHeader('admin'));
    expect(up.status).toBe(404);
  });
});

describe('a technician unrelated to the task is refused on every attachment route', () => {
  // Not assigned, not watching, and the linked job is outside their scope.
  beforeEach(() => {
    givenTask(LINKED_TO_JOB);
    mockPrisma.job.findFirst.mockResolvedValue(null);
    mockPrisma.attachment.findFirst.mockResolvedValue({ id: ATT_ID, uploaded_by: TECH_ID, storage_path: 'x', file_url: '', display_name: 'x', file_name: 'x' });
  });

  it('GET list', async () => {
    const res = await request(app).get(`/api/attachments/task/${TASK_ID}`).set(as('technician'));
    expect(res.status).toBe(403);
  });

  it('POST multipart upload', async () => {
    const res = await upload(as('technician'));
    expect(res.status).toBe(403);
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('POST direct-upload (mint)', async () => {
    const res = await request(app)
      .post(`/api/attachments/task/${TASK_ID}/direct-upload`)
      .set(as('technician'))
      .send({ file_name: 'clip.mp4', content_type: 'video/mp4', file_size: 1024 });
    expect(res.status).toBe(403);
  });

  it('POST direct-upload/complete', async () => {
    const ticket = signUploadTicket({
      org: ALPHA_ORG_ID, et: 'TASK', eid: TASK_ID, path: `${ALPHA_ORG_ID}/task/${TASK_ID}/1-clip.mp4`,
      mime: 'video/mp4', name: 'clip.mp4', uid: TECH_ID,
    });
    const res = await request(app)
      .post(`/api/attachments/task/${TASK_ID}/direct-upload/complete`)
      .set(as('technician'))
      .send({ ticket, display_name: 'Clip', description: 'x' });
    expect(res.status).toBe(403);
    expect(mockPrisma.attachment.create).not.toHaveBeenCalled();
  });

  it('PATCH rename - even of a file they uploaded themselves', async () => {
    const res = await request(app)
      .patch(`/api/attachments/task/${TASK_ID}/${ATT_ID}`)
      .set(as('technician'))
      .send({ display_name: 'Renamed' });
    expect(res.status).toBe(403);
    expect(mockPrisma.attachment.update).not.toHaveBeenCalled();
  });

  it('DELETE - even of a file they uploaded themselves', async () => {
    const res = await request(app).delete(`/api/attachments/task/${TASK_ID}/${ATT_ID}`).set(as('technician'));
    expect(res.status).toBe(403);
    expect(storage.remove).not.toHaveBeenCalled();
    expect(mockPrisma.attachment.deleteMany).not.toHaveBeenCalled();
  });
});

describe('rename and remove - the grant, or a file you uploaded yourself on a task you can see', () => {
  const MINE = { id: ATT_ID, uploaded_by: TECH_ID, storage_path: `${ALPHA_ORG_ID}/task/${TASK_ID}/1-gate.jpg`, file_url: '', display_name: 'Gate photo', file_name: 'gate.jpg' };
  const THEIRS = { ...MINE, uploaded_by: STRANGER_ID };

  beforeEach(() => {
    mockPrisma.attachment.update.mockImplementation(async (args: any) => ({ id: ATT_ID, ...args.data }));
    mockPrisma.attachment.deleteMany.mockResolvedValue({ count: 1 });
  });

  it('lets the assigned technician (no update grant) rename a file they uploaded', async () => {
    givenTask({ ...UNLINKED, assignee_ids: [TECH_ID] });
    mockPrisma.attachment.findFirst.mockResolvedValue(MINE);

    const res = await request(app)
      .patch(`/api/attachments/task/${TASK_ID}/${ATT_ID}`)
      .set(as('technician'))
      .send({ display_name: 'Front gate' });

    expect(res.status).toBe(200);
    expect(mockPrisma.attachment.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: ATT_ID },
      data: { display_name: 'Front gate' },
    }));
  });

  it('refuses the assigned technician a rename of somebody else\'s file', async () => {
    givenTask({ ...UNLINKED, assignee_ids: [TECH_ID] });
    mockPrisma.attachment.findFirst.mockResolvedValue(THEIRS);

    const res = await request(app)
      .patch(`/api/attachments/task/${TASK_ID}/${ATT_ID}`)
      .set(as('technician'))
      .send({ display_name: 'Front gate' });

    expect(res.status).toBe(403);
    expect(mockPrisma.attachment.update).not.toHaveBeenCalled();
  });

  it('lets the assigned technician (no delete grant) remove a file they uploaded - row and object', async () => {
    givenTask({ ...UNLINKED, assignee_ids: [TECH_ID] });
    mockPrisma.attachment.findFirst.mockResolvedValue(MINE);

    const res = await request(app).delete(`/api/attachments/task/${TASK_ID}/${ATT_ID}`).set(as('technician'));

    expect(res.status).toBe(200);
    expect(storage.remove).toHaveBeenCalledWith([MINE.storage_path]);
    expect(mockPrisma.attachment.deleteMany).toHaveBeenCalledWith({ where: { id: ATT_ID } });
  });

  it('refuses the assigned technician removal of somebody else\'s file', async () => {
    givenTask({ ...UNLINKED, assignee_ids: [TECH_ID] });
    mockPrisma.attachment.findFirst.mockResolvedValue(THEIRS);

    const res = await request(app).delete(`/api/attachments/task/${TASK_ID}/${ATT_ID}`).set(as('technician'));

    expect(res.status).toBe(403);
    expect(storage.remove).not.toHaveBeenCalled();
    expect(mockPrisma.attachment.deleteMany).not.toHaveBeenCalled();
  });

  it('lets a watcher who HOLDS the grant (sales) rename and remove anybody\'s file on the task', async () => {
    givenTask({ ...UNLINKED, watcher_ids: [TEST_USERS.sales.id] });
    mockPrisma.attachment.findFirst.mockResolvedValue(THEIRS);

    const renamed = await request(app)
      .patch(`/api/attachments/task/${TASK_ID}/${ATT_ID}`)
      .set(as('sales'))
      .send({ display_name: 'Front gate' });
    expect(renamed.status).toBe(200);

    const removed = await request(app).delete(`/api/attachments/task/${TASK_ID}/${ATT_ID}`).set(authHeader('sales'));
    expect(removed.status).toBe(200);
  });

  it('does NOT widen anything off a task: a technician still cannot rename their own JOB file', async () => {
    mockPrisma.job.findUnique.mockResolvedValue({ id: JOB_ID, visits: [{ assignees: [{ user_id: TECH_ID }] }] });
    mockPrisma.attachment.findFirst.mockResolvedValue(MINE);

    const res = await request(app)
      .patch(`/api/attachments/job/${JOB_ID}/${ATT_ID}`)
      .set(as('technician'))
      .send({ display_name: 'Front gate' });

    expect(res.status).toBe(403);
    expect(mockPrisma.attachment.update).not.toHaveBeenCalled();
  });
});

describe('size limits and the resumable video path are the same as on every other entity', () => {
  beforeEach(() => givenTask({ ...UNLINKED, assignee_ids: [TECH_ID] }));

  function mintVideo(file_size: number) {
    return request(app)
      .post(`/api/attachments/task/${TASK_ID}/direct-upload`)
      .set(as('technician'))
      .send({ file_name: 'walkthrough.mp4', content_type: 'video/mp4', file_size });
  }

  it('mints a direct (resumable) upload for a large video, scoped to the task path', async () => {
    const res = await mintVideo(400 * 1024 * 1024);
    expect(res.status).toBe(201);
    expect(res.body.upload.path).toMatch(new RegExp(`^${ALPHA_ORG_ID}/task/${TASK_ID}/\\d+-walkthrough\\.mp4$`));
    expect(res.body.upload.ticket).toEqual(expect.any(String));
  });

  it('refuses a video over the per-file cap with the shared message', async () => {
    const res = await mintVideo(MAX_VIDEO_FILE_SIZE + 1);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(`File too large. Maximum: ${sizeLimitLabel(MAX_VIDEO_FILE_SIZE)}`);
  });

  it('refuses an upload that would push the task past the per-entity total', async () => {
    mockPrisma.attachment.aggregate.mockResolvedValue({ _sum: { file_size: MAX_ENTITY_SIZE - 10 } });
    const res = await mintVideo(1024);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Total attachments for this entity would exceed/);
    // The total is the TASK's own, not the linked record's.
    expect(mockPrisma.attachment.aggregate.mock.calls[0][0].where).toMatchObject({ entity_type: 'TASK', entity_id: TASK_ID });
  });

  it('refuses a non-video file over the proxy cap', async () => {
    const res = await request(app)
      .post(`/api/attachments/task/${TASK_ID}`)
      .set(as('technician'))
      .field('display_name', 'Big')
      .field('description', '')
      .attach('file', jpeg(MAX_FILE_SIZE + 1), { filename: 'big.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(`File too large. Maximum: ${sizeLimitLabel(MAX_FILE_SIZE)}`);
  });
});

describe('a task file belongs to the task alone', () => {
  it('never appears on the job, lead or customer the task is linked to', async () => {
    // One in-memory attachments table, answered by the `where` each list actually sends.
    const table: any[] = [];
    mockPrisma.attachment.create.mockImplementation(async (args: any) => {
      const row = { id: ATT_ID, ...args.data, created_at: new Date(), uploader: null };
      table.push(row);
      return row;
    });
    mockPrisma.attachment.findMany.mockImplementation(async (args: any) =>
      table.filter((r) => r.entity_type === args.where.entity_type && r.entity_id === args.where.entity_id));

    givenTask({ ...LINKED_TO_JOB, assignee_ids: [TECH_ID] });
    const up = await upload(as('technician'));
    expect(up.status).toBe(201);
    expect(table).toHaveLength(1);

    mockPrisma.job.findUnique.mockResolvedValue({ id: JOB_ID });
    mockPrisma.job.findFirst.mockResolvedValue({ lead_id: null, estimate: null });
    const onJob = await request(app).get(`/api/attachments/job/${JOB_ID}?include_lead=true`).set(as('admin'));
    expect(onJob.status).toBe(200);
    expect(onJob.body.attachments).toEqual([]);

    const onTask = await request(app).get(`/api/attachments/task/${TASK_ID}`).set(authHeader('admin'));
    expect(onTask.body.attachments.map((a: any) => a.id)).toEqual([ATT_ID]);
  });
});
