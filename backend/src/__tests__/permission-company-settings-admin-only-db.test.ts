/* =============================================================================
   Roles & Permissions security, ticket 36b (M17): Company settings is the Admin flag's alone.

   Called as people on custom roles (never a built-in role name), against a real migrated database (TEST_DATABASE_URL); the suite
   skips when it is unset. Three cases, the first two driven from the route files so a route added to the list joins them:
    - the table: every entry point of the retired switch answers 403 to a non-Admin on a role holding every switch at its widest,
      and to one on a role holding nothing, changes nothing, and is never refused to an Admin;
    - the reads that stay open: the company, the tax rates, the sub-statuses and reasons the forms pick from still answer a
      non-Admin;
    - the journey: an Admin edits the company form, adds a lead source, a job type, a tax rate, a sub-status and an app
      setting; the same non-Admin is refused each, and nothing they sent was saved. A stored value of the retired switch,
      left on a role or a person, opens nothing.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';

const { realClient } = vi.hoisted(() => {
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    return new PrismaClient({ datasources: { db: { url } } });
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { switchFixture } from './permission-switches-fixture';
import { ALL_ACCEPTED_METHODS, SWITCH_CATALOG, storableChoices, type SwitchValue } from '../lib/permissions/switches/catalog';
import { scanRouteFiles, isAdminChecked } from './permission-route-guards-scan';
import { COMPANY_SETTINGS_ROUTES, OPEN_READS, MOUNTS } from './permission-company-settings-routes';
import { clearSwitchCacheForUser } from '../lib/permissions/switches/cache';

const suite = realClient ? describe : describe.skip;

/** Every switch at its widest: each toggle on, each choice at its last (widest) storable value, each list at "all". */
function everySwitchOn(): Record<string, SwitchValue> {
  return Object.fromEntries(
    SWITCH_CATALOG.map((s) => [s.key, s.kind === 'toggle' ? true : s.kind === 'choice' ? storableChoices(s).at(-1)! : ALL_ACCEPTED_METHODS]),
  );
}

const SCANNED = scanRouteFiles();
const SOME_ID = randomUUID();
const concrete = (path: string) => path.replace(/:[a-zA-Z]+/g, SOME_ID);
const ROWS = SCANNED
  .filter((r) => COMPANY_SETTINGS_ROUTES.includes(r.key))
  .map((r) => ({ key: r.key, method: r.method.toLowerCase(), path: `${MOUNTS[r.file]}${r.path === '/' ? '' : r.path}`.replace(/\/$/, '') }))
  .map((r) => ({ ...r, path: concrete(r.path) }));
const OPEN = SCANNED
  .filter((r) => r.key in OPEN_READS && !isAdminChecked(r))
  .map((r) => ({ key: r.key, path: concrete(`${MOUNTS[r.file]}${r.path === '/' ? '' : r.path}`.replace(/\/$/, '')) }));

suite('Company settings is the Admin flag\'s alone (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  let sequence = 0;
  /** A company with a non-Admin on a custom role holding these values, and its Admin. */
  async function company(values: Record<string, SwitchValue>) {
    const made = await fx.newOrg();
    const key = `cs-role-${++sequence}`;
    const role = await fx.addCustomRole(made.org, key, 'DISPATCHER', { madeFromBlank: true });
    await db.permissionRoleSwitch.deleteMany({ where: { organization_id: made.org, role_key: key } });
    await fx.setRoleSwitches(made.org, key, values);
    const holder = await fx.addUser(made.org, 'holder', 'DISPATCHER', { customRoleId: role.id, basedOnRoleKey: key });
    return { ...made, holder, role };
  }
  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  const call = (api: Api, r: { method: string; path: string }, body: object = {}) =>
    r.method === 'get' ? api.get(r.path)
      : r.method === 'post' ? api.post(r.path, body)
        : r.method === 'put' ? api.put(r.path, body)
          : r.method === 'patch' ? api.patch(r.path, body)
            : api.delete(r.path, body);

  /** What a refused request must not have changed. */
  async function snapshot(org: string) {
    return {
      org: await db.organization.findUniqueOrThrow({ where: { id: org } }),
      leadSources: await db.leadSource.count({ where: { organization_id: org } }),
      jobTypes: await db.jobType.count({ where: { organization_id: org } }),
      taxRates: await db.orgTaxRate.count({ where: { organization_id: org } }),
      subStatuses: await db.jobSubStatus.count({ where: { organization_id: org } }),
      settings: await db.appSetting.count({ where: { organization_id: org } }),
      numbers: await db.phoneNumber.count({ where: { organization_id: org } }),
    };
  }

  it('finds the entry points and the open reads (guards against a table that reads nothing and so passes)', () => {
    expect(ROWS).toHaveLength(COMPANY_SETTINGS_ROUTES.length);
    expect(OPEN).toHaveLength(Object.keys(OPEN_READS).length);
  });

  it.each([['holding every switch at its widest', 'wide'], ['holding nothing', 'none']] as const)(
    'answers 403 on every entry point to a non-Admin %s, and changes nothing', async (_label, which) => {
      const c = await company(which === 'wide' ? everySwitchOn() : {});
      const before = await snapshot(c.org);
      const letIn: string[] = [];
      for (const r of ROWS) {
        const res = await call(await fx.signedInAs(c.holder), r);
        if (res.status !== 403) letIn.push(`${r.method.toUpperCase()} ${r.path} -> ${res.status}`);
      }
      expect(letIn).toEqual([]);
      expect(await snapshot(c.org)).toEqual(before);
    },
  );

  it('refuses the entry points of the company form by name: "Only an Admin can change company settings."', async () => {
    const c = await company(everySwitchOn());
    const res = await (await fx.signedInAs(c.holder)).patch('/api/organization', { name: 'Renamed' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Only an Admin can change company settings.');
  });

  it('serves an Admin on every entry point with its own exact status (a walk through all of them, creating what it then changes)', async () => {
    const c = await company({});
    const colleague = await fx.addUser(c.org, 'colleague', 'DISPATCHER');
    const number = await db.phoneNumber.create({ data: { organization_id: c.org, e164: '+16175550177', source: 'byo', status: 'active' } });
    await db.mailbox.create({ data: { organization_id: c.org, kind: 'main', status: 'active' } });
    const tag = randomUUID().slice(0, 6);
    const looked: Record<string, string> = {};
    const idOf = async (what: string, find: () => Promise<{ id?: string; code?: string } | null>, by: 'id' | 'code' = 'id') => {
      const row = await find();
      looked[what] = (by === 'code' ? row?.code : row?.id) as string;
      expect(looked[what], `${what} was created`).toBeTruthy();
    };
    type Step = { key: string; method: string; path: () => string; body?: () => object; status: number; after?: () => Promise<void> };
    const O = '/api/organization';
    const steps: Step[] = [
      { key: 'organization.routes.ts: PATCH /', method: 'patch', path: () => O, body: () => ({ name: `Edited ${tag}`, bank_transfer_instructions: 'Wire to 000-TEST' }), status: 200 },
      { key: 'organization.routes.ts: GET /email-sender', method: 'get', path: () => `${O}/email-sender`, status: 200 },
      { key: 'organization.routes.ts: PATCH /email-sender', method: 'patch', path: () => `${O}/email-sender`, body: () => ({ local_part: `adm${randomUUID().replace(/-/g, '').replace(/[0-9]/g, (d) => 'abcdefghij'[Number(d)]!).slice(0, 14)}` }), status: 200 },
      { key: 'organization.routes.ts: GET /email-sender/readers', method: 'get', path: () => `${O}/email-sender/readers`, status: 200 },
      { key: 'organization.routes.ts: GET /email-sender/readers/candidates', method: 'get', path: () => `${O}/email-sender/readers/candidates`, status: 200 },
      { key: 'organization.routes.ts: PUT /email-sender/readers/:userId', method: 'put', path: () => `${O}/email-sender/readers/${colleague.id}`, status: 200 },
      { key: 'organization.routes.ts: DELETE /email-sender/readers/:userId', method: 'delete', path: () => `${O}/email-sender/readers/${colleague.id}`, status: 200 },
      // No file in the request: the handler's own "choose a file" answer, reached only because the gate let the Admin in.
      { key: 'organization.routes.ts: POST /logo', method: 'post', path: () => `${O}/logo`, status: 400 },
      // The phone service is not configured in the test environment: the handler's own 503 (or 409 once there is no connection to end),
      // reached past the gate. The same for the number routes below.
      { key: 'organization.routes.ts: POST /phone/connect', method: 'post', path: () => `${O}/phone/connect`, body: () => ({ createNew: true, name: 'Test account' }), status: 503 },
      { key: 'organization.routes.ts: POST /phone/check-texting-approval', method: 'post', path: () => `${O}/phone/check-texting-approval`, status: 503 },
      { key: 'organization.routes.ts: POST /phone/disconnect', method: 'post', path: () => `${O}/phone/disconnect`, status: 409 },
      { key: 'organization.routes.ts: POST /connect-ctm', method: 'post', path: () => `${O}/connect-ctm`, body: () => ({ createNew: true, name: 'Test account' }), status: 503 },
      { key: 'organization.routes.ts: POST /connect-ctm/check-a2p', method: 'post', path: () => `${O}/connect-ctm/check-a2p`, status: 503 },
      { key: 'organization.routes.ts: POST /disconnect-ctm', method: 'post', path: () => `${O}/disconnect-ctm`, status: 409 },
      // Tax rates.
      { key: 'org-tax-rate.routes.ts: POST /', method: 'post', path: () => '/api/org-tax-rates', body: () => ({ name: `Rate ${tag}`, rate: 0.05 }), status: 201,
        after: () => idOf('rate', () => db.orgTaxRate.findFirst({ where: { organization_id: c.org, name: `Rate ${tag}` } })) },
      { key: 'org-tax-rate.routes.ts: PATCH /:id', method: 'patch', path: () => `/api/org-tax-rates/${looked.rate}`, body: () => ({ rate: 0.06 }), status: 200 },
      { key: 'org-tax-rate.routes.ts: DELETE /:id', method: 'delete', path: () => `/api/org-tax-rates/${looked.rate}`, status: 204 },
      // Job sub-statuses.
      { key: 'jobSubStatus.routes.ts: POST /', method: 'post', path: () => '/api/job-sub-statuses', body: () => ({ parent: 'SCHEDULED', label: `Sub ${tag}` }), status: 201,
        after: () => idOf('sub', () => db.jobSubStatus.findFirst({ where: { organization_id: c.org, label: `Sub ${tag}` } })) },
      { key: 'jobSubStatus.routes.ts: POST /reorder', method: 'post', path: () => '/api/job-sub-statuses/reorder', body: () => ({ parent: 'SCHEDULED', ordered_ids: [looked.sub] }), status: 204 },
      { key: 'jobSubStatus.routes.ts: PATCH /:id', method: 'patch', path: () => `/api/job-sub-statuses/${looked.sub}`, body: () => ({ label: `Sub ${tag} b` }), status: 200 },
      { key: 'jobSubStatus.routes.ts: DELETE /:id', method: 'delete', path: () => `/api/job-sub-statuses/${looked.sub}`, status: 204 },
      // Decline reasons.
      { key: 'lostReasonOption.routes.ts: POST /', method: 'post', path: () => '/api/lost-reason-options', body: () => ({ label: `Lost ${tag}` }), status: 201,
        after: async () => {
          await idOf('lost', () => db.lostReasonOption.findFirst({ where: { organization_id: c.org, label: `Lost ${tag}` } }), 'code');
          looked.allLost = (await db.lostReasonOption.findMany({ where: { organization_id: c.org }, orderBy: { sort_order: 'asc' }, select: { code: true } })).map((r) => r.code).join(',');
        } },
      { key: 'lostReasonOption.routes.ts: POST /reorder', method: 'post', path: () => '/api/lost-reason-options/reorder', body: () => ({ ordered_codes: looked.allLost!.split(',') }), status: 204 },
      { key: 'lostReasonOption.routes.ts: PATCH /:code', method: 'patch', path: () => `/api/lost-reason-options/${looked.lost}`, body: () => ({ label: `Lost ${tag} b` }), status: 200 },
      // Cancel reasons.
      { key: 'jobCancelReason.routes.ts: POST /', method: 'post', path: () => '/api/job-cancel-reasons', body: () => ({ label: `Cancel ${tag}` }), status: 201,
        after: async () => {
          await idOf('cancel', () => db.jobCancelReasonOption.findFirst({ where: { organization_id: c.org, label: `Cancel ${tag}` } }), 'code');
          looked.allCancel = (await db.jobCancelReasonOption.findMany({ where: { organization_id: c.org }, orderBy: { sort_order: 'asc' }, select: { code: true } })).map((r) => r.code).join(',');
        } },
      { key: 'jobCancelReason.routes.ts: POST /reorder', method: 'post', path: () => '/api/job-cancel-reasons/reorder', body: () => ({ ordered_codes: looked.allCancel!.split(',') }), status: 204 },
      { key: 'jobCancelReason.routes.ts: PATCH /:code', method: 'patch', path: () => `/api/job-cancel-reasons/${looked.cancel}`, body: () => ({ label: `Cancel ${tag} b` }), status: 200 },
      // Job types and lead sources.
      { key: 'jobType.routes.ts: GET /', method: 'get', path: () => '/api/job-types', status: 200 },
      { key: 'jobType.routes.ts: POST /', method: 'post', path: () => '/api/job-types', body: () => ({ name: `Type ${tag}` }), status: 201,
        after: async () => {
          await idOf('type', () => db.jobType.findFirst({ where: { organization_id: c.org, name: `Type ${tag}` } }));
          looked.allTypes = (await db.jobType.findMany({ where: { organization_id: c.org, archived_at: null }, orderBy: { sort_order: 'asc' }, select: { id: true } })).map((t) => t.id).join(',');
        } },
      { key: 'jobType.routes.ts: POST /reorder', method: 'post', path: () => '/api/job-types/reorder', body: () => ({ ordered_ids: looked.allTypes!.split(',') }), status: 204 },
      { key: 'jobType.routes.ts: PATCH /:id', method: 'patch', path: () => `/api/job-types/${looked.type}`, body: () => ({ name: `Type ${tag} b` }), status: 200 },
      { key: 'jobType.routes.ts: POST /:id/archive', method: 'post', path: () => `/api/job-types/${looked.type}/archive`, status: 200 },
      { key: 'jobType.routes.ts: POST /:id/unarchive', method: 'post', path: () => `/api/job-types/${looked.type}/unarchive`, status: 200 },
      { key: 'jobType.routes.ts: DELETE /:id', method: 'delete', path: () => `/api/job-types/${looked.type}`, status: 204 },
      { key: 'leadSource.routes.ts: GET /', method: 'get', path: () => '/api/lead-sources', status: 200 },
      { key: 'leadSource.routes.ts: POST /', method: 'post', path: () => '/api/lead-sources', body: () => ({ name: `Source ${tag}` }), status: 201,
        after: () => idOf('source', () => db.leadSource.findFirst({ where: { organization_id: c.org, name: `Source ${tag}` } })) },
      { key: 'leadSource.routes.ts: PATCH /:id', method: 'patch', path: () => `/api/lead-sources/${looked.source}`, body: () => ({ name: `Source ${tag} b` }), status: 200 },
      { key: 'leadSource.routes.ts: POST /:id/archive', method: 'post', path: () => `/api/lead-sources/${looked.source}/archive`, status: 200 },
      { key: 'leadSource.routes.ts: POST /:id/unarchive', method: 'post', path: () => `/api/lead-sources/${looked.source}/unarchive`, status: 200 },
      { key: 'leadSource.routes.ts: DELETE /:id', method: 'delete', path: () => `/api/lead-sources/${looked.source}`, status: 204 },
      // Custom fields and app settings.
      { key: 'custom-field-definitions.routes.ts: POST /', method: 'post', path: () => '/api/custom-field-definitions', body: () => ({ key: `f_${tag}`, label: 'Field', type: 'TEXT', entity_types: ['CUSTOMER'] }), status: 201,
        after: () => idOf('field', () => db.customFieldDefinition.findFirst({ where: { organization_id: c.org, key: `f_${tag}` } })) },
      { key: 'custom-field-definitions.routes.ts: PATCH /:id', method: 'patch', path: () => `/api/custom-field-definitions/${looked.field}`, body: () => ({ label: 'Field b' }), status: 200 },
      { key: 'settings.routes.ts: PATCH /:key', method: 'patch', path: () => '/api/settings/deposit_percentage', body: () => ({ value: '40' }), status: 200 },
      // Phone numbers and caller ID (ticket 36).
      { key: 'comm-numbers.routes.ts: POST /numbers/search', method: 'post', path: () => '/api/communication/numbers/search', body: () => ({ areacode: '617' }), status: 503 },
      { key: 'comm-numbers.routes.ts: POST /numbers/buy', method: 'post', path: () => '/api/communication/numbers/buy', body: () => ({ phone_number: '+16175550100', forward_to_e164: '+16175550101' }), status: 503 },
      { key: 'comm-numbers.routes.ts: POST /numbers/register-byo', method: 'post', path: () => '/api/communication/numbers/register-byo', body: () => ({ e164: '+16175550102' }), status: 201 },
      { key: 'comm-numbers.routes.ts: POST /numbers/refresh', method: 'post', path: () => '/api/communication/numbers/refresh', status: 503 },
      { key: 'comm-number-assignments.routes.ts: GET /number-assignments', method: 'get', path: () => '/api/communication/number-assignments', status: 200 },
      { key: 'comm-number-assignments.routes.ts: PUT /numbers/:id/assignments', method: 'put', path: () => `/api/communication/numbers/${number.id}/assignments`, body: () => ({ user_ids: [colleague.id] }), status: 200 },
      { key: 'comm-number-assignments.routes.ts: PUT /numbers/:id/org-default', method: 'put', path: () => `/api/communication/numbers/${number.id}/org-default`, body: () => ({ is_org_default: true }), status: 200 },
      { key: 'comm-number-assignments.routes.ts: PUT /users/:userId/default-number', method: 'put', path: () => `/api/communication/users/${colleague.id}/default-number`, body: () => ({ phone_number_id: number.id }), status: 200 },
      { key: 'comm-numbers.routes.ts: DELETE /numbers/:id', method: 'delete', path: () => `/api/communication/numbers/${number.id}`, status: 200 },
    ];

    // The walk covers every entry point, once: a route added to the list needs its step here.
    expect(steps.map((x) => x.key).sort()).toEqual(expect.arrayContaining([...COMPANY_SETTINGS_ROUTES].sort()));
    const walked = steps.map((x) => x.key).filter((k) => COMPANY_SETTINGS_ROUTES.includes(k));
    expect(walked.sort()).toEqual([...COMPANY_SETTINGS_ROUTES].sort());

    const wrong: string[] = [];
    for (const st of steps) {
      const res = await call(await fx.signedInAs(c.admin), { method: st.method, path: st.path() }, st.body?.() ?? {});
      if (res.status !== st.status) wrong.push(`${st.key} -> ${res.status} ${JSON.stringify(res.body).slice(0, 120)} (wanted ${st.status}) ${res.text.slice(0, 200)}`);
      if (st.after) await st.after();
    }
    expect(wrong).toEqual([]);
    expect((await db.organization.findUniqueOrThrow({ where: { id: c.org } })).bank_transfer_instructions).toBe('Wire to 000-TEST');
  });

  it('keeps the reads open: the company, and the lists and rates the forms pick from, still answer a non-Admin', async () => {
    const c = await company(everySwitchOn());
    const api = async () => fx.signedInAs(c.holder);
    const org = await (await api()).get('/api/organization');
    expect(org.status).toBe(200);
    expect(org.body.name).toBe(`switches-${c.tag}`);
    // The one app-setting read needs a setting to read.
    await db.appSetting.create({ data: { organization_id: c.org, key: 'open_read_probe', value: 'on' } });
    const answered: string[] = [];
    for (const r of OPEN) {
      const res = await (await api()).get(r.path.replace(SOME_ID, 'open_read_probe'));
      if (res.status !== 200) answered.push(`${r.key} -> ${res.status}`);
    }
    expect(answered).toEqual([]);
  });

  it('runs the journey: an Admin edits the company\'s settings, and the same non-Admin is refused each edit with nothing saved', async () => {
    const c = await company(everySwitchOn());
    const sourceName = `src-${randomUUID().slice(0, 6)}`;
    const typeName = `type-${randomUUID().slice(0, 6)}`;
    const subLabel = `sub-${randomUUID().slice(0, 6)}`;
    const edits: { name: string; method: 'post' | 'patch' | 'put'; path: string; body: object }[] = [
      { name: 'the company form', method: 'patch', path: '/api/organization', body: { name: 'Edited name', estimate_terms: 'Net 30', bank_transfer_instructions: 'Wire to 000-TEST' } },
      { name: 'a lead source', method: 'post', path: '/api/lead-sources', body: { name: sourceName } },
      { name: 'a job type', method: 'post', path: '/api/job-types', body: { name: typeName } },
      { name: 'a tax rate', method: 'post', path: '/api/org-tax-rates', body: { name: 'Sales', rate: 0.0625 } },
      { name: 'a job sub-status', method: 'post', path: '/api/job-sub-statuses', body: { parent: 'SCHEDULED', label: subLabel } },
      { name: 'an app setting', method: 'patch', path: '/api/settings/deposit_percentage', body: { value: '40' } },
    ];
    const before = await snapshot(c.org);

    for (const e of edits) {
      const refused = await call(await fx.signedInAs(c.holder), e, e.body);
      expect(refused.status, `${e.name} as a non-Admin`).toBe(403);
    }
    expect(await snapshot(c.org)).toEqual(before);

    for (const e of edits) {
      const done = await call(await fx.signedInAs(c.admin), e, e.body);
      expect([200, 201], `${e.name} as an Admin: ${JSON.stringify(done.body)}`).toContain(done.status);
    }
    const after = await snapshot(c.org);
    expect(after.org).toMatchObject({ name: 'Edited name', estimate_terms: 'Net 30', bank_transfer_instructions: 'Wire to 000-TEST' });
    // A company's first list edit may lay its default rows down first, so the proof is the rows the Admin asked for.
    expect(await db.leadSource.count({ where: { organization_id: c.org, name: sourceName } })).toBe(1);
    expect(await db.jobType.count({ where: { organization_id: c.org, name: typeName } })).toBe(1);
    expect(await db.orgTaxRate.count({ where: { organization_id: c.org, name: 'Sales' } })).toBe(1);
    expect(await db.jobSubStatus.count({ where: { organization_id: c.org, label: subLabel } })).toBe(1);
  });

  it('lets a value of the retired switch left on a role or on a person open nothing', async () => {
    const c = await company({});
    // What a database that has not yet run the migration still holds: the old switch, on, for the role and for the person.
    await db.permissionRoleSwitch.create({ data: { organization_id: c.org, role_key: c.role.key, switch_key: 'company_settings', value: true } });
    await db.permissionUserSwitch.create({ data: { organization_id: c.org, user_id: c.holder.id, switch_key: 'company_settings', value: true } });
    clearSwitchCacheForUser(c.holder.id);
    const before = await snapshot(c.org);
    const letIn: string[] = [];
    for (const r of ROWS) {
      const res = await call(await fx.signedInAs(c.holder), r);
      if (res.status !== 403) letIn.push(`${r.method.toUpperCase()} ${r.path} -> ${res.status}`);
    }
    expect(letIn).toEqual([]);
    expect(await snapshot(c.org)).toEqual(before);
  });
});
