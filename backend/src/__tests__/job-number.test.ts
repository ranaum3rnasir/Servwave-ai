import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, JOB_FIXTURE, ALPHA_ORG_ID } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

/**
 * Editable record IDs (plan decision #7) - HTTP/controller layer for the job entity's
 * preview + rename endpoints. Does NOT re-test record-renumber.ts's own engine internals
 * (see record-renumber.test.ts for that) - only the permission gate, 404, request/response
 * shape, and that the controller locks the parent row before calling applyRenumber.
 *
 * record-renumber.ts is NOT globally mocked in setup.ts, so these tests call the real engine
 * functions against the standard mocked prisma delegates, same as every other controller test.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

// ─────────────────────────────────────────────────────────────────────────
// Same tiny in-memory Prisma-delegate emulator record-renumber.test.ts uses (duplicated here,
// not imported - this file owns its own fixtures and must not reach into a sibling test file).
// ─────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function matchesWhere(row: Row, where: Row): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (key === 'OR') {
      if (!(cond as Row[]).some((sub) => matchesWhere(row, sub))) return false;
      continue;
    }
    if (key === 'AND') {
      if (!(cond as Row[]).every((sub) => matchesWhere(row, sub))) return false;
      continue;
    }
    if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
      if ('equals' in cond) {
        const want = (cond as { equals: unknown; mode?: string }).equals;
        if ((cond as { mode?: string }).mode === 'insensitive') {
          if (String(row[key] ?? '').toLowerCase() !== String(want ?? '').toLowerCase()) return false;
        } else if (row[key] !== want) {
          return false;
        }
        continue;
      }
      if ('not' in cond) {
        if (row[key] === (cond as { not: unknown }).not) return false;
        continue;
      }
    }
    if (row[key] !== cond) return false;
  }
  return true;
}

// `model` is a mocked Prisma delegate at runtime (vi.fn()-bearing object, see setup.ts's
// `vi.mock('../lib/prisma', ...)`) - cast to `Mock` per-method rather than typed up front.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function installTable(model: any, rows: Row[]): Row[] {
  const findUnique = model.findUnique as Mock | undefined;
  const findFirst = model.findFirst as Mock | undefined;
  const findMany = model.findMany as Mock | undefined;
  const update = model.update as Mock | undefined;
  const updateMany = model.updateMany as Mock | undefined;

  const lookup = async ({ where }: { where: Row }) => rows.find((r) => matchesWhere(r, where)) ?? null;
  if (findUnique) findUnique.mockImplementation(lookup);
  if (findFirst) findFirst.mockImplementation(lookup);
  if (findMany) findMany.mockImplementation(async ({ where }: { where: Row }) => rows.filter((r) => matchesWhere(r, where)));
  if (update) {
    update.mockImplementation(async ({ where, data }: { where: Row; data: Row }) => {
      const row = rows.find((r) => matchesWhere(r, where));
      if (!row) throw new Error(`mock update: no row matches ${JSON.stringify(where)}`);
      Object.assign(row, data);
      return { ...row };
    });
  }
  if (updateMany) {
    updateMany.mockImplementation(async ({ where, data }: { where: Row; data: Row }) => {
      const matched = rows.filter((r) => matchesWhere(r, where));
      matched.forEach((r) => Object.assign(r, data));
      return { count: matched.length };
    });
  }
  return rows;
}

/** Every job-entity computeRenumber/applyRenumber call iterates all 10 configured label-target
 * tables regardless of what a given test cares about - install [] for each so an un-installed
 * vi.fn() doesn't resolve to `undefined`. */
function installEmptyJobLabelTargets(): void {
  installTable(prisma.jobStage, []);
  installTable(prisma.rfq, []);
  installTable(prisma.stockApproval, []);
  installTable(prisma.estimateReservation, []);
  installTable(prisma.timeEntry, []);
  installTable(prisma.callSession, []);
  installTable(prisma.message, []);
  installTable(prisma.whatsAppMessage, []);
  installTable(prisma.email, []);
  installTable(prisma.pendingCallAttribution, []);
}

/** The verb handlers pass $transaction a CALLBACK; mirror the real Prisma shape by invoking it
 * with the mocked client itself as `tx` (every delegate/raw method resolves the same fakes). */
function installTransactionPassthrough(): void {
  (prisma.$transaction as Mock).mockImplementation(async (arg: unknown) =>
    typeof arg === 'function' ? (arg as (tx: unknown) => Promise<unknown>)(prisma) : Promise.all(arg as Promise<unknown>[]),
  );
}

const OLD_NUMBER = JOB_FIXTURE.job_number; // 'J00001'
const NEW_NUMBER = 'J00099';

function jobRow(overrides: Row = {}): Row {
  return {
    id: JOB_FIXTURE.id,
    job_number: OLD_NUMBER,
    organization_id: ALPHA_ORG_ID,
    original_number: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  installTransactionPassthrough();
  (prisma.$executeRaw as Mock).mockResolvedValue(1);
  (prisma.$queryRaw as Mock).mockResolvedValue([]); // no anchored logistic orders by default
  installTable(prisma.estimate, []); // no container-estimate cascade by default
  installTable(prisma.logisticOrder, []);
  installEmptyJobLabelTargets();
});

// ─────────────────────────────────────────────────────────────────────────
// POST /api/jobs/:id/number/preview
// ─────────────────────────────────────────────────────────────────────────

describe('POST /api/jobs/:id/number/preview', () => {
  it('returns the computation shape for a clean rename', async () => {
    mockAuthAs('admin');
    installTable(prisma.job, [jobRow()]);

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/number/preview`)
      .set(authHeader('admin'))
      .send({ number: NEW_NUMBER });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      entity: 'job',
      parentId: JOB_FIXTURE.id,
      oldNumber: OLD_NUMBER,
      newNumber: NEW_NUMBER,
      parentConflict: false,
      hasConflicts: false,
      derived: [],
      labelRefreshes: [],
    });
    // Read-only: no lock taken, no writes attempted.
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(prisma.job.update).not.toHaveBeenCalled();
  });

  it('404s a nonexistent id', async () => {
    mockAuthAs('admin');
    (prisma.job.findUnique as Mock).mockResolvedValue(null);

    const res = await request(app)
      .post('/api/jobs/00000000-0000-0000-0000-000000000fff/number/preview')
      .set(authHeader('admin'))
      .send({ number: NEW_NUMBER });

    expect(res.status).toBe(404);
  });

  it('403s a role without the renumber/Job grant', async () => {
    mockAuthAs('sales');
    installTable(prisma.job, [jobRow()]);

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/number/preview`)
      .set(authHeader('sales'))
      .send({ number: NEW_NUMBER });

    expect(res.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// PATCH /api/jobs/:id/number
// ─────────────────────────────────────────────────────────────────────────

describe('PATCH /api/jobs/:id/number', () => {
  it('403s a role without the renumber/Job grant', async () => {
    mockAuthAs('sales');
    installTable(prisma.job, [jobRow()]);

    const res = await request(app)
      .patch(`/api/jobs/${JOB_FIXTURE.id}/number`)
      .set(authHeader('sales'))
      .send({ number: NEW_NUMBER });

    expect(res.status).toBe(403);
    expect(prisma.job.update).not.toHaveBeenCalled();
  });

  it('404s a nonexistent id', async () => {
    mockAuthAs('admin');
    (prisma.job.findUnique as Mock).mockResolvedValue(null);

    const res = await request(app)
      .patch('/api/jobs/00000000-0000-0000-0000-000000000fff/number')
      .set(authHeader('admin'))
      .send({ number: NEW_NUMBER });

    expect(res.status).toBe(404);
    expect(prisma.job.update).not.toHaveBeenCalled();
  });

  it('400s an invalid number format (contains a slash)', async () => {
    mockAuthAs('admin');
    installTable(prisma.job, [jobRow()]);

    const res = await request(app)
      .patch(`/api/jobs/${JOB_FIXTURE.id}/number`)
      .set(authHeader('admin'))
      .send({ number: '123/456' });

    expect(res.status).toBe(400);
    expect(prisma.job.update).not.toHaveBeenCalled();
  });

  it('200s on a clean, no-conflict rename - locks the row, writes the new number, a timeline event, and an audit entry', async () => {
    mockAuthAs('admin');
    const row = jobRow();
    installTable(prisma.job, [row]);
    (prisma.auditLog.create as Mock).mockResolvedValue({});

    const res = await request(app)
      .patch(`/api/jobs/${JOB_FIXTURE.id}/number`)
      .set(authHeader('admin'))
      .send({ number: NEW_NUMBER });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      oldNumber: OLD_NUMBER,
      newNumber: NEW_NUMBER,
      hasConflicts: false,
      derived: [],
      labelRefreshes: [],
    });

    // The row-lock statement ran before the write, inside the same transaction.
    expect(prisma.$executeRaw).toHaveBeenCalled();
    const lockSql = (prisma.$executeRaw as Mock).mock.calls[0][0] as TemplateStringsArray;
    expect(lockSql.join('')).toMatch(/FROM jobs/i);
    expect(lockSql.join('')).toMatch(/FOR NO KEY UPDATE/i);

    // The actual number write.
    expect(prisma.job.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: JOB_FIXTURE.id },
        data: expect.objectContaining({
          job_number: NEW_NUMBER,
          number_is_custom: true,
          original_number: OLD_NUMBER,
        }),
      }),
    );

    const event = (prisma.timelineEvent.create as Mock).mock.calls
      .map((c) => (c[0] as { data: Row }).data)
      .find((d) => d.event_type === 'JOB_RENUMBERED');
    expect(event).toBeDefined();
    expect(event!.entity_type).toBe('JOB');
    expect(event!.entity_id).toBe(JOB_FIXTURE.id);
    expect(event!.metadata).toEqual({ old_number: OLD_NUMBER, new_number: NEW_NUMBER, derived_count: 0 });
    expect(event!.description).toContain(OLD_NUMBER);
    expect(event!.description).toContain(NEW_NUMBER);

    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'job.renumbered',
          resource_type: 'Job',
          resource_id: JOB_FIXTURE.id,
        }),
      }),
    );
  });

  it('409s when the target number is already taken by another job in the org', async () => {
    mockAuthAs('admin');
    const row = jobRow();
    const conflicting = jobRow({ id: 'j0000000-0000-0000-0000-000000000fff', job_number: NEW_NUMBER });
    installTable(prisma.job, [row, conflicting]);

    const res = await request(app)
      .patch(`/api/jobs/${JOB_FIXTURE.id}/number`)
      .set(authHeader('admin'))
      .send({ number: NEW_NUMBER });

    expect(res.status).toBe(409);
    expect(res.body.hasConflicts).toBe(true);
    expect(res.body.parentConflict).toBe(true);
    expect(res.body.parentConflictWithId).toBe(conflicting.id);
    // No partial write - the conflict is caught before any job.update.
    expect(prisma.job.update).not.toHaveBeenCalled();
    expect(prisma.timelineEvent.create).not.toHaveBeenCalled();
  });
});
