/* =============================================================================
   Roles & Permissions, PRD 1, slice S01.14 - Pages and settings on switches; the dashboard and the reference
   data forms need are fixed for everyone.

   Everything goes through the public interface: the routes, called as people on custom roles (never a built-in
   role name) holding exactly the switch values under test. Real migrated database (TEST_DATABASE_URL); the
   suite skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import request from 'supertest';
import type { PrismaClient, Role } from '@prisma/client';

// One factory for every client in this file (see permission-switches-db.test.ts for why).
const { realClient } = vi.hoisted(() => {
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    return new PrismaClient({ datasources: { db: { url } } });
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined };
});

// The suite-wide setup mocks the app's client; here it is the real one.
vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { createConnectedAccount } from '../lib/stripe';
import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG, findSwitch } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;

const keyOf = (label: string) => SWITCH_CATALOG.find((s) => s.label === label)!.key;
const COMPANY_SETTINGS = keyOf('Company settings');
const CREATE_TAGS = keyOf('Create tags');
const MANAGE_TAGS = keyOf('Manage tags');
const MANAGE_TASK_CATEGORIES = keyOf('Manage task categories');
const MANAGE_PAYOUT_ACCOUNT = keyOf('Manage payout account');
const VIEW_PAYMENTS = keyOf('View payments and payouts');
const ACCESS_SCHEDULE = keyOf('Access Schedule');
const ACCESS_REPORTS = keyOf('Access Reports');
const ACCESS_BILLING = keyOf('Access Billing');
const VIEW_SERVICE_PLANS = keyOf('View service plans');

suite('Pages and settings follow switches; the dashboard and reference data answer everyone (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    // The address probes build real addresses, so this environment has a mailbox domain.
    const { env } = await import('../config/env.js');
    Object.assign(env, { MAILBOX_DOMAIN: 'staging.mail.test.com' });
    await import('../app.js');
  }, 120_000);
  afterAll(async () => {
    await fx.cleanup();
  });

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  /**
   * A person on a fresh custom role MADE FROM BLANK (it carries no stored grant of its own) holding exactly
   * these switch values and every other switch off.
   */
  async function personWith(
    org: string,
    values: Record<string, boolean | string>,
    opts: { base?: Role; extraGrants?: { action: string; subject: string }[] } = {},
  ): Promise<Person & { api: () => Promise<Api> }> {
    const key = `pages-role-${++sequence}`;
    const base = opts.base ?? 'TECHNICIAN';
    const role = await fx.addCustomRole(org, key, base, { madeFromBlank: true, copyGrants: false, extraGrants: opts.extraGrants });
    const allOff = Object.fromEntries(SWITCH_CATALOG.filter((s) => s.kind === 'toggle').map((s) => [s.key, false]));
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { ...allOff, ...values }, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  describe('the dashboard', () => {
    it('answers a custom role with every switch off', async () => {
      const { org } = await fx.newOrg();
      const nobody = await personWith(org, {});
      const res = await (await nobody.api()).get('/api/dashboard');
      expect(res.status).toBe(200);
    });

    it('still answers nobody who is not signed in', async () => {
      await fx.newOrg();
      const server = (await import('../app.js')).default as never;
      expect((await request(server).get('/api/dashboard')).status).toBe(401);
    });
  });

  describe('reference data forms need, readable by a custom role with every switch off', () => {
    it('reads the company name and preferences, job types, job sources and accepted payment methods', async () => {
      const { org } = await fx.newOrg();
      await db.organization.update({
        where: { id: org },
        data: { accepted_payment_methods: ['CARD'] },
      });
      // The lists are rows now; the org record is built from them.
      await db.jobType.createMany({ data: ['Install', 'Repair'].map((name, i) => ({ organization_id: org, name, sort_order: i })) });
      await db.leadSource.createMany({ data: ['Referral', 'Website'].map((name, i) => ({ organization_id: org, name, sort_order: i })) });
      const nobody = await personWith(org, {});
      const res = await (await nobody.api()).get('/api/organization');
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(org);
      expect(res.body.name).toMatch(/^switches-/);
      expect(res.body.job_type_options).toEqual(['Install', 'Repair']);
      expect(res.body.source_options).toEqual(['Referral', 'Website']);
      expect(res.body.accepted_payment_methods).toEqual(['CARD']);
      expect(res.body.timezone).toBeTruthy();
    });

    it('reads sub-statuses and tax rates', async () => {
      const { org } = await fx.newOrg();
      await db.orgTaxRate.create({ data: { organization_id: org, name: 'City tax', rate: 0.0825 } });
      const nobody = await personWith(org, {});
      const api = await nobody.api();

      expect((await api.get('/api/job-sub-statuses')).status).toBe(200);
      const orgRates = await api.get('/api/org-tax-rates');
      expect(orgRates.status).toBe(200);
      expect(JSON.stringify(orgRates.body)).toContain('City tax');
      // The merged list the forms' tax picker reads.
      const rates = await api.get('/api/state-tax-rates');
      expect(rates.status).toBe(200);
      expect(JSON.stringify(rates.body)).toContain('City tax');
    });

    it('stays closed to a person who is not signed in', async () => {
      const server = (await import('../app.js')).default as never;
      for (const path of ['/api/organization', '/api/org-tax-rates', '/api/state-tax-rates', '/api/job-sub-statuses']) {
        expect((await request(server).get(path)).status, path).toBe(401);
      }
    });

    it('does not widen a write: editing the company, its tax rates and sub-statuses still needs Company settings', async () => {
      const { org } = await fx.newOrg();
      const nobody = await personWith(org, {});
      const api = await nobody.api();
      expect((await api.patch('/api/organization', { display_name: 'Nope' })).status).toBe(403);
      expect((await api.post('/api/org-tax-rates', { name: 'Nope', rate: 0.01 })).status).toBe(403);
      expect((await api.post('/api/job-sub-statuses', { label: 'Nope' })).status).toBe(403);
    });
  });

  describe('reports follow Access Reports', () => {
    /** The report router's own GET routes, so a new report endpoint with no row below fails the suite. */
    async function reportPaths(): Promise<string[]> {
      const router = (await import('../routes/report.routes.js')).default as unknown as {
        stack: { route?: { path: string; methods: Record<string, boolean> } }[];
      };
      return router.stack
        .filter((layer) => layer.route?.methods.get)
        .map((layer) => layer.route!.path)
        .sort();
    }

    // The shared unpaid-invoices endpoint: it admits Access Billing or Access Reports (S07.20).
    const SHARED_UNPAID_INVOICES = '/ar-aging';
    const SHARED_CHECK = 'report-unpaid-invoices';

    const probes: Array<{ check: string; path: string }> = [
      { check: 'report-estimate-conversion', path: '/estimate-conversion' },
      { check: 'report-estimate-conversion-drilldown', path: '/estimate-conversion/estimates' },
      { check: 'report-jobs', path: '/jobs' },
      { check: 'report-leads', path: '/leads' },
      { check: 'report-estimates', path: '/estimates' },
      { check: 'report-revenue', path: '/revenue' },
      { check: 'report-payments', path: '/payments' },
      { check: 'report-payment-fees', path: '/payment-fees' },
      { check: 'report-invoices', path: '/invoices' },
      { check: 'report-activity', path: '/activity' },
      { check: 'report-inventory-usage', path: '/inventory-usage' },
    ];

    it('has a probe for every report endpoint but the shared unpaid-invoices one, and names each as a server check', async () => {
      const paths = await reportPaths();
      expect(paths).toContain(SHARED_UNPAID_INVOICES);
      expect(probes.map((p) => p.path).sort()).toEqual(paths.filter((p) => p !== SHARED_UNPAID_INVOICES));
      expect(probes.map((p) => p.check).sort()).toEqual(findSwitch(ACCESS_REPORTS)!.serverChecks.filter((c) => c !== SHARED_CHECK).sort());
    });

    it('names the shared unpaid-invoices endpoint on both Access Reports and Access Billing', () => {
      expect(findSwitch(ACCESS_REPORTS)!.serverChecks).toContain(SHARED_CHECK);
      expect(findSwitch(ACCESS_BILLING)!.serverChecks).toContain(SHARED_CHECK);
    });

    it('refuses every report endpoint to a custom role with every switch off, the shared unpaid-invoices one included', async () => {
      const { org } = await fx.newOrg();
      const api = await (await personWith(org, {})).api();
      for (const path of await reportPaths()) {
        expect((await api.get(`/api/reports${path}`)).status, path).toBe(403);
      }
    });

    it('lets Access Reports through every report endpoint, and no other switch', async () => {
      const { org } = await fx.newOrg();
      const holder = await personWith(org, { [ACCESS_REPORTS]: true });
      // Every other switch on, Access Reports and Access Billing off: still refused.
      const everythingElse = Object.fromEntries(SWITCH_CATALOG.filter((s) => s.kind === 'toggle' && s.key !== ACCESS_REPORTS && s.key !== ACCESS_BILLING && s.key !== keyOf('Export reports')).map((s) => [s.key, true]));
      const other = await personWith(org, everythingElse);
      for (const path of await reportPaths()) {
        // A person signs in right before each call: the auth layer answers for whoever signed in last.
        const allowed = await (await holder.api()).get(`/api/reports${path}`);
        expect(allowed.status, `${path} with Access Reports`).not.toBe(403);
        expect(allowed.status, `${path} with Access Reports`).toBeLessThan(500);
        expect((await (await other.api()).get(`/api/reports${path}`)).status, `${path} without Access Reports`).toBe(403);
      }
    });

    it('lets Access Billing alone through the unpaid-invoices endpoint and no other report endpoint', async () => {
      const { org } = await fx.newOrg();
      const billing = await personWith(org, { [ACCESS_BILLING]: true });
      for (const path of await reportPaths()) {
        const status = (await (await billing.api()).get(`/api/reports${path}`)).status;
        if (path === SHARED_UNPAID_INVOICES) {
          expect(status, `${path} with Access Billing`).not.toBe(403);
          expect(status, `${path} with Access Billing`).toBeLessThan(500);
        } else {
          expect(status, `${path} with Access Billing`).toBe(403);
        }
      }
    });

    it('lets Access Reports alone through the unpaid-invoices endpoint, and a person with neither is refused', async () => {
      const { org } = await fx.newOrg();
      const reports = await personWith(org, { [ACCESS_REPORTS]: true });
      const neither = await personWith(org, {});
      const allowed = await (await reports.api()).get(`/api/reports${SHARED_UNPAID_INVOICES}`);
      expect(allowed.status).not.toBe(403);
      expect(allowed.status).toBeLessThan(500);
      expect((await (await neither.api()).get(`/api/reports${SHARED_UNPAID_INVOICES}`)).status).toBe(403);
    });

    it('does not read a built-in role name: the same switch opens reports on every base role', async () => {
      const { org } = await fx.newOrg();
      for (const base of ['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN'] as const) {
        const on = await personWith(org, { [ACCESS_REPORTS]: true }, { base });
        const off = await personWith(org, {}, { base });
        expect((await (await on.api()).get('/api/reports/jobs')).status, `${base} on`).not.toBe(403);
        expect((await (await off.api()).get('/api/reports/jobs')).status, `${base} off`).toBe(403);
      }
    });

    it('takes reports away from a role whose stored grants still hold the old report read, when the switch is off', async () => {
      const { org } = await fx.newOrg();
      const stale = await personWith(org, {}, { extraGrants: [{ action: 'read', subject: 'Report' }] });
      expect((await (await stale.api()).get('/api/reports/jobs')).status).toBe(403);
    });
  });

  describe('the route-level enforcement table for the Settings and Pages groups', () => {
    const uuid = randomUUID();
    type Probe = { switchKey: string; check: string; call: (api: Api) => ReturnType<Api['get']>; extraOn?: Record<string, boolean> };
    const probes: Probe[] = [
      { switchKey: COMPANY_SETTINGS, check: 'organization-update', call: (api) => api.patch('/api/organization', { display_name: 'Probe Co' }) },
      // The Sender Address page's save (S10.26): it also moves every person's address, so Company settings alone opens it.
      { switchKey: COMPANY_SETTINGS, check: 'organization-email-sender', call: (api) => api.patch('/api/organization/email-sender', { local_part: `probe${randomUUID().replace(/-/g, '').replace(/[0-9]/g, (d) => 'abcdefghij'[Number(d)]!).slice(0, 10)}` }) },
      { switchKey: COMPANY_SETTINGS, check: 'organization-email-sender-read', call: (api) => api.get('/api/organization/email-sender') },
      // The people who read the main mailbox (S10.8): the page's list, its picker, and linking and unlinking one person. An
      // unknown person answers 404 / 200 (never 403), so "let in" is told apart from "refused".
      { switchKey: COMPANY_SETTINGS, check: 'organization-email-readers-read', call: (api) => api.get('/api/organization/email-sender/readers') },
      { switchKey: COMPANY_SETTINGS, check: 'organization-email-readers-candidates', call: (api) => api.get('/api/organization/email-sender/readers/candidates') },
      { switchKey: COMPANY_SETTINGS, check: 'organization-email-reader-link', call: (api) => api.put(`/api/organization/email-sender/readers/${uuid}`) },
      { switchKey: COMPANY_SETTINGS, check: 'organization-email-reader-unlink', call: (api) => api.delete(`/api/organization/email-sender/readers/${uuid}`) },
      { switchKey: COMPANY_SETTINGS, check: 'org-tax-rate-create', call: (api) => api.post('/api/org-tax-rates', {}) },
      { switchKey: COMPANY_SETTINGS, check: 'job-sub-status-create', call: (api) => api.post('/api/job-sub-statuses', {}) },
      { switchKey: COMPANY_SETTINGS, check: 'custom-field-definition-create', call: (api) => api.post('/api/custom-field-definitions', {}) },
      { switchKey: COMPANY_SETTINGS, check: 'app-setting-update', call: (api) => api.patch('/api/settings/probe_setting', { value: 'on' }) },
      { switchKey: CREATE_TAGS, check: 'tag-create', call: (api) => api.post('/api/tags', { name: `probe-${randomUUID().slice(0, 8)}` }) },
      { switchKey: MANAGE_TAGS, check: 'tag-update', call: (api) => api.patch(`/api/tags/${uuid}`, { name: 'x' }) },
      { switchKey: MANAGE_TAGS, check: 'tag-delete', call: (api) => api.delete(`/api/tags/${uuid}`) },
      { switchKey: MANAGE_TASK_CATEGORIES, check: 'task-category-create', call: (api) => api.post('/api/task-categories', {}) },
      { switchKey: MANAGE_TASK_CATEGORIES, check: 'task-category-update', call: (api) => api.patch(`/api/task-categories/${uuid}`, {}) },
      { switchKey: MANAGE_TASK_CATEGORIES, check: 'task-category-delete', call: (api) => api.delete(`/api/task-categories/${uuid}`) },
      // Payments go-live slice 34 - the owner-only payout account. The probes carry the owner surface; an org with no
      // account answers 409 (never 403), so "let in" is told apart from "refused".
      { switchKey: MANAGE_PAYOUT_ACCOUNT, check: 'payout-account-session', call: (api) => api.post('/api/organization/stripe/account-session', { surface: 'owner' }) },
      { switchKey: VIEW_PAYMENTS, check: 'payments-viewer-session', call: (api) => api.post('/api/organization/stripe/account-session', { surface: 'viewer' }) },
      // Payments go-live P3 - the Payments page's read API. Each route answers 200 (or 404 for the made-up id), never 403, with the switch on.
      { switchKey: VIEW_PAYMENTS, check: 'payments-page-summary', call: (api) => api.get('/api/payments-page/summary?from=2026-10-01&to=2026-10-31') },
      { switchKey: VIEW_PAYMENTS, check: 'payments-page-list', call: (api) => api.get('/api/payments-page/payments') },
      { switchKey: VIEW_PAYMENTS, check: 'payments-page-detail', call: (api) => api.get(`/api/payments-page/payments/${uuid}`) },
      { switchKey: VIEW_PAYMENTS, check: 'payments-page-export', call: (api) => api.get('/api/payments-page/payments/export') },
      { switchKey: VIEW_PAYMENTS, check: 'payments-page-payouts', call: (api) => api.get('/api/payments-page/payouts') },
      { switchKey: VIEW_PAYMENTS, check: 'payments-page-payout-detail', call: (api) => api.get(`/api/payments-page/payouts/${uuid}`) },
      { switchKey: VIEW_PAYMENTS, check: 'payments-page-payout-payments', call: (api) => api.get(`/api/payments-page/payouts/${uuid}/payments`) },
      // Payments go-live P4 - Needs attention: the number and the list need View payments; closing a failed payout needs the payout-account switch.
      { switchKey: VIEW_PAYMENTS, check: 'payments-page-attention-summary', call: (api) => api.get('/api/payments-page/attention/summary') },
      { switchKey: VIEW_PAYMENTS, check: 'payments-page-attention-list', call: (api) => api.get('/api/payments-page/attention?view=open') },
      // Payments go-live P10 - the dispute evidence form is read with View payments; a made-up dispute answers 404, never 403.
      { switchKey: VIEW_PAYMENTS, check: 'dispute-evidence-read', call: (api) => api.get(`/api/payments-page/disputes/${uuid}/evidence`) },
      { switchKey: MANAGE_PAYOUT_ACCOUNT, check: 'payments-page-attention-resolve-payout', call: (api) => api.post(`/api/payments-page/attention/failed_payout:${uuid}/resolve`, {}) },
      { switchKey: MANAGE_PAYOUT_ACCOUNT, check: 'payout-terms-accept', call: (api) => api.post('/api/organization/stripe/accept-terms', { accepted: true, authority_attested: true }) },
      { switchKey: MANAGE_PAYOUT_ACCOUNT, check: 'payout-account-connect', call: (api) => {
        // Opening an account asks the (suite-wide mocked) processor for one; every org here gets its own fake id.
        vi.mocked(createConnectedAccount).mockResolvedValue({ id: `acct_probe_${randomUUID()}` } as never);
        return api.post('/api/organization/stripe/connect', {});
      } },
      { switchKey: MANAGE_PAYOUT_ACCOUNT, check: 'payout-account-link', call: (api) => api.post('/api/organization/stripe/account-link', {}) },
      // The schedule's own feed: the service-plan visits waiting to be booked. (The jobs, leads and calendar entries
      // on the schedule come from lists the Jobs, Leads and customer pages share, so those keep their record switches.)
      { switchKey: ACCESS_SCHEDULE, check: 'schedule-service-plan-feed', call: (api) => api.get('/api/service-plans/scheduler-bucket'), extraOn: { [VIEW_SERVICE_PLANS]: true } },
    ];

    it('has a probe for every server check the Settings and Pages groups list, and none for a check they do not list', () => {
      const listed = SWITCH_CATALOG
        .filter((s) => s.module === 'Settings' || s.module === 'Pages' || s.key === VIEW_PAYMENTS) // View payments moved to the Invoices group (P8); its probes stay in this table
        .flatMap((s) => s.serverChecks.map((c) => `${s.key}:${c}`))
        // The report checks have their own table above.
        .filter((c) => !c.includes(':report-'));
      expect(probes.map((p) => `${p.switchKey}:${p.check}`).sort()).toEqual(listed.sort());
    });

    for (const probe of probes) {
      it(`${probe.check}: let in with ${probe.switchKey} on, refused with it off`, async () => {
        const { org } = await fx.newOrg();
        const on = await personWith(org, { [probe.switchKey]: true, ...probe.extraOn });
        const allowed = await probe.call(await on.api());
        expect(allowed.status, 'with the switch on').not.toBe(403);
        expect(allowed.status, 'with the switch on').toBeLessThan(500);
        const off = await personWith(org, { [probe.switchKey]: false, ...probe.extraOn });
        expect((await probe.call(await off.api())).status, 'with the switch off').toBe(403);
      });
    }

    it('takes company settings away from a role whose stored grants still hold the old organization update', async () => {
      const { org } = await fx.newOrg();
      const stale = await personWith(org, {}, { extraGrants: [{ action: 'update', subject: 'Organization' }] });
      expect((await (await stale.api()).patch('/api/organization', { display_name: 'Nope' })).status).toBe(403);
    });

    it('lets a holder of Create tags create a tag and a holder of Manage tags rename and delete it', async () => {
      const { org } = await fx.newOrg();
      const creator = await (await personWith(org, { [CREATE_TAGS]: true })).api();
      const created = await creator.post('/api/tags', { name: `made-${randomUUID().slice(0, 6)}` });
      expect(created.status).toBe(201);
      const tagId = created.body.id ?? created.body.tag?.id;
      expect(tagId).toBeTruthy();
      expect((await creator.patch(`/api/tags/${tagId}`, { name: 'renamed' })).status).toBe(403);

      const manager = await (await personWith(org, { [MANAGE_TAGS]: true })).api();
      expect((await manager.patch(`/api/tags/${tagId}`, { name: `renamed-${randomUUID().slice(0, 6)}` })).status).toBe(200);
      expect((await manager.delete(`/api/tags/${tagId}`)).status).toBeLessThan(300);
    });
  });
});
