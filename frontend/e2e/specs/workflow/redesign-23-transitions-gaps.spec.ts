import { test, expect } from '@playwright/test';
import { ApiClient } from '../../helpers/api-client';
import { leadToSentEstimate, createTech } from '../../helpers/workflow-builders';

/**
 * DLV-12 — EN_ROUTE / ON_SITE mobile transition chain (catalog row DLV-12, P1).
 *
 * WRITTEN 2026-06-10, NOT YET EXECUTED — first baseline run validates.
 *
 * Sources of truth:
 *  - md_files/specs/testing/lifecycle-regression-catalog.md row DLV-12 ("🔲 GAP — zero
 *    coverage of en-route/arrive anywhere") + row DLV-14 (the EN_ROUTE/ON_SITE cancel half).
 *  - md_files/specs/testing/segments/03-deliver-job-schedule.md §2 Step 3 (the mobile CTA
 *    chain), §4 (hard blockers), §6 #6 (EN_ROUTE/ON_SITE dead-ends).
 *  - backend/src/controllers/job.controller.ts (this tree) — exact guards quoted below:
 *      enRoute  :1263  status !== 'SCHEDULED'              → 400 'Only scheduled jobs can be marked en route'
 *      arrive   :1344  status !== 'EN_ROUTE'               → 400 'Only en-route jobs can be marked on-site'
 *      start    :971   status ∉ {SCHEDULED, ON_SITE}       → 400 'Only scheduled or on-site jobs can be started'
 *      complete :1023  status !== 'IN_PROGRESS'            → 400 'Only in-progress jobs can be completed'
 *      cancel   :1080  status ∉ {UNASSIGNED,SCHEDULED,IN_PROGRESS} → 400 `Cannot cancel a ${status.toLowerCase()} job`
 *      unassign :923   status !== 'SCHEDULED'              → 400 'Only scheduled jobs can be unassigned'
 *      update   :606   status ∉ {UNASSIGNED, SCHEDULED}    → 400 `Cannot update a ${status.toLowerCase()} job`
 *
 * Actor note: everything runs as the provisioned ADMIN. en-route/arrive/start/complete all
 * gate on `ability.can('manage','all') OR assigned_to === user.id` — ADMIN is `manage all`
 * (defineAbility.ts:20-21) so the manage-all branch passes. Actor-specific 403s (tech not
 * assigned, the DLV-21 dispatcher mismatch) belong to the rbac spec (redesign-22), not here.
 *
 * Conventions: ONE shared provisioned org, serial via config (workers:1); every assertion is
 * a delta / presence check on a freshly-seeded chain (unique api.suffix data, @e2e-qa.invalid
 * emails); no absolute counts. POST /:id/en-route and /:id/arrive have NO ApiClient wrapper —
 * driven via api.raw(). Side effect note: a successful en-route dispatches the JOB_EN_ROUTE
 * automation event fire-and-forget (post 2026-07-27 Phase 3 migration; the hard-coded
 * sendTechnicianEnRouteEmail this note used to name no longer exists) — best-effort, and
 * never affects the response either way.
 */
let api: ApiClient;
test.beforeAll(async () => { api = await new ApiClient().init(); });
test.afterAll(async () => { await api.dispose(); });

// ─── Seed helpers (approved-estimate → job → assign chain, mirrors redesign-16) ──

/** Lead → walkthrough → estimate SENT (no deposit) → public approve → job (UNASSIGNED). */
async function seedUnassignedJob() {
  const ctx = await leadToSentEstimate(api);
  await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
    signature_data: api.testSignature,
  });
  const { res, body } = await api.createJob({ estimate_id: ctx.estimateId });
  expect(res.status(), 'seed: job create').toBe(201);
  expect(body.job.status, 'seed: fresh job is UNASSIGNED').toBe('UNASSIGNED');
  return { jobId: body.job.id as string, estimateId: ctx.estimateId };
}

/** …then assign a fresh tech with future times → SCHEDULED (no conflicts possible). */
async function seedScheduledJob() {
  const seeded = await seedUnassignedJob();
  const techId = await createTech(api);
  const assigned = await api.assignJob(seeded.jobId, {
    assignee_ids: [techId],
    scheduled_start: api.futureDate(48),
    scheduled_end: api.futureDate(50),
  });
  expect(assigned.res.status(), 'seed: assign').toBe(200);
  expect(assigned.body.job.status, 'seed: assigned job is SCHEDULED').toBe('SCHEDULED');
  return { ...seeded, techId };
}

/** POST /api/jobs/:id/en-route — no typed ApiClient wrapper exists. */
const enRoute = (jobId: string) => api.raw('post', `/api/jobs/${jobId}/en-route`, {});
/** POST /api/jobs/:id/arrive — no typed ApiClient wrapper exists. */
const arrive = (jobId: string) => api.raw('post', `/api/jobs/${jobId}/arrive`, {});

test.describe('DLV-12 — EN_ROUTE / ON_SITE transitions (redesign-23)', () => {
  // ─── DLV-12a ──────────────────────────────────────────────────────────────
  test('DLV-12a: full mobile chain — SCHEDULED →en-route→ EN_ROUTE →arrive→ ON_SITE →start→ IN_PROGRESS →complete→ COMPLETED', async () => {
    // One full seed chain (~14 serial calls) + 4 transitions; absorb a cold-start first row.
    test.setTimeout(120_000);
    const { jobId } = await seedScheduledJob();

    // SCHEDULED → EN_ROUTE ("On My Way"): en_route_at stamped, later stamps still null.
    const er = await enRoute(jobId);
    expect(er.res.status(), 'en-route from SCHEDULED').toBe(200);
    expect(er.body.job.status).toBe('EN_ROUTE');
    expect(er.body.job.en_route_at).not.toBeNull();
    expect(er.body.job.on_site_at ?? null).toBeNull();
    expect(er.body.job.started_at ?? null).toBeNull();

    // EN_ROUTE → ON_SITE ("I've Arrived"): on_site_at stamped.
    const ar = await arrive(jobId);
    expect(ar.res.status(), 'arrive from EN_ROUTE').toBe(200);
    expect(ar.body.job.status).toBe('ON_SITE');
    expect(ar.body.job.on_site_at).not.toBeNull();

    // ON_SITE → IN_PROGRESS ("Start Job"): start's guard allows SCHEDULED or ON_SITE.
    const started = await api.startJob(jobId);
    expect(started.res.status(), 'start from ON_SITE').toBe(200);
    expect(started.body.job.status).toBe('IN_PROGRESS');
    expect(started.body.job.started_at).not.toBeNull();

    // IN_PROGRESS → COMPLETED.
    const completed = await api.completeJob(jobId, 'Mobile-chain E2E run complete');
    expect(completed.res.status(), 'complete from IN_PROGRESS').toBe(200);
    expect(completed.body.job.status).toBe('COMPLETED');
    expect(completed.body.job.completed_at).not.toBeNull();
    // Every chain timestamp survives on the final document.
    expect(completed.body.job.en_route_at).not.toBeNull();
    expect(completed.body.job.on_site_at).not.toBeNull();
    expect(completed.body.job.started_at).not.toBeNull();
  });

  // ─── DLV-12b ──────────────────────────────────────────────────────────────
  test('DLV-12b: en-route guards — on UNASSIGNED → 400; double-tap on EN_ROUTE → 400; on IN_PROGRESS → 400', async () => {
    // One seed chain advanced through statuses serves all three probes.
    test.setTimeout(120_000);
    const { jobId } = await seedUnassignedJob();

    // UNASSIGNED (never assigned): the SCHEDULED-only guard refuses.
    const onUnassigned = await enRoute(jobId);
    expect(onUnassigned.res.status(), 'en-route on UNASSIGNED').toBe(400);
    expect(onUnassigned.body.error).toBe('Only scheduled jobs can be marked en route');

    // Assign → SCHEDULED → en-route becomes legal.
    const techId = await createTech(api);
    const assigned = await api.assignJob(jobId, {
      assignee_ids: [techId],
      scheduled_start: api.futureDate(48),
      scheduled_end: api.futureDate(50),
    });
    expect(assigned.res.status(), 'walk: assign').toBe(200);
    expect((await enRoute(jobId)).res.status(), 'walk: en-route').toBe(200);

    // Double-tap "On My Way": already EN_ROUTE → same guard, 400 (not idempotent-200).
    const doubleTap = await enRoute(jobId);
    expect(doubleTap.res.status(), 'en-route double-tap on EN_ROUTE').toBe(400);
    expect(doubleTap.body.error).toBe('Only scheduled jobs can be marked en route');

    // Walk forward (arrive → start) and probe again from IN_PROGRESS.
    expect((await arrive(jobId)).res.status(), 'walk: arrive').toBe(200);
    expect((await api.startJob(jobId)).res.status(), 'walk: start').toBe(200);
    const onInProgress = await enRoute(jobId);
    expect(onInProgress.res.status(), 'en-route on IN_PROGRESS').toBe(400);
    expect(onInProgress.body.error).toBe('Only scheduled jobs can be marked en route');
  });

  // ─── DLV-12c ──────────────────────────────────────────────────────────────
  test('DLV-12c: arrive guards — on SCHEDULED (no en-route yet) → 400; on IN_PROGRESS → 400', async () => {
    const { jobId } = await seedScheduledJob();

    // SCHEDULED: arriving without having gone en-route is refused (EN_ROUTE-only guard).
    const onScheduled = await arrive(jobId);
    expect(onScheduled.res.status(), 'arrive on SCHEDULED').toBe(400);
    expect(onScheduled.body.error).toBe('Only en-route jobs can be marked on-site');

    // Start straight from SCHEDULED (legal — see DLV-12e) then probe arrive on IN_PROGRESS.
    expect((await api.startJob(jobId)).res.status(), 'walk: start').toBe(200);
    const onInProgress = await arrive(jobId);
    expect(onInProgress.res.status(), 'arrive on IN_PROGRESS').toBe(400);
    expect(onInProgress.body.error).toBe('Only en-route jobs can be marked on-site');
  });

  // ─── DLV-12d ──────────────────────────────────────────────────────────────
  test('DLV-12d: start from EN_ROUTE → 400 — the documented dead-end (start allows only SCHEDULED or ON_SITE)', async () => {
    const { jobId } = await seedScheduledJob();
    expect((await enRoute(jobId)).res.status(), 'walk: en-route').toBe(200);

    // job.controller.ts:985 — !['SCHEDULED','ON_SITE'].includes(status) → 400. An EN_ROUTE
    // job MUST tap "I've Arrived" first; it cannot jump straight to IN_PROGRESS.
    const { res, body } = await api.startJob(jobId);
    expect(res.status(), 'start on EN_ROUTE').toBe(400);
    expect(body.error).toBe('Only scheduled or on-site jobs can be started');
    // The job is still stuck EN_ROUTE (forward-only — see the dead-end block below).
    expect((await api.getJob(jobId)).status).toBe('EN_ROUTE');
  });

  // ─── DLV-12e ──────────────────────────────────────────────────────────────
  test('DLV-12e: start directly from SCHEDULED (desktop path) → IN_PROGRESS; en-route/on-site stamps stay null', async () => {
    const { jobId } = await seedScheduledJob();

    const { res, body } = await api.startJob(jobId);
    expect(res.status(), 'start on SCHEDULED').toBe(200);
    expect(body.job.status).toBe('IN_PROGRESS');
    expect(body.job.started_at).not.toBeNull();
    // The desktop path legitimately skips the mobile steps — no en-route/on-site stamps.
    expect(body.job.en_route_at ?? null).toBeNull();
    expect(body.job.on_site_at ?? null).toBeNull();
  });

  // ─── EN_ROUTE / ON_SITE dead-ends (catalog rows DLV-12 + DLV-14; segment §6 #6) ──
  //
  // CURRENT-BY-DESIGN, asserted as such — but a known UX TRAP: once a tech taps
  // "On My Way" the job can only move FORWARD (arrive → start → complete). On
  // EN_ROUTE/ON_SITE every off-ramp 400s:
  //   cancel   (:1113 — only UNASSIGNED/SCHEDULED/IN_PROGRESS may cancel)
  //   unassign (:937  — SCHEDULED only)
  //   PATCH    (:618  — UNASSIGNED/SCHEDULED only)
  //   start    (:985  — refuses EN_ROUTE; proven in DLV-12d)
  // A MISTAKEN "On My Way" cannot be undone; the only escape is to walk the job
  // forward to IN_PROGRESS and cancel from there (DLV-12g proves that recovery path).
  // If a back-transition ever lands, flip these rows to the new behavior and update
  // catalog row DLV-12 + segment 03 §6 #6.

  // ─── DLV-12f ──────────────────────────────────────────────────────────────
  test('DLV-12f: EN_ROUTE dead-ends — cancel → 400, unassign → 400, PATCH scope_notes → 400; job untouched', async () => {
    const { jobId } = await seedScheduledJob();
    const before = await api.getJob(jobId);
    expect((await enRoute(jobId)).res.status(), 'walk: en-route').toBe(200);

    // cancel: EN_ROUTE is outside {UNASSIGNED, SCHEDULED, IN_PROGRESS}.
    const cancelled = await api.cancelJob(jobId, 'changed my mind mid-drive');
    expect(cancelled.res.status(), 'cancel on EN_ROUTE').toBe(400);
    expect(cancelled.body.error).toBe('Cannot cancel a en_route job'); // grammar as-coded

    // unassign: SCHEDULED-only.
    const unassigned = await api.unassignJob(jobId);
    expect(unassigned.res.status(), 'unassign on EN_ROUTE').toBe(400);
    expect(unassigned.body.error).toBe('Only scheduled jobs can be unassigned');

    // PATCH (even a harmless scope_notes edit): UNASSIGNED/SCHEDULED-only.
    const patched = await api.updateJob(jobId, { scope_notes: `dead-end-probe-${api.suffix}` });
    expect(patched.res.status(), 'PATCH scope_notes on EN_ROUTE').toBe(400);
    expect(patched.body.error).toBe('Cannot update a en_route job'); // grammar as-coded

    // Nothing landed: still EN_ROUTE, same tech, scope_notes untouched, never cancelled.
    const after = await api.getJob(jobId);
    expect(after.status).toBe('EN_ROUTE');
    expect(after.assignees.map((a: any) => a.user.id)).toEqual(before.assignees.map((a: any) => a.user.id));
    expect(after.scope_notes ?? null).toBe(before.scope_notes ?? null);
    expect(after.cancelled_at ?? null).toBeNull();
  });

  // ─── DLV-12g ──────────────────────────────────────────────────────────────
  test('DLV-12g: ON_SITE dead-end — cancel → 400; recovery is forward-only (start → IN_PROGRESS → cancel OK)', async () => {
    const { jobId } = await seedScheduledJob();
    expect((await enRoute(jobId)).res.status(), 'walk: en-route').toBe(200);
    expect((await arrive(jobId)).res.status(), 'walk: arrive').toBe(200);

    // cancel on ON_SITE refused, job unchanged.
    const cancelled = await api.cancelJob(jobId, 'customer no-show');
    expect(cancelled.res.status(), 'cancel on ON_SITE').toBe(400);
    expect(cancelled.body.error).toBe('Cannot cancel a on_site job'); // grammar as-coded
    expect((await api.getJob(jobId)).status).toBe('ON_SITE');

    // Segment §4: "must be walked forward to IN_PROGRESS first; no backward transition
    // exists" — prove the documented recovery path actually works.
    expect((await api.startJob(jobId)).res.status(), 'walk forward: start').toBe(200);
    const recovered = await api.cancelJob(jobId, 'customer no-show — cancelled after forced start');
    expect(recovered.res.status(), 'cancel on IN_PROGRESS (recovery)').toBe(200);
    expect(recovered.body.job.status).toBe('CANCELLED');
  });
});
