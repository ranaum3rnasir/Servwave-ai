import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, ALPHA_ORG_ID, ORG_B_ID } from './helpers';

const LOCATION_FIXTURE = {
  id: 'a0000000-0000-0000-0000-0000000000aa',
  organization_id: ALPHA_ORG_ID,
  name: 'Main Branch',
  code: 'MAIN',
  address_line1: '1 Main St',
  city: 'Austin',
  state: 'TX',
  postal_code: '78701',
  country: 'US',
  timezone: 'America/Chicago',
  phone: null,
  manager_id: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/locations', () => {
  it('lists scoped to org', async () => {
    mockAuthAs('admin');
    (prisma.location.findMany as any).mockResolvedValue([LOCATION_FIXTURE]);
    const res = await request(app).get('/api/locations').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect((prisma.location.findMany as any).mock.calls[0][0].where).toMatchObject({
      organization_id: ALPHA_ORG_ID,
    });
  });
});

describe('POST /api/locations', () => {
  it('creates with requesting org', async () => {
    mockAuthAs('admin');
    (prisma.location.create as any).mockResolvedValue(LOCATION_FIXTURE);
    const res = await request(app)
      .post('/api/locations')
      .set(authHeader('admin'))
      .send({ name: 'Main Branch', code: 'MAIN', city: 'Austin', state: 'TX' });
    expect(res.status).toBe(201);
    expect((prisma.location.create as any).mock.calls[0][0].data).toMatchObject({
      organization_id: ALPHA_ORG_ID,
      name: 'Main Branch',
      code: 'MAIN',
    });
  });
  it('rejects missing name (400)', async () => {
    mockAuthAs('admin');
    const res = await request(app).post('/api/locations').set(authHeader('admin')).send({ code: 'X' });
    expect(res.status).toBe(400);
  });
  // Visit-location spec D7. `.min(1)` counts spaces, and every one of this row's address fields
  // is optional, so a location could be created through the ordinary API carrying no legible text
  // at all - after which a walkthrough booked there rendered "Please meet us at  ." in a
  // customer's inbox. The name is the one field always present, so it is the one that has to
  // survive trimming.
  it('rejects a whitespace-only name (400), not just a missing one', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .post('/api/locations')
      .set(authHeader('admin'))
      .send({ name: '   ' });
    expect(res.status).toBe(400);
    expect((prisma.location.create as any)).not.toHaveBeenCalled();
  });

  it('stores the trimmed name, so padding never reaches the column', async () => {
    mockAuthAs('admin');
    (prisma.location.create as any).mockResolvedValue(LOCATION_FIXTURE);
    const res = await request(app)
      .post('/api/locations')
      .set(authHeader('admin'))
      .send({ name: '  Showroom  ' });
    expect(res.status).toBe(201);
    expect((prisma.location.create as any).mock.calls[0][0].data).toMatchObject({ name: 'Showroom' });
  });

  it('creates without a code (code is no longer required)', async () => {
    mockAuthAs('admin');
    (prisma.location.create as any).mockResolvedValue({ ...LOCATION_FIXTURE, code: null });
    const res = await request(app)
      .post('/api/locations')
      .set(authHeader('admin'))
      .send({ name: 'Warehouse', city: 'Austin' });
    expect(res.status).toBe(201);
    expect((prisma.location.create as any).mock.calls[0][0].data).toMatchObject({
      organization_id: ALPHA_ORG_ID,
      name: 'Warehouse',
    });
  });
});

describe('PATCH /api/locations/:id', () => {
  it('updates only within org', async () => {
    mockAuthAs('admin');
    (prisma.location.updateMany as any).mockResolvedValue({ count: 1 });
    (prisma.location.findFirst as any).mockResolvedValue({ ...LOCATION_FIXTURE, name: 'Renamed' });
    const res = await request(app)
      .patch(`/api/locations/${LOCATION_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ name: 'Renamed' });
    expect(res.status).toBe(200);
    expect((prisma.location.updateMany as any).mock.calls[0][0].where).toMatchObject({
      id: LOCATION_FIXTURE.id,
      organization_id: ALPHA_ORG_ID,
    });
  });
  it('accepts a full echoed row (created_at/updated_at/null optionals) without 400', async () => {
    // #107 (C2): the FE row-click loads the raw API row; an edit must round-trip
    // even with server-echoed read-only keys and null optionals present.
    mockAuthAs('admin');
    (prisma.location.updateMany as any).mockResolvedValue({ count: 1 });
    (prisma.location.findFirst as any).mockResolvedValue({ ...LOCATION_FIXTURE, name: 'Renamed' });
    const res = await request(app)
      .patch(`/api/locations/${LOCATION_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({
        ...LOCATION_FIXTURE,
        name: 'Renamed',
        address_line2: null,
        postal_code: null,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-02T00:00:00.000Z',
        manager: null,
        _count: { members: 0 },
      });
    expect(res.status).toBe(200);
    // read-only / relational keys must not reach the Prisma write payload
    const data = (prisma.location.updateMany as any).mock.calls[0][0].data;
    expect(data).not.toHaveProperty('created_at');
    expect(data).not.toHaveProperty('updated_at');
    expect(data).not.toHaveProperty('manager');
    expect(data).not.toHaveProperty('_count');
    expect(data).not.toHaveProperty('id');
  });

  // The Edit door has to refuse what Create refuses, or the blank name walks in through the other
  // side. It inherits the rule via `.partial()` rather than restating it - this pins that it
  // actually arrives.
  it('rejects blanking the name to whitespace on an edit (400)', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .patch(`/api/locations/${LOCATION_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ name: '  ' });
    expect(res.status).toBe(400);
    expect((prisma.location.updateMany as any)).not.toHaveBeenCalled();
  });

  it('accepts manager_id = null (— None — selection)', async () => {
    // #107 (C3): "— None —" must clear the manager, not 400.
    mockAuthAs('admin');
    (prisma.location.updateMany as any).mockResolvedValue({ count: 1 });
    (prisma.location.findFirst as any).mockResolvedValue({ ...LOCATION_FIXTURE, manager_id: null });
    const res = await request(app)
      .patch(`/api/locations/${LOCATION_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ manager_id: null });
    expect(res.status).toBe(200);
    expect((prisma.location.updateMany as any).mock.calls[0][0].data).toMatchObject({ manager_id: null });
  });

  it('404 when cross-org (count 0)', async () => {
    mockAuthAs('orgB_admin');
    (prisma.location.updateMany as any).mockResolvedValue({ count: 0 });
    const res = await request(app)
      .patch(`/api/locations/${LOCATION_FIXTURE.id}`)
      .set(authHeader('orgB_admin'))
      .send({ name: 'x' });
    expect(res.status).toBe(404);
    expect((prisma.location.updateMany as any).mock.calls[0][0].where).toMatchObject({
      organization_id: ORG_B_ID,
    });
  });
});

describe('DELETE /api/locations/:id', () => {
  it('blocks delete when users reference it (409)', async () => {
    mockAuthAs('admin');
    (prisma.user.count as any).mockResolvedValue(2);
    (prisma.visit.count as any).mockResolvedValue(0);
    const res = await request(app).delete(`/api/locations/${LOCATION_FIXTURE.id}`).set(authHeader('admin'));
    expect(res.status).toBe(409);
  });

  // The refusal used to report in TWO ROUNDS: with both users assigned and visits booked it named
  // only the users, so the admin reassigned four people, retried, and only then learned about the
  // visits - which, unlike the users, they cannot clear at all. Both counts are taken before the
  // refusal is composed, so one message names everything standing in the way.
  it('names EVERY blocker in one message, not the first one it finds', async () => {
    mockAuthAs('admin');
    (prisma.user.count as any).mockResolvedValue(2);
    (prisma.visit.count as any).mockResolvedValue(3);

    const res = await request(app).delete(`/api/locations/${LOCATION_FIXTURE.id}`).set(authHeader('admin'));

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/2 user/i);
    expect(res.body.error).toMatch(/3 visit/i);
    expect((prisma.location.deleteMany as any)).not.toHaveBeenCalled();
  });

  // Slice 2's whole point: the 409 is no longer a dead end. Refusing without naming the way out
  // leaves an admin closing a branch with nothing to do but reassign records they should not be
  // touching - which is the pressure that makes people delete data.
  it('points the admin at archiving rather than just refusing', async () => {
    mockAuthAs('admin');
    (prisma.user.count as any).mockResolvedValue(0);
    (prisma.visit.count as any).mockResolvedValue(1);

    const res = await request(app).delete(`/api/locations/${LOCATION_FIXTURE.id}`).set(authHeader('admin'));

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/archiv/i);
  });

  it('counts a single blocker in the singular', async () => {
    mockAuthAs('admin');
    (prisma.user.count as any).mockResolvedValue(1);
    (prisma.visit.count as any).mockResolvedValue(0);

    const res = await request(app).delete(`/api/locations/${LOCATION_FIXTURE.id}`).set(authHeader('admin'));

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/1 user\b/i);
    expect(res.body.error).not.toMatch(/1 users/i);
    // ...and does not invent a second blocker that is not there.
    expect(res.body.error).not.toMatch(/visit/i);
  });
  it('deletes within org when unreferenced', async () => {
    mockAuthAs('admin');
    (prisma.user.count as any).mockResolvedValue(0);
    (prisma.visit.count as any).mockResolvedValue(0);
    (prisma.location.deleteMany as any).mockResolvedValue({ count: 1 });
    const res = await request(app).delete(`/api/locations/${LOCATION_FIXTURE.id}`).set(authHeader('admin'));
    expect(res.status).toBe(204);
    expect((prisma.location.deleteMany as any).mock.calls[0][0].where).toMatchObject({
      id: LOCATION_FIXTURE.id,
      organization_id: ALPHA_ORG_ID,
    });
  });

  // Visit-location spec D9. `visits.location_id` is ON DELETE RESTRICT, deliberately: nulling the
  // reference would silently move a booked visit back to the customer's own address after the
  // customer has been told to come here. Unguarded, that restriction surfaces as a P2003 the
  // generic catch turns into an opaque 500 on a perfectly reasonable admin action.
  it('blocks delete when visits are booked at it, naming the count (409, not 500)', async () => {
    mockAuthAs('admin');
    (prisma.user.count as any).mockResolvedValue(0);
    (prisma.visit.count as any).mockResolvedValue(3);

    const res = await request(app).delete(`/api/locations/${LOCATION_FIXTURE.id}`).set(authHeader('admin'));

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('3');
    expect(res.body.error).toMatch(/visit/i);
    expect((prisma.location.deleteMany as any)).not.toHaveBeenCalled();
  });

  // ── slice 4: the guard counts JOB visits too ──────────────────────────────
  //
  // Slice: md_files/issues/scheduling/04-give-job-visits-their-own-location.md
  //
  // Slice 1 wrote this guard while only walkthroughs could name a location, so "a visit" meant "a
  // lead's visit" in practice and no test could tell the difference - `visit.count` was mocked to
  // a NUMBER, which answers the same whatever the where clause asks. The mock below answers over a
  // small table with the clause applied, so a guard narrowed to `lead_id: { not: null }` returns 0
  // here and the delete goes through - and the restricting foreign key then surfaces as a P2003
  // the generic catch turns into an opaque 500 on an ordinary admin action.

  /** `visit.count` over a table, honouring every key of the where clause. */
  function countOver(rows: Record<string, unknown>[]) {
    (prisma.visit.count as any).mockImplementation(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(
        rows.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v)).length,
      ),
    );
  }

  const LEAD_VISIT_HERE = {
    location_id: LOCATION_FIXTURE.id,
    organization_id: ALPHA_ORG_ID,
    lead_id: 'e0000000-0000-0000-0000-000000000001',
    job_id: null,
  };
  const JOB_VISIT_HERE = {
    location_id: LOCATION_FIXTURE.id,
    organization_id: ALPHA_ORG_ID,
    lead_id: null,
    job_id: 'j0000000-0000-0000-0000-000000000001',
  };

  it('blocks delete for a location referenced by a JOB visit', async () => {
    mockAuthAs('admin');
    (prisma.user.count as any).mockResolvedValue(0);
    countOver([JOB_VISIT_HERE]);

    const res = await request(app).delete(`/api/locations/${LOCATION_FIXTURE.id}`).set(authHeader('admin'));

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/1 visit\b/i);
    expect((prisma.location.deleteMany as any)).not.toHaveBeenCalled();
    // Parent-agnostic: the clause names the location and the tenant and says nothing about which
    // side of the product booked the trip. A guard that added one would have to add it here.
    const where = (prisma.visit.count as any).mock.calls[0][0].where;
    expect(where).not.toHaveProperty('lead_id');
    expect(where).not.toHaveProperty('job_id');
  });

  it('refuses a job-visit reference exactly as it refuses a walkthrough one', async () => {
    mockAuthAs('admin');
    (prisma.user.count as any).mockResolvedValue(0);

    countOver([LEAD_VISIT_HERE]);
    const walkthroughOnly = await request(app)
      .delete(`/api/locations/${LOCATION_FIXTURE.id}`).set(authHeader('admin'));

    vi.clearAllMocks();
    mockAuthAs('admin');
    (prisma.user.count as any).mockResolvedValue(0);
    countOver([JOB_VISIT_HERE]);
    const jobOnly = await request(app)
      .delete(`/api/locations/${LOCATION_FIXTURE.id}`).set(authHeader('admin'));

    // Same status, same message. "As undeletable as" is the acceptance wording, and comparing the
    // two answers is the only shape that can fail when one side is special-cased.
    expect(jobOnly.status).toBe(walkthroughOnly.status);
    expect(jobOnly.body).toEqual(walkthroughOnly.body);
    expect(jobOnly.status).toBe(409);
  });

  it('counts a lead visit and a job visit at the same location as two', async () => {
    mockAuthAs('admin');
    (prisma.user.count as any).mockResolvedValue(0);
    countOver([LEAD_VISIT_HERE, JOB_VISIT_HERE]);

    const res = await request(app).delete(`/api/locations/${LOCATION_FIXTURE.id}`).set(authHeader('admin'));

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/2 visits/i);
  });

  it('counts visits scoped to the caller’s organisation', async () => {
    mockAuthAs('admin');
    (prisma.user.count as any).mockResolvedValue(0);
    (prisma.visit.count as any).mockResolvedValue(0);
    (prisma.location.deleteMany as any).mockResolvedValue({ count: 1 });

    await request(app).delete(`/api/locations/${LOCATION_FIXTURE.id}`).set(authHeader('admin'));

    expect((prisma.visit.count as any).mock.calls[0][0].where).toMatchObject({
      location_id: LOCATION_FIXTURE.id,
      organization_id: ALPHA_ORG_ID,
    });
  });
});

// ── Archive / unarchive (visit-location spec D9, slice 2) ───────────────────
//
// A location a visit points at cannot be deleted, and slice 1 left that as a dead end. Archiving
// is the escape: the row stays alive so every booked and past visit keeps resolving, and it
// leaves every picker so nobody books into a closed branch. The way back exists because closing a
// branch and reopening it is a real thing, and an irreversible archive is exactly the pressure
// that pushes an admin back towards deleting.
//
// The route pair is `archive` / `unarchive`, matching the customer pair. The BUTTON still reads
// "Restore" - settings-locations-v2-archive.test.tsx is where that label is asserted.

/**
 * `prisma.location.updateMany` answering the way Postgres would, over a table holding ONE row.
 *
 * The where-clause is HONOURED - id, organisation and `is_active` alike - so `count` is a fact
 * about the row rather than a number the test picked. That is what gives the two no-op tests
 * below any teeth: a mock that always answered `{ count: 1 }` would go on passing against a
 * handler that had dropped the current-state guard entirely, which is the exact defect they
 * exist to catch.
 */
type FakeLocationRow = Record<string, unknown> & {
  id: string; organization_id: string; is_active: boolean;
};

function mockOneLocationRow(row: FakeLocationRow, afterTheWrite?: FakeLocationRow) {
  (prisma.location.updateMany as any).mockImplementation(
    ({ where }: { where: { id: string; organization_id?: string; is_active?: boolean } }) => {
      const matches =
        where.id === row.id
        && where.organization_id === row.organization_id
        && (where.is_active === undefined || where.is_active === row.is_active);
      return Promise.resolve({ count: matches ? 1 : 0 });
    },
  );
  // The handler re-reads the row it just wrote, so the read-back is the row AFTER the write when
  // one happened. Answering the pre-write state would hand the caller a body contradicting the
  // change it just made.
  (prisma.location.findFirst as any).mockResolvedValue(afterTheWrite ?? row);
}

describe('POST /api/locations/:id/archive', () => {
  it('sets is_active false and stamps archived_at, within the org only', async () => {
    mockAuthAs('admin');
    // A live, bookable row - which also proves the current-state guard is the right way round.
    // Inverted, it would match nothing here and this 200 would be a 404.
    mockOneLocationRow(
      { ...LOCATION_FIXTURE, is_active: true, archived_at: null },
      { ...LOCATION_FIXTURE, is_active: false, archived_at: new Date() },
    );

    const res = await request(app)
      .post(`/api/locations/${LOCATION_FIXTURE.id}/archive`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    const call = (prisma.location.updateMany as any).mock.calls[0][0];
    expect(call.where).toMatchObject({
      id: LOCATION_FIXTURE.id,
      organization_id: ALPHA_ORG_ID,
      // Archiving matches a location that is STILL ACTIVE. Without this clause a second archive
      // re-stamps `archived_at` and writes a second pair of audit rows - see the no-op test below.
      is_active: true,
    });
    expect(call.data.is_active).toBe(false);
    expect(call.data.archived_at).toBeInstanceOf(Date);
  });

  // Archiving twice is not something the screen offers - the row carries one button and it flips
  // - but a tab left open before somebody else archived, and any script, both reach this route.
  // `archived_at` answers exactly one question, "when did this branch close", so a second stamp
  // destroys the only thing the column is for; and a second pair of audit rows minutes later
  // records a state change that never happened.
  it('is a no-op on a location that is already archived: no re-stamp, no second audit', async () => {
    mockAuthAs('admin');
    mockOneLocationRow({ ...LOCATION_FIXTURE, is_active: false, archived_at: new Date() });

    const res = await request(app)
      .post(`/api/locations/${LOCATION_FIXTURE.id}/archive`)
      .set(authHeader('admin'));

    // Zero rows matched, so this falls through the same not-found path a foreign location takes.
    expect(res.status).toBe(404);
    const events = (prisma.timelineEvent.create as any).mock.calls.map((c: any[]) => c[0].data.event_type);
    expect(events).not.toContain('location.archived');
    const actions = (prisma.auditLog.create as any).mock.calls.map((c: any[]) => c[0].data.action);
    expect(actions).not.toContain('location.archived');
  });

  // The row STAYS. Archiving that deleted anything would take the address off every visit already
  // booked there, which is the exact failure the RESTRICT foreign key exists to prevent.
  it('never deletes the row it archives', async () => {
    mockAuthAs('admin');
    (prisma.location.updateMany as any).mockResolvedValue({ count: 1 });
    (prisma.location.findFirst as any).mockResolvedValue({ ...LOCATION_FIXTURE, is_active: false });

    await request(app).post(`/api/locations/${LOCATION_FIXTURE.id}/archive`).set(authHeader('admin'));

    expect((prisma.location.deleteMany as any)).not.toHaveBeenCalled();
  });

  // Audited the way location.deleted already is: both halves, because they go to different places
  // - writeSettingsAudit writes the org's settings timeline, logAudit the security trail.
  it('is audited as location.archived, both trails', async () => {
    mockAuthAs('admin');
    (prisma.location.updateMany as any).mockResolvedValue({ count: 1 });
    (prisma.location.findFirst as any).mockResolvedValue({ ...LOCATION_FIXTURE, is_active: false });

    await request(app).post(`/api/locations/${LOCATION_FIXTURE.id}/archive`).set(authHeader('admin'));

    const events = (prisma.timelineEvent.create as any).mock.calls.map((c: any[]) => c[0].data.event_type);
    expect(events).toContain('location.archived');
    const actions = (prisma.auditLog.create as any).mock.calls.map((c: any[]) => c[0].data.action);
    expect(actions).toContain('location.archived');
  });

  it('404s a location in another organisation, without archiving it', async () => {
    mockAuthAs('orgB_admin');
    (prisma.location.updateMany as any).mockResolvedValue({ count: 0 });

    const res = await request(app)
      .post(`/api/locations/${LOCATION_FIXTURE.id}/archive`)
      .set(authHeader('orgB_admin'));

    expect(res.status).toBe(404);
    // The tenant clause is what made the count 0 - without it the other org's row is updated and
    // this passes for the wrong reason.
    expect((prisma.location.updateMany as any).mock.calls[0][0].where).toMatchObject({
      organization_id: ORG_B_ID,
    });
  });
});

describe('POST /api/locations/:id/unarchive', () => {
  it('sets is_active true and CLEARS archived_at, within the org only', async () => {
    mockAuthAs('admin');
    mockOneLocationRow(
      { ...LOCATION_FIXTURE, is_active: false, archived_at: new Date() },
      { ...LOCATION_FIXTURE, is_active: true, archived_at: null },
    );

    const res = await request(app)
      .post(`/api/locations/${LOCATION_FIXTURE.id}/unarchive`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    const call = (prisma.location.updateMany as any).mock.calls[0][0];
    expect(call.where).toMatchObject({
      id: LOCATION_FIXTURE.id,
      organization_id: ALPHA_ORG_ID,
      // The mirror of the archive guard: this direction matches a location that IS archived.
      is_active: false,
    });
    expect(call.data).toMatchObject({ is_active: true, archived_at: null });
  });

  it('is audited as location.unarchived, both trails', async () => {
    mockAuthAs('admin');
    mockOneLocationRow({ ...LOCATION_FIXTURE, is_active: false, archived_at: new Date() });

    await request(app).post(`/api/locations/${LOCATION_FIXTURE.id}/unarchive`).set(authHeader('admin'));

    const events = (prisma.timelineEvent.create as any).mock.calls.map((c: any[]) => c[0].data.event_type);
    expect(events).toContain('location.unarchived');
    const actions = (prisma.auditLog.create as any).mock.calls.map((c: any[]) => c[0].data.action);
    expect(actions).toContain('location.unarchived');
  });

  // Symmetric with the archive side, and for the same reason: bringing back a location that is
  // already active changes nothing, so recording it in two audit trails would be a lie about the
  // row's history - and one an admin reading the settings timeline would have to reconcile.
  it('is a no-op on a location that is already active: no audit rows either', async () => {
    mockAuthAs('admin');
    mockOneLocationRow({ ...LOCATION_FIXTURE, is_active: true });

    const res = await request(app)
      .post(`/api/locations/${LOCATION_FIXTURE.id}/unarchive`)
      .set(authHeader('admin'));

    expect(res.status).toBe(404);
    const events = (prisma.timelineEvent.create as any).mock.calls.map((c: any[]) => c[0].data.event_type);
    expect(events).not.toContain('location.unarchived');
    const actions = (prisma.auditLog.create as any).mock.calls.map((c: any[]) => c[0].data.action);
    expect(actions).not.toContain('location.unarchived');
  });

  it('404s a location in another organisation, without unarchiving it', async () => {
    mockAuthAs('orgB_admin');
    (prisma.location.updateMany as any).mockResolvedValue({ count: 0 });

    const res = await request(app)
      .post(`/api/locations/${LOCATION_FIXTURE.id}/unarchive`)
      .set(authHeader('orgB_admin'));

    expect(res.status).toBe(404);
    expect((prisma.location.updateMany as any).mock.calls[0][0].where).toMatchObject({
      organization_id: ORG_B_ID,
    });
  });
});

// The read side of "the filter belongs in one place, and getting it backwards is the whole risk".
// This list is Settings > Locations, not a booking picker: an admin looking for the yard they
// closed last winter has to be able to FIND it in order to bring it back. Filtering here is the
// symmetric mistake to not filtering in the picker - it hides the row behind the only button
// that can bring it back.
describe('GET /api/locations - the admin list is not a booking picker', () => {
  it('does not filter out archived locations', async () => {
    mockAuthAs('admin');
    (prisma.location.findMany as any).mockResolvedValue([
      { ...LOCATION_FIXTURE, is_active: false, archived_at: new Date() },
    ]);

    const res = await request(app).get('/api/locations').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect((prisma.location.findMany as any).mock.calls[0][0].where).not.toHaveProperty('is_active');
  });
});

describe('locations isolation', () => {
  it('technician (no Location grant) gets 403 on create', async () => {
    mockAuthAs('technician');
    const res = await request(app)
      .post('/api/locations')
      .set(authHeader('technician'))
      .send({ name: 'X', code: 'X' });
    expect(res.status).toBe(403);
  });

  // Archive and unarchive are gated on `update Location`, the grant that already lets somebody
  // edit this row - not on a new catalog action. A technician holds neither.
  it.each(['archive', 'unarchive'])('technician gets 403 on %s', async (verb) => {
    mockAuthAs('technician');
    const res = await request(app)
      .post(`/api/locations/${LOCATION_FIXTURE.id}/${verb}`)
      .set(authHeader('technician'));
    expect(res.status).toBe(403);
    expect((prisma.location.updateMany as any)).not.toHaveBeenCalled();
  });
});
