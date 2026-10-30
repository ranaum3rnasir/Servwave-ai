/* =============================================================================
   Roles & Permissions, PRD 1, slice S01.10 - the Communication and Automations groups on switches: attaching a
   conversation, editing someone else's hand-logged entry, and text automations.

   Everything goes through the public interface: the routes, called as people on custom roles (never a built-in
   role name) holding exactly the switch values under test. Real migrated database (TEST_DATABASE_URL); the
   suite skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
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

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';
import * as ctmClient from '../lib/ctm/client';

const suite = realClient ? describe : describe.skip;

suite('the Communication and Automations groups follow switches (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);

  const orgs: string[] = [];
  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      for (const table of ['manual_communication_logs', 'text_automations', 'text_templates', 'call_sessions']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
    }
    await fx.cleanup();
  });

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  async function newOrg() {
    const made = await fx.newOrg();
    orgs.push(made.org);
    return made;
  }

  /**
   * A person on a fresh custom role of this base holding exactly these switch values, with Jobs and Leads scope
   * All and the Communication section open, unless the case says otherwise. Whatever the base, no role name may
   * decide anything.
   */
  async function personWith(
    org: string,
    values: Record<string, boolean | string>,
    opts: { base?: Role; name?: string } = {},
  ): Promise<Person & { api: () => Promise<Api>; roleKey: string }> {
    const key = `comm-role-${++sequence}`;
    const base = opts.base ?? 'DISPATCHER';
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({
      organizationId: org, roleKey: key,
      values: {
        leads_scope: 'all', jobs_scope: 'all', view_jobs: true, view_leads: true,
        view_communication: true, access_communication: true, ...values,
      },
      actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(org, opts.name ?? `p${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { roleKey: key, api: () => fx.signedInAs(person) });
  }

  async function addCall(org: string, anchor: { jobId?: string; recorded?: boolean; spoken?: { summary: string; transcript: string }; insight?: { sentiment: string; flag: string; revenue: number } } = {}) {
    const id = randomUUID();
    await db.callSession.create({
      data: {
        id, organization_id: org, direction: 'inbound', from_number: '+15555550100', to_number: '+15555550199',
        status: 'completed', answered_by: {}, started_at: new Date(), job_id: anchor.jobId ?? null,
        ...(anchor.recorded && { has_recording: true, recording_key: `${org}/${id}.mp3` }),
        ...(anchor.spoken && { summary: anchor.spoken.summary, transcript_preview: anchor.spoken.transcript }),
        ...(anchor.insight && { sentiment: anchor.insight.sentiment, review_flag: anchor.insight.flag, revenue: anchor.insight.revenue, qa_score: 77 }),
      },
    });
    return id;
  }

  describe('Attach conversations to jobs and leads', () => {
    it('refuses attaching a call to a job without the switch even with Edit communication records on, and lets it in with the switch', async () => {
      const { org, customer } = await newOrg();
      const job = await fx.addJob(org, customer);
      const lead = await fx.addLead(org, customer);

      // Whatever the role is based on: the switch decides, never the role name.
      for (const base of ['TECHNICIAN', 'SALES', 'DISPATCHER'] as const) {
        const without = await personWith(org, { attach_conversations: false, edit_communication_records: true }, { base });
        const refused = await addCall(org);
        const noApi = await without.api();
        const asJob = await noApi.patch(`/api/communication/calls/${refused}/job`, { job_id: job.id });
        expect(asJob.status, `${base} attach to a job without the switch`).toBe(403);
        const asLead = await noApi.patch(`/api/communication/calls/${refused}/lead`, { lead_id: lead.id });
        expect(asLead.status, `${base} attach to a lead without the switch`).toBe(403);
        expect((await db.callSession.findUniqueOrThrow({ where: { id: refused } })).job_id, base).toBeNull();

        // "All": the attach also needs the call readable under Communication scope (proven in permission-communication-attach-db).
        const withSwitch = await personWith(org, { attach_conversations: true, edit_communication_records: false, communication_scope: 'all' }, { base });
        const call = await addCall(org);
        const api = await withSwitch.api();
        const attached = await api.patch(`/api/communication/calls/${call}/job`, { job_id: job.id });
        expect(attached.status, `${base} attach to a job with the switch`).toBe(200);
        expect((await db.callSession.findUniqueOrThrow({ where: { id: call } })).job_id, base).toBe(job.id);

        const other = await addCall(org);
        expect((await api.patch(`/api/communication/calls/${other}/lead`, { lead_id: lead.id })).status, `${base} attach to a lead with the switch`).toBe(200);
        expect((await db.callSession.findUniqueOrThrow({ where: { id: other } })).lead_id, base).toBe(lead.id);
      }
    });

    it('keeps the rest of Edit communication records on that switch: attaching does not let a person assign an email conversation', async () => {
      const { org } = await newOrg();
      const attacher = await personWith(org, { attach_conversations: true, edit_communication_records: false });
      const api = await attacher.api();
      const missing = randomUUID();
      expect((await api.patch(`/api/communication/emails/threads/${missing}/assign`, { user_id: null })).status).toBe(403);
    });
  });

  describe("Edit other people's logged communications", () => {
    async function logEntry(api: Api, jobId: string) {
      const res = await api.post('/api/communication/manual-log', {
        job_id: jobId, direction: 'out', occurred_at: '2026-08-26T16:00', notes: 'Called about the quote',
      });
      expect(res.status, 'logging an entry').toBe(201);
      return res.body.entry.id as string;
    }
    const correction = (jobId: string, performedBy: string) => ({
      job_id: jobId, channel: 'call', direction: 'out', occurred_at: '2026-08-26T16:00', notes: 'Corrected note',
      performed_by: performedBy,
    });

    it("refuses editing and deleting another person's entry without the switch and lets it in with it, for any role", async () => {
      const { org, customer } = await newOrg();
      const job = await fx.addJob(org, customer);

      for (const base of ['ADMIN', 'TECHNICIAN', 'SALES', 'DISPATCHER'] as const) {
        const author = await personWith(org, { log_past_communications: true }, { base });
        const entry = await logEntry(await author.api(), job.id);

        // An ADMIN-based custom role is no longer let through by its base: only the switch counts.
        const without = await personWith(org, { log_past_communications: true, edit_others_logged_communications: false }, { base });
        const noApi = await without.api();
        expect((await noApi.put(`/api/communication/manual-log/${entry}`, correction(job.id, author.id))).status, `${base} edit without`).toBe(403);
        expect((await noApi.delete(`/api/communication/manual-log/${entry}`)).status, `${base} delete without`).toBe(403);

        const holder = await personWith(org, { log_past_communications: true, edit_others_logged_communications: true }, { base });
        const api = await holder.api();
        expect((await api.put(`/api/communication/manual-log/${entry}`, correction(job.id, author.id))).status, `${base} edit with`).toBe(200);
        expect((await api.delete(`/api/communication/manual-log/${entry}`)).status, `${base} delete with`).toBe(204);
      }
    });

    it('lets a person edit and delete their own entry without the switch', async () => {
      const { org, customer } = await newOrg();
      const job = await fx.addJob(org, customer);
      const author = await personWith(org, { log_past_communications: true, edit_others_logged_communications: false });
      const api = await author.api();
      const entry = await logEntry(api, job.id);
      expect((await api.put(`/api/communication/manual-log/${entry}`, correction(job.id, author.id))).status).toBe(200);
      expect((await api.delete(`/api/communication/manual-log/${entry}`)).status).toBe(204);
    });
  });

  describe('Office phone in the browser', () => {
    it('hands out a phone token by the switch alone, for a role of any base and any name, and refuses it without', async () => {
      const { org } = await newOrg();
      await db.organization.update({ where: { id: org }, data: { ctm_account_id: 'run-prefixed-account' } });
      const client = ctmClient as unknown as {
        isCtmConfigured: ReturnType<typeof vi.fn>; requestPhoneAccess: ReturnType<typeof vi.fn>;
      };
      client.isCtmConfigured.mockReturnValue(true);
      client.requestPhoneAccess.mockResolvedValue({ token: 'stubbed-token', valid_until: 1799999999, session_id: 'stub-session' });

      // A custom role that is a copy of the Technician preset, with only the browser phone turned on, and every
      // other base: the switch decides, never the role name or the base.
      for (const base of ['TECHNICIAN', 'SALES', 'DISPATCHER'] as const) {
        const without = await personWith(org, { office_phone_in_browser: false }, { base });
        const refused = await (await without.api()).post('/api/communication/phone-access', {});
        expect(refused.status, `${base} without the switch`).toBe(403);

        const withSwitch = await personWith(org, { contact_customers: true, office_phone_in_browser: true }, { base });
        const minted = await (await withSwitch.api()).post('/api/communication/phone-access', {});
        expect(minted.status, `${base} with the switch`).toBe(200);
        expect(minted.body.token).toBe('stubbed-token');
      }
    });
  });

  describe('Play recording and Download recording', () => {
    it('hands out each link by its own switch alone, for a role of any base, and says a recording exists only to a holder of either', async () => {
      const { org } = await newOrg();
      const call = await addCall(org, { recorded: true });

      for (const base of ['TECHNICIAN', 'SALES', 'DISPATCHER'] as const) {
        const cases = [
          { play: true, download: false },
          { play: false, download: true },
          { play: true, download: true },
          { play: false, download: false },
        ];
        for (const { play, download } of cases) {
          const who = await personWith(org, { communication_scope: 'all', play_recording: play, download_recording: download }, { base });
          const api = await who.api();
          const label = `${base} play=${play} download=${download}`;

          const played = await api.get(`/api/communication/calls/${call}/recording`);
          expect(played.status, `${label}: playback link`).toBe(play ? 200 : 403);
          const downloaded = await api.get(`/api/communication/calls/${call}/recording/download`);
          expect(downloaded.status, `${label}: download link`).toBe(download ? 200 : 403);

          const detail = await api.get(`/api/communication/calls/${call}`);
          expect(detail.status, label).toBe(200);
          expect('hasRecording' in detail.body.call, `${label}: detail says a recording exists`).toBe(play || download);
          const list = await api.get('/api/communication/calls');
          const listed = (list.body.calls as Array<{ id: string }>).find((c) => c.id === call);
          expect(listed, label).toBeDefined();
          expect('hasRecording' in listed!, `${label}: list says a recording exists`).toBe(play || download);
        }
      }
    });

    it('refuses a recording of a call the person cannot read even with both switches on, and lets the owner of the number in', async () => {
      const { org } = await newOrg();
      const number = randomUUID();
      await db.phoneNumber.create({ data: { id: number, organization_id: org, e164: '+15555550123', label: 'run-recording', status: 'active' } });
      const call = randomUUID();
      await db.callSession.create({
        data: {
          id: call, organization_id: org, direction: 'inbound', from_number: '+15555550100', to_number: '+15555550123',
          status: 'completed', answered_by: {}, started_at: new Date(), phone_number_id: number,
          has_recording: true, recording_key: `${org}/${call}.mp3`,
        },
      });

      const outsider = await personWith(org, {
        communication_scope: 'linked_to_me', see_main_line_when_no_number: false, play_recording: true, download_recording: true,
      }, { base: 'TECHNICIAN' });
      const api = await outsider.api();
      expect((await api.get(`/api/communication/calls/${call}/recording`)).status).toBe(404);
      expect((await api.get(`/api/communication/calls/${call}/recording/download`)).status).toBe(404);

      const everyone = await personWith(org, { communication_scope: 'all', play_recording: true, download_recording: true });
      const allApi = await everyone.api();
      expect((await allApi.get(`/api/communication/calls/${call}/recording`)).status).toBe(200);
      expect((await allApi.get(`/api/communication/calls/${call}/recording/download`)).status).toBe(200);

      await db.$executeRawUnsafe(`DELETE FROM call_sessions WHERE organization_id = '${org}'`);
      await db.$executeRawUnsafe(`DELETE FROM phone_numbers WHERE organization_id = '${org}'`);
    });
  });

  describe('View transcript', () => {
    it('refuses the transcript endpoint and leaves what was said out of every call response without the switch, for a role of any base', async () => {
      const { org, customer } = await newOrg();
      const job = (await fx.addJob(org, customer)).id;
      const spoken = { summary: 'run-transcript summary: booked Thursday', transcript: 'run-transcript words: see you Thursday' };
      const call = await addCall(org, { jobId: job, spoken });

      for (const base of ['TECHNICIAN', 'SALES', 'DISPATCHER'] as const) {
        for (const on of [true, false]) {
          const who = await personWith(org, { communication_scope: 'all', view_transcript: on }, { base });
          const api = await who.api();
          const label = `${base} view_transcript=${on}`;

          const transcript = await api.get(`/api/communication/calls/${call}/transcript`);
          expect(transcript.status, `${label}: transcript endpoint`).toBe(on ? 200 : 403);

          const detail = await api.get(`/api/communication/calls/${call}`);
          expect(detail.status, label).toBe(200);
          const list = await api.get('/api/communication/calls');
          const listed = (list.body.calls as Array<{ id: string }>).find((c) => c.id === call);
          expect(listed, label).toBeDefined();
          const tab = await api.get(`/api/jobs/${job}/communications`);
          expect(tab.status, label).toBe(200);
          const row = (tab.body.items as Array<{ id: string; preview: string }>).find((i) => i.id === call);
          expect(row, label).toBeDefined();

          for (const [where, body] of [['detail', detail.body], ['list', listed], ['job tab', row]] as const) {
            const text = JSON.stringify(body);
            expect(text.includes(spoken.summary), `${label}: ${where} carries the summary`).toBe(on);
          }
          for (const [where, body] of [['detail', detail.body], ['list', listed]] as const) {
            expect(JSON.stringify(body).includes(spoken.transcript), `${label}: ${where} carries the transcript`).toBe(on);
          }
        }
      }
    });
  });

  describe('See call insights', () => {
    it('leaves sentiment and the review flag off every call response, and the scorecard metrics off the agents list, without the switch, for a role of any base', async () => {
      const { org } = await newOrg();
      const insight = { sentiment: 'negative', flag: 'run-insights flag: low confidence', revenue: 6543.21 };
      const call = await addCall(org, { insight });
      const agent = await db.phoneAgent.create({
        data: { organization_id: org, kind: 'human', name: 'run-insights agent', role: 'CSR', calls: 29, sentiment_pct: 71, revenue: 7777.77 },
      });

      for (const base of ['TECHNICIAN', 'SALES', 'DISPATCHER'] as const) {
        for (const insights of [true, false]) {
          for (const figures of [true, false]) {
            const who = await personWith(org, { communication_scope: 'all', see_call_insights: insights, see_company_figures: figures }, { base });
            const api = await who.api();
            const label = `${base} see_call_insights=${insights} see_company_figures=${figures}`;

            const detail = await api.get(`/api/communication/calls/${call}`);
            expect(detail.status, label).toBe(200);
            const list = await api.get('/api/communication/calls');
            const listed = (list.body.calls as Array<Record<string, unknown>>).find((c) => c.id === call);
            expect(listed, label).toBeDefined();
            for (const [where, body] of [['detail', detail.body.call], ['list', listed]] as Array<[string, Record<string, unknown>]>) {
              expect('sentiment' in body, `${label}: ${where} sentiment`).toBe(insights);
              expect('reviewFlag' in body, `${label}: ${where} review flag`).toBe(insights);
              expect('revenue' in body, `${label}: ${where} call revenue`).toBe(figures);
              expect(body.qaScore, `${label}: ${where} call score stays`).toBe(77);
            }

            const agents = await api.get('/api/communication/agents');
            const one = await api.get(`/api/communication/agents/${agent.id}`);
            expect(agents.status, label).toBe(200);
            expect(one.status, label).toBe(200);
            const found = (agents.body.agents as Array<Record<string, unknown>>).find((a) => a.id === agent.id)!;
            for (const [where, body] of [['list', found], ['one', one.body.agent]] as Array<[string, Record<string, unknown>]>) {
              expect(body.name, `${label}: ${where} identity stays`).toBe('run-insights agent');
              for (const metric of ['calls', 'answerRatePct', 'bookingRatePct', 'ahtSec', 'sentimentPct', 'scriptAdherencePct']) {
                expect(metric in body, `${label}: ${where} ${metric}`).toBe(insights);
              }
              expect('revenue' in body, `${label}: ${where} agent revenue`).toBe(insights && figures);
            }
          }
        }
      }
    });
  });

  describe('text automations follow the Automations switches', () => {
    /** A message template the automations can use, made by the company's admin. */
    async function addTemplate(org: string, adminPerson: Person) {
      const api = await fx.signedInAs(adminPerson);
      const res = await api.post('/api/communication/templates', { name: `Reminder ${randomUUID().slice(0, 6)}`, info: '', body: 'See you soon', audience: 'customer' });
      expect(res.status, 'creating a template').toBe(201);
      return (res.body.template?.id ?? res.body.id) as string;
    }
    const body = (templateId: string) => ({ name: 'Day-before text', trigger: 'visit_scheduled', templateId, timing: '1 day before', audience: 'customer' });

    it('does not let Contact customers (with every Communication switch on) create, edit or delete a text automation; the Automations switches do', async () => {
      const { org, admin } = await newOrg();
      const templateId = await addTemplate(org, admin);
      const comms = {
        contact_customers: true, edit_communication_records: true, delete_communication_records: true,
        view_automations: false, create_automations: false, edit_automations: false, delete_automations: false,
      };

      for (const base of ['TECHNICIAN', 'SALES', 'DISPATCHER'] as const) {
        const holder = await personWith(org, comms, { base });
        const api = await holder.api();
        expect((await api.post('/api/communication/automations', body(templateId))).status, `${base} create`).toBe(403);

        // Made by an admin, so there is one to edit and delete.
        const adminApi = await fx.signedInAs(admin);
        const made = await adminApi.post('/api/communication/automations', body(templateId));
        expect(made.status, `${base} admin create`).toBe(201);
        const id = (made.body.automation?.id ?? made.body.id) as string;
        const bare = await personWith(org, comms, { base });
        const bareApi = await bare.api();
        expect((await bareApi.patch(`/api/communication/automations/${id}`, { name: 'Renamed' })).status, `${base} edit`).toBe(403);
        expect((await bareApi.delete(`/api/communication/automations/${id}`)).status, `${base} delete`).toBe(403);

        // The Automations switches alone, with Contact customers and the Edit/Delete communication switches off.
        const manager = await personWith(
          org,
          {
            contact_customers: false, office_phone_in_browser: false, edit_communication_records: false,
            delete_communication_records: false, view_automations: true, create_automations: true, edit_automations: true, delete_automations: true,
          },
          { base },
        );
        const mApi = await manager.api();
        const created = await mApi.post('/api/communication/automations', body(templateId));
        expect(created.status, `${base} create with Create automations`).toBe(201);
        const mid = (created.body.automation?.id ?? created.body.id) as string;
        expect((await mApi.patch(`/api/communication/automations/${mid}`, { name: 'Renamed' })).status, `${base} edit with Edit automations`).toBe(200);
        expect((await mApi.delete(`/api/communication/automations/${mid}`)).status, `${base} delete with Delete automations`).toBe(200);
        expect((await mApi.delete(`/api/communication/automations/${id}`)).status, `${base} delete the other`).toBe(200);
      }
    });
  });

  describe('the server checks the catalog lists for the Communication and Automations groups', () => {
    const GROUPS = ['Communication', 'Automations'];
    const missing = randomUUID();
    type Probe = { switchKey: string; check: string; also?: Record<string, boolean>; run: (api: Api) => Promise<{ status: number }> };
    const probes: Probe[] = [
      { switchKey: 'view_communication', check: 'job-communications', run: (api) => api.get(`/api/jobs/${missing}/communications`) },
      { switchKey: 'view_communication', check: 'lead-communications', run: (api) => api.get(`/api/leads/${missing}/communications`) },
      { switchKey: 'view_communication', check: 'customer-communications', run: (api) => api.get(`/api/customers/${missing}/communications`) },
      { switchKey: 'view_communication', check: 'communication-reads', run: (api) => api.get(`/api/communication/calls/${missing}`) },
      { switchKey: 'contact_customers', check: 'contact-compose', also: { view_communication: true }, run: (api) => api.post('/api/communication/calls', {}) },
      { switchKey: 'contact_customers', check: 'text-send', also: { view_communication: true }, run: (api) => api.post('/api/communication/sms', {}) },
      { switchKey: 'office_phone_in_browser', check: 'phone-token', also: { contact_customers: true, view_communication: true }, run: (api) => api.post('/api/communication/phone-access', {}) },
      { switchKey: 'play_recording', check: 'recording-play', also: { view_communication: true }, run: (api) => api.get(`/api/communication/calls/${missing}/recording`) },
      { switchKey: 'view_transcript', check: 'transcript-view', also: { view_communication: true }, run: (api) => api.get(`/api/communication/calls/${missing}/transcript`) },
      { switchKey: 'download_recording', check: 'recording-download', also: { view_communication: true }, run: (api) => api.get(`/api/communication/calls/${missing}/recording/download`) },
      { switchKey: 'attach_conversations', check: 'call-attach-job', also: { view_communication: true }, run: (api) => api.patch(`/api/communication/calls/${missing}/job`, { job_id: null }) },
      { switchKey: 'attach_conversations', check: 'call-attach-lead', also: { view_communication: true }, run: (api) => api.patch(`/api/communication/calls/${missing}/lead`, { lead_id: null }) },
      { switchKey: 'attach_conversations', check: 'email-attach-job', also: { view_communication: true }, run: (api) => api.patch(`/api/communication/emails/${missing}/job`, { job_id: null }) },
      { switchKey: 'attach_conversations', check: 'email-attach-lead', also: { view_communication: true }, run: (api) => api.patch(`/api/communication/emails/${missing}/lead`, { lead_id: null }) },
      { switchKey: 'attach_conversations', check: 'text-attach-job', also: { view_communication: true }, run: (api) => api.patch(`/api/communication/sms/${missing}/job`, { job_id: null }) },
      { switchKey: 'attach_conversations', check: 'text-attach-lead', also: { view_communication: true }, run: (api) => api.patch(`/api/communication/sms/${missing}/lead`, { lead_id: null }) },
      { switchKey: 'edit_communication_records', check: 'email-thread-assign', also: { view_communication: true }, run: (api) => api.patch(`/api/communication/emails/threads/${missing}/assign`, {}) },
      { switchKey: 'edit_communication_records', check: 'email-thread-archive', also: { view_communication: true }, run: (api) => api.patch(`/api/communication/emails/threads/${missing}/archive`, {}) },
      { switchKey: 'edit_communication_records', check: 'email-thread-snooze', also: { view_communication: true }, run: (api) => api.patch(`/api/communication/emails/threads/${missing}/snooze`, {}) },
      { switchKey: 'edit_communication_records', check: 'email-link-inbound', also: { view_communication: true }, run: (api) => api.patch(`/api/communication/emails/${missing}/link`, {}) },
      { switchKey: 'edit_communication_records', check: 'message-template-create', also: { view_communication: true }, run: (api) => api.post('/api/communication/templates', {}) },
      { switchKey: 'edit_communication_records', check: 'message-template-update', also: { view_communication: true }, run: (api) => api.patch(`/api/communication/templates/${missing}`, {}) },
      { switchKey: 'edit_communication_records', check: 'message-template-delete', also: { view_communication: true }, run: (api) => api.delete(`/api/communication/templates/${missing}`) },
      { switchKey: 'phone_numbers_tab', check: 'phone-numbers-routing', also: { view_communication: true, edit_communication_records: true }, run: (api) => api.patch(`/api/communication/numbers/${missing}`, { call_flow_id: null }) },
      { switchKey: 'phone_usage_bar', check: 'phone-usage', also: { view_communication: true }, run: (api) => api.get('/api/communication/usage') },
      // The phone setup tabs (S08.16): each tab's switch on its endpoints, on top of the grants the endpoints needed before.
      { switchKey: 'call_flows_tab', check: 'call-flows-read', also: { view_communication: true }, run: (api) => api.get('/api/communication/call-flows') },
      { switchKey: 'call_flows_tab', check: 'call-flows-write', also: { view_communication: true, contact_customers: true }, run: (api) => api.post('/api/communication/call-flows', {}) },
      { switchKey: 'call_groups_tab', check: 'call-groups-read', also: { view_communication: true }, run: (api) => api.get('/api/communication/call-groups') },
      { switchKey: 'call_groups_tab', check: 'call-groups-write', also: { view_communication: true, contact_customers: true }, run: (api) => api.post('/api/communication/call-groups', {}) },
      { switchKey: 'training_tab', check: 'training-scenarios', also: { view_communication: true }, run: (api) => api.get('/api/communication/training/scenarios') },
      { switchKey: 'training_tab', check: 'training-sessions', also: { view_communication: true }, run: (api) => api.get('/api/communication/training/sessions') },
      { switchKey: 'blocked_callers_tab', check: 'blocked-read', also: { view_communication: true }, run: (api) => api.get('/api/communication/blocked') },
      { switchKey: 'blocked_callers_tab', check: 'blocked-add', also: { view_communication: true, contact_customers: true }, run: (api) => api.post('/api/communication/blocked', {}) },
      { switchKey: 'blocked_callers_tab', check: 'blocked-remove', also: { view_communication: true, delete_communication_records: true }, run: (api) => api.post('/api/communication/blocked/unblock', {}) },
      // Changing or deleting a call flow keeps its grant, and now also needs the tab.
      { switchKey: 'edit_communication_records', check: 'call-flow-update', also: { view_communication: true, call_flows_tab: true }, run: (api) => api.patch(`/api/communication/call-flows/${missing}`, {}) },
      { switchKey: 'edit_communication_records', check: 'call-group-update', also: { view_communication: true, call_groups_tab: true }, run: (api) => api.patch(`/api/communication/call-groups/${missing}`, {}) },
      { switchKey: 'delete_communication_records', check: 'call-group-delete', also: { view_communication: true, call_groups_tab: true }, run: (api) => api.delete(`/api/communication/call-groups/${missing}`) },
      { switchKey: 'delete_communication_records', check: 'call-flow-delete', also: { view_communication: true, call_flows_tab: true }, run: (api) => api.delete(`/api/communication/call-flows/${missing}`) },
      { switchKey: 'access_communication', check: 'communication-section', also: { view_communication: true }, run: (api) => api.get('/api/communication/unread-counts') },
      { switchKey: 'log_past_communications', check: 'manual-log-create', also: { view_communication: true }, run: (api) => api.post('/api/communication/manual-log', {}) },
      { switchKey: 'view_automations', check: 'automation-list', run: (api) => api.get('/api/workflows') },
      { switchKey: 'view_automations', check: 'text-automation-list', run: (api) => api.get('/api/communication/automations') },
      { switchKey: 'create_automations', check: 'automation-create', also: { view_automations: true }, run: (api) => api.post('/api/workflows', {}) },
      { switchKey: 'create_automations', check: 'text-automation-create', also: { view_automations: true }, run: (api) => api.post('/api/communication/automations', {}) },
      { switchKey: 'edit_automations', check: 'automation-update', also: { view_automations: true }, run: (api) => api.patch(`/api/workflows/${missing}`, {}) },
      { switchKey: 'edit_automations', check: 'text-automation-update', also: { view_automations: true }, run: (api) => api.patch(`/api/communication/automations/${missing}`, {}) },
      { switchKey: 'delete_automations', check: 'automation-delete', also: { view_automations: true }, run: (api) => api.delete(`/api/workflows/${missing}`) },
      { switchKey: 'delete_automations', check: 'text-automation-delete', also: { view_automations: true }, run: (api) => api.delete(`/api/communication/automations/${missing}`) },
    ];
    // Checks that are not a route's allow-or-refuse, each proven by its own cases in this file.
    // The two See call insights checks leave things out of a response rather than refuse (proven in its own case above),
    // and so does the Phone numbers tab's check on the numbers list (proven by the mocked-prisma unit test comm-phone-numbers-tab.test.ts, not by a case in this file).
    const provenElsewhere = ['manual-log-edit-others', 'call-insights', 'phone-agent-metrics', 'phone-numbers-fields'];

    it('has a row for every server check the catalog lists for a Communication or Automations switch, and no switch is left unaccounted for', () => {
      const inGroups = SWITCH_CATALOG.filter((s) => GROUPS.includes(s.module));
      const listed = inGroups.flatMap((s) => s.serverChecks.map((c) => `${s.key}:${c}`));
      const covered = [
        ...probes.map((p) => `${p.switchKey}:${p.check}`),
        ...provenElsewhere.map((c) => inGroups.find((s) => s.serverChecks.includes(c))!.key + ':' + c),
      ];
      expect(covered.sort()).toEqual([...listed].sort());
      for (const s of inGroups) expect(s.serverChecks.length > 0 || Boolean(s.pending), s.key).toBe(true);
    });

    it('lets each check in with its switch on and refuses it with the switch off, for a custom role', async () => {
      const { org } = await newOrg();
      const me = await personWith(org, {}, { base: 'DISPATCHER', name: 'table' });
      const api = await me.api();
      const toggles = SWITCH_CATALOG.filter((s) => GROUPS.includes(s.module) && s.kind === 'toggle').map((s) => s.key);
      const allOff = Object.fromEntries(toggles.map((k) => [k, false]));
      const setRole = async (values: Record<string, boolean>) =>
        setRoleSwitchValues({ organizationId: org, roleKey: me.roleKey, values, actorId: null, reason: 'manual' });

      for (const probe of probes) {
        expect(SWITCH_CATALOG.find((s) => s.key === probe.switchKey)!.serverChecks, probe.check).toContain(probe.check);
        // The section gate is a switch of its own; every probe but its own needs it on to reach the route's check.
        const section: Record<string, boolean> = probe.switchKey === 'access_communication' ? {} : { access_communication: true };

        await setRole({ ...allOff, ...section, ...probe.also, [probe.switchKey]: true });
        const letIn = await probe.run(api);
        expect(letIn.status, `${probe.check} with the switch on`).not.toBe(403);
        expect(letIn.status, `${probe.check} with the switch on`).not.toBe(401);

        await setRole({ ...allOff, ...section, ...probe.also, [probe.switchKey]: false });
        expect((await probe.run(api)).status, `${probe.check} with the switch off`).toBe(403);
      }
    });
  });
});
