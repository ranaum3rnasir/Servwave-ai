/* =============================================================================
   Roles & Permissions, pre-PR review fixes (security review SR-1, SR-2, SR-7 and the older lock checks): every route
   refuses a record id spelled any way but the canonical one, before anything reads the record.

   Pure: no database. The real Express app is loaded and its router stack is walked, so the routes are the ones the server
   actually serves. Every route (the vendor webhooks and parked routes aside) must carry the canonical-id guard, with only
   sign-in and permission gates (or a step that itself refuses another spelling) in front of it, and every record id the
   route's path names must be refused by it or by such a step. A router mounted after the guard is put in, or a route the
   walk misses, fails here. The spellings themselves are pinned on known literals.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import express, { type Request, type Response } from 'express';
import request from 'supertest';
import app from '../app';
import { requireUuidParam } from '../middleware/requireUuidParam';
import { answerOutOfReachAsMissing } from '../lib/permissions/outOfReachIsMissing';
import { refuseUnlessOwnerForPerson } from '../lib/users/owner';
import { refuseInvoicePriceEditOnDoneJob, refuseNewVisitOnClosedJob, refuseWhenJobLocked } from '../lib/permissions/jobLock';
import { refuseWhenLeadClosed } from '../lib/permissions/leadLock';
import { refuseJobEditMoveOnClosedJob, refuseStatusDoorOnClosedJob, refuseVisitMoveOnClosedJob } from '../lib/permissions/jobStatusDoor';
import { routeCheckOf } from '../middleware/routeCheck';
import { isCanonicalIdsStep, isLeadingStep, holdsOtherSpellingOfId } from '../middleware/canonicalIds';
import { canonicalIdParamsOf, isCanonicalId, isOtherSpellingOfId, readsNoRecord } from '../lib/ids/canonicalId';

type Layer = { name: string; handle: unknown; regexp: RegExp; route?: { path: string | string[]; methods: Record<string, boolean>; stack: Layer[] } };

function mountPathOf(re: RegExp): string {
  const s = re.source;
  if (s === '^\\/?$' || s === '^\\/?(?=\\/|$)') return '';
  return s.replace(/^\^/, '').replace(/\\\/\?\(\?=\\\/\|\$\)$/, '').replace(/\\\/\?\$$/, '').replace(/\\\//g, '/');
}

function routes(stack: Layer[], prefix = ''): { key: string; path: string; steps: unknown[] }[] {
  const out: { key: string; path: string; steps: unknown[] }[] = [];
  for (const layer of stack) {
    if (layer.route) {
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      for (const p of paths) {
        out.push({ key: `${Object.keys(layer.route.methods).join(',').toUpperCase()} ${prefix}${p}`, path: prefix + p, steps: layer.route.stack.map((l) => l.handle) });
      }
    } else if (layer.name === 'router') {
      out.push(...routes((layer.handle as { stack: Layer[] }).stack, prefix + mountPathOf(layer.regexp)));
    }
  }
  return out;
}

/** A parameter that names a record (`:id`, `:<thing>Id`), read independently of the guard's own rule. */
const recordParams = (path: string) => [...path.matchAll(/:([A-Za-z]+)\??(?=\/|$)/g)].map((m) => m[1]!)
  .filter((p) => (p === 'id' || /[a-z]Id$/.test(p)) && p !== 'scopeId');

describe('every route refuses a record id in any other spelling before anything reads the record', () => {
  const all = routes((app as unknown as { _router: { stack: Layer[] } })._router.stack);
  const served = all
    .filter((r) => !r.path.startsWith('/api/webhooks/'))
    .filter((r) => !r.steps.some((s) => routeCheckOf(s) === 'closed'));

  it('walks the whole app', () => {
    expect(served.length).toBeGreaterThan(700);
    expect(served.filter((r) => recordParams(r.path).length).length).toBeGreaterThan(350);
  });

  it('puts the guard into every route, with only gates, record-free steps (a rate limiter, a plan gate) or a step that refuses another spelling itself in front of it', () => {
    const wrong: string[] = [];
    for (const r of served) {
      const at = r.steps.findIndex(isCanonicalIdsStep);
      if (at < 0) {
        wrong.push(`${r.key}: no guard`);
        continue;
      }
      const before = r.steps.slice(0, at).filter((s) => !isLeadingStep(s) && !readsNoRecord(s) && canonicalIdParamsOf(s).length === 0);
      if (before.length) wrong.push(`${r.key}: ${before.length} other step(s) run before the guard`);
    }
    expect(wrong).toEqual([]);
  });

  it('refuses every record id the path names: in the guard, or in a step in front of it or right behind it that refuses it itself', () => {
    const wrong: string[] = [];
    for (const r of served) {
      const at = r.steps.findIndex(isCanonicalIdsStep);
      const refused = new Set(r.steps.slice(0, at + 2).flatMap((s) => canonicalIdParamsOf(s)));
      for (const p of recordParams(r.path)) if (!refused.has(p)) wrong.push(`${r.key}: :${p}`);
    }
    expect(wrong).toEqual([]);
  });

  it('leaves the vendor webhooks alone', () => {
    const hooks = all.filter((r) => r.path.startsWith('/api/webhooks/'));
    expect(hooks.length).toBeGreaterThan(0);
    expect(hooks.filter((r) => r.steps.some(isCanonicalIdsStep))).toEqual([]);
  });
});

describe('the spellings', () => {
  const id = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
  it('knows the canonical one', () => {
    expect(isCanonicalId(id)).toBe(true);
    expect(isCanonicalId('00000000-0000-0000-0000-000000000001')).toBe(true);
    for (const other of ['A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11', 'a0eebc999c0b4ef8bb6d6bb9bd380a11', `{${id}}`, `urn:uuid:${id}`, ` ${id}`, 'job-1', '', undefined, 42]) {
      expect(isCanonicalId(other), String(other)).toBe(false);
    }
  });
  it('tells every other spelling the database reads as a uuid from a value that is not one', () => {
    for (const other of [
      'A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11', 'a0EEbc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'a0eebc999c0b4ef8bb6d6bb9bd380a11',
      `{${id}}`, '{a0eebc999c0b4ef8bb6d6bb9bd380a11}', `urn:uuid:${id}`, 'a0ee-bc99-9c0b-4ef8-bb6d-6bb9-bd38-0a11',
    ]) expect(isOtherSpellingOfId(other), other).toBe(true);
    for (const notOne of [id, 'pm_1NxQ2b2eZvKYlo2C', 'job-1', 'C-1001', '12345', 'a0eebc99', '']) expect(isOtherSpellingOfId(notOne), notOne).toBe(false);
  });
  it('finds another spelling in a request field that names a record, at any depth, and nowhere else', () => {
    const dashless = id.replace(/-/g, '');
    expect(holdsOtherSpellingOfId({ job_id: dashless })).toBe(true);
    expect(holdsOtherSpellingOfId({ ids: [id, id.toUpperCase()] })).toBe(true);
    expect(holdsOtherSpellingOfId({ jobId: `{${id}}` })).toBe(true);
    expect(holdsOtherSpellingOfId({ id: `urn:uuid:${id}` })).toBe(true);
    expect(holdsOtherSpellingOfId({ scopes: [{ line_items: [{ price_book_item_id: dashless }] }] })).toBe(true);
    expect(holdsOtherSpellingOfId({ ids: `${id},${dashless}` })).toBe(true);
    expect(holdsOtherSpellingOfId({ job_id: id, ids: [id], customerId: id })).toBe(false);
    // An outside service's id is not a uuid; a text field or a checksum is not a field that names a record.
    expect(holdsOtherSpellingOfId({ payment_method_id: 'pm_1NxQ2b2eZvKYlo2C', note: dashless, checksum: dashless })).toBe(false);
    expect(holdsOtherSpellingOfId(Buffer.from(JSON.stringify({ job_id: dashless })))).toBe(false);
    expect(holdsOtherSpellingOfId(undefined)).toBe(false);
  });
});

/**
 * Every check that names a record by its id refuses another spelling itself, never steps aside, so it stays closed even on a
 * route the guard above did not reach (defence in depth). Each is mounted alone on a bare app, in front of a handler that
 * would answer 200: another spelling must answer 404 with the check's own words.
 */
describe('every check that names a record by id refuses another spelling itself', () => {
  const id = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
  const spellings = [id.replace(/-/g, ''), `{${id}}`, `urn:uuid:${id}`, id.toUpperCase(), 'a0EEbc99-9c0b-4ef8-bb6d-6bb9bd380a11'];
  const user = { id: '00000000-0000-4000-8000-000000000001', organization_id: '00000000-0000-4000-8000-000000000002' };
  const signedIn = (req: Request, _res: Response, next: () => void) => { (req as unknown as { user: typeof user }).user = user; next(); };
  const ok = (_req: Request, res: Response) => { res.status(200).json({ ok: true }); };

  const CHECKS: { name: string; path: string; mount: (r: express.Router) => void; notFound: string }[] = [
    { name: 'requireUuidParam', path: '/x/:id', notFound: 'Thing not found', mount: (r) => r.post('/x/:id', requireUuidParam('id', 'Thing not found'), ok) },
    {
      name: 'the reach wrapper (ticket 33)', path: '/x/:id', notFound: 'Job not found',
      mount: (r) => { r.post('/x/:id', ok); answerOutOfReachAsMissing(r, { param: 'id', notFound: 'Job not found', reaches: async () => true }); },
    },
    {
      name: 'the Owner check for a person named by id', path: '/x/:id', notFound: 'User not found',
      mount: (r) => r.post('/x/:id', async (req, res, next) => { if (!(await refuseUnlessOwnerForPerson(req, res, String(req.params.id)))) next(); }, ok),
    },
    { name: 'the job lock', path: '/x/:id', notFound: 'Job not found', mount: (r) => r.post('/x/:id', refuseWhenJobLocked(), ok) },
    { name: 'the Done-job invoice price lock', path: '/x/:id', notFound: 'Invoice not found', mount: (r) => r.post('/x/:id', refuseInvoicePriceEditOnDoneJob(), ok) },
    { name: 'the new-visit door', path: '/x/:id', notFound: 'Job not found', mount: (r) => r.post('/x/:id', refuseNewVisitOnClosedJob(), ok) },
    { name: 'the closed lead', path: '/x/:id', notFound: 'Lead not found', mount: (r) => r.post('/x/:id', refuseWhenLeadClosed(), ok) },
    { name: 'the status door', path: '/x/:id', notFound: 'Job not found', mount: (r) => r.post('/x/:id', refuseStatusDoorOnClosedJob({ door: 'schedule' } as never), ok) },
    { name: 'the job edit that moves a window', path: '/x/:id', notFound: 'Job not found', mount: (r) => r.post('/x/:id', refuseJobEditMoveOnClosedJob(), ok) },
    { name: 'the visit move (job id)', path: '/x/:id/v/:visitId', notFound: 'Job not found', mount: (r) => r.post('/x/:id/v/:visitId', refuseVisitMoveOnClosedJob(), ok) },
  ];

  for (const c of CHECKS) {
    it(`${c.name}: 404 "${c.notFound}" for every other spelling`, async () => {
      const router = express.Router();
      router.use(express.json(), signedIn);
      c.mount(router);
      const bare = express().use(router);
      for (const spelled of spellings) {
        const url = c.path.replace(':id', encodeURIComponent(spelled)).replace(':visitId', id);
        const res = await request(bare).post(url).send({ scheduled_start: '2026-11-02T14:00:00.000Z' });
        expect({ spelled, status: res.status, body: res.body }).toEqual({ spelled, status: 404, body: { error: c.notFound } });
      }
    });
  }

  it('the visit move: a visit id in another spelling is refused too', async () => {
    const router = express.Router();
    router.post('/x/:id/v/:visitId', signedIn, refuseVisitMoveOnClosedJob(), ok);
    const bare = express().use(express.json()).use(router);
    for (const spelled of spellings) {
      const res = await request(bare).post(`/x/${id}/v/${encodeURIComponent(spelled)}`).send({});
      expect({ spelled, status: res.status, body: res.body }).toEqual({ spelled, status: 404, body: { error: 'Visit not found' } });
    }
  });
});
