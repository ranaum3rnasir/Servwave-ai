/* =============================================================================
   Roles & Permissions, PRD 8, slice S08.27 - the Communication rows of the route-level enforcement table.

   Everything goes through the real router, called as people on custom roles holding exactly the switch values under
   test, against a real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. The rows are data
   (permission-communication-route-rows.ts); permission-communication-route-table.test.ts proves they are all the
   routes there are. This file runs them and adds the rows a plain allow-or-refuse cannot express: the pairs that
   isolate one switch from its neighbour, the phone tabs with their write grants off, what a response leaves out,
   the scope on each section list and the hand-written log.

   No row names a built-in role. The base role a custom role copies its stored grants from rotates through the
   catalog's own list, so a role name could not carry a row.
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
import { BUILT_IN_ROLES, SWITCH_CATALOG, findSwitch } from '../lib/permissions/switches/catalog';
import { COMMUNICATION_ROUTE_ROWS, type RouteRow } from './permission-communication-route-rows';

const suite = realClient ? describe : describe.skip;

/** Every on/off switch off, read from the catalog: the narrowest person there is. */
const TOGGLES_OFF = Object.fromEntries(SWITCH_CATALOG.filter((s) => s.kind === 'toggle').map((s) => [s.key, false]));

/** The switches a set needs on to be a valid set: itself and everything it Requires, all the way up. */
function withParents(keys: string[]): Set<string> {
  const held = new Set<string>();
  const add = (key: string) => {
    if (held.has(key)) return;
    held.add(key);
    for (const parent of findSwitch(key)!.requires) add(parent);
  };
  keys.forEach(add);
  return held;
}

/** The switches left on when `target` is off: everything that stands on it goes off with it. */
function withoutDependents(held: Set<string>, target: string): Set<string> {
  const left = new Set(held);
  left.delete(target);
  let changed = true;
  while (changed) {
    changed = false;
    for (const key of [...left]) {
      if (findSwitch(key)!.requires.some((parent) => !left.has(parent))) {
        left.delete(key);
        changed = true;
      }
    }
  }
  return left;
}

suite('the Communication rows of the route-level table (real database)', () => {
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
      await quietly(db.$executeRawUnsafe(`DELETE FROM message_thread_read_states WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM messages WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM message_threads WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM manual_communication_logs WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM phone_agents WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM call_sessions WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM user_phone_numbers WHERE phone_number_id IN (SELECT id FROM phone_numbers WHERE organization_id = '${org}')`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM phone_numbers WHERE organization_id = '${org}'`));
    }
    await fx.cleanup();
  });

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  type Holder = Person & { roleKey: string; api: () => Promise<Api> };
  let sequence = 0;

  /** An org whose phone setup tabs are open to it (the pilot-or-demo gate), so a row that passes reaches the handler. */
  async function newOrg() {
    const made = await fx.newOrg();
    orgs.push(made.org);
    await db.organization.update({ where: { id: made.org }, data: { is_demo: true } });
    return made;
  }

  /** The base role of the next person: the catalog's own list, in turn. No row picks one by name. */
  const nextBase = (): Role => BUILT_IN_ROLES[sequence % BUILT_IN_ROLES.length] as Role;

  /** A person on a fresh custom role; `holds` makes the switch values, `setHolds` changes them later. */
  async function newHolder(org: string): Promise<Holder> {
    const key = `route-table-role-${++sequence}`;
    const base = nextBase();
    const role = await fx.addCustomRole(org, key, base);
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { roleKey: key, api: () => fx.signedInAs(person) });
  }

  async function setHolds(org: string, holder: Holder, on: Iterable<string>, other: Record<string, boolean | string> = {}) {
    await setRoleSwitchValues({
      organizationId: org, roleKey: holder.roleKey,
      values: { ...TOGGLES_OFF, ...Object.fromEntries([...on].map((key) => [key, true])), ...other },
      actorId: null, reason: 'manual',
    });
  }

  const missing = randomUUID();
  const call = (api: Api, row: Pick<RouteRow, 'method' | 'path'>) => {
    const path = row.path.replace(':index', '0').replace(/:[A-Za-z]+/g, missing);
    return row.method === 'get' || row.method === 'delete' ? api[row.method](path) : api[row.method](path, {});
  };

  /** A row that is let in: not turned away by the gate, not by the org gate of the phone tabs, and not a crash. */
  function expectLetIn(res: { status: number; body: { error?: string } }, label: string) {
    expect([401, 403], `${label}: let in`).not.toContain(res.status);
    expect(res.body?.error, `${label}: past the org gate`).not.toBe('FEATURE_DISABLED');
    expect(res.status, `${label}: no crash`).toBeLessThan(500);
  }
  /** A row that is turned away: the guard's own answer. */
  function expectRefused(res: { status: number; body: { error?: string } }, label: string) {
    expect(res.status, `${label}: refused`).toBe(403);
    expect(res.body?.error, `${label}: the gate's own answer`).toBe('Insufficient permissions');
  }

  describe('every route a Communication switch gates: let in with its switches on, refused with each one off', () => {
    // Routes that ask for the same switches, and so share one person and one set of states.
    const groups = new Map<string, RouteRow[]>();
    for (const row of COMMUNICATION_ROUTE_ROWS) {
      const key = JSON.stringify([[...row.needs].sort(), row.also ?? {}]);
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }

    it.each([...groups.values()].map((rows) => [`${rows[0]!.needs.join(' + ')} (${rows.length})`, rows] as const))(
      'needs %s',
      async (_name, rows) => {
        const { org } = await newOrg();
        const holder = await newHolder(org);
        const api = await holder.api();
        const { needs, also = {} } = rows[0]!;
        const alsoOn = Object.entries(also).filter(([, v]) => v === true).map(([k]) => k);
        const alsoOther = Object.fromEntries(Object.entries(also).filter(([, v]) => v !== true));
        const held = withParents([...needs, ...alsoOn]);

        await setHolds(org, holder, held, alsoOther);
        for (const row of rows) expectLetIn(await call(api, row), `${row.method.toUpperCase()} ${row.path} with ${needs.join(', ')} on`);

        for (const off of needs) {
          await setHolds(org, holder, withoutDependents(held, off), alsoOther);
          for (const row of rows) expectRefused(await call(api, row), `${row.method.toUpperCase()} ${row.path} without ${off}`);
        }
      },
      60_000,
    );
  });

  describe('a switch that stands next to another does not stand in for it', () => {
    it('refuses attaching a call, text or email without the attach switch even with Edit communication records on', async () => {
      const { org } = await newOrg();
      const holder = await newHolder(org);
      const api = await holder.api();
      // Show Email is held too: the two email attach routes ask for it as well (M7), and the attach switch is what is under test.
      await setHolds(org, holder, withParents(['edit_communication_records', 'show_email']));
      const attach = COMMUNICATION_ROUTE_ROWS.filter((r) => r.needs[0] === 'attach_conversations' && r.needs.every((k) => k === 'attach_conversations' || k === 'show_email'));
      expect(attach).toHaveLength(6);
      for (const row of attach) expectRefused(await call(api, row), `${row.method.toUpperCase()} ${row.path}`);

      await setHolds(org, holder, withParents(['attach_conversations', 'show_email']));
      for (const row of attach) expectLetIn(await call(api, row), `${row.method.toUpperCase()} ${row.path} with the attach switch alone`);
    });

    it('refuses creating, changing and deleting a text automation with Contact customers and every Edit and Delete switch on', async () => {
      const { org } = await newOrg();
      const holder = await newHolder(org);
      const api = await holder.api();
      await setHolds(org, holder, withParents([
        'contact_customers', 'edit_communication_records', 'delete_communication_records', 'view_automations', 'access_communication',
      ]));
      const writes = COMMUNICATION_ROUTE_ROWS.filter((r) => r.path.startsWith('/api/communication/automations') && r.method !== 'get');
      expect(writes.map((r) => r.method).sort()).toEqual(['delete', 'patch', 'post']);
      for (const row of writes) expectRefused(await call(api, row), `${row.method.toUpperCase()} ${row.path}`);
    });

    it('refuses a template write with Contact customers and the attach switch on but not Edit communication records', async () => {
      const { org } = await newOrg();
      const holder = await newHolder(org);
      const api = await holder.api();
      await setHolds(org, holder, withParents(['contact_customers', 'attach_conversations', 'delete_communication_records', 'access_communication']));
      const writes = COMMUNICATION_ROUTE_ROWS.filter((r) => r.path.startsWith('/api/communication/templates') && r.method !== 'get');
      expect(writes).toHaveLength(3);
      for (const row of writes) expectRefused(await call(api, row), `${row.method.toUpperCase()} ${row.path}`);
    });
  });

  describe('each phone tab on with its write grant off: the tab reads and the change is refused', () => {
    // [tab switch, a read it opens, the writes it adds to (each with the grant that is off)]
    const tabs: Array<[string, string[], string[]]> = [
      ['call_flows_tab', ['GET /api/communication/call-flows'], ['POST /api/communication/call-flows', 'PATCH /api/communication/call-flows/:id', 'DELETE /api/communication/call-flows/:id']],
      ['call_groups_tab', ['GET /api/communication/call-groups'], ['POST /api/communication/call-groups', 'PATCH /api/communication/call-groups/:id', 'DELETE /api/communication/call-groups/:id']],
      ['blocked_callers_tab', ['GET /api/communication/blocked'], ['POST /api/communication/blocked', 'POST /api/communication/blocked/unblock']],
      ['training_tab', ['GET /api/communication/training/scenarios', 'GET /api/communication/training/sessions'], []],
      ['phone_numbers_tab', ['GET /api/communication/usage'], ['PATCH /api/communication/numbers/:id']],
    ];
    const rowFor = (spec: string) => {
      const [method, path] = spec.split(' ');
      return COMMUNICATION_ROUTE_ROWS.find((r) => r.method === method!.toLowerCase() && r.path === path)!;
    };

    it.each(tabs)('%s', async (tab, reads, writes) => {
      const { org } = await newOrg();
      const holder = await newHolder(org);
      const api = await holder.api();
      await setHolds(org, holder, withParents([tab, 'view_communication']));
      for (const spec of reads) expectLetIn(await call(api, rowFor(spec)), `${spec} with the tab alone`);
      for (const spec of writes) {
        const row = rowFor(spec);
        expect(row, spec).toBeDefined();
        expectRefused(await call(api, row), `${spec} with the tab alone`);
      }
    });
  });

  describe('what a response leaves out', () => {
    async function seedCall(org: string) {
      const id = randomUUID();
      await db.callSession.create({
        data: {
          id, organization_id: org, direction: 'inbound', from_number: '+15555550100', to_number: '+15555550199',
          status: 'completed', answered_by: {}, started_at: new Date(),
          has_recording: true, recording_key: `${org}/${id}.mp3`, summary: 'run-table summary', transcript_preview: 'run-table words',
          sentiment: 'negative', review_flag: 'run-table flag', qa_score: 77,
        },
        select: { id: true },
      });
      return id;
    }

    // [switch, the fields a call answer carries only for a holder]
    const callFields: Array<[string, string[]]> = [
      ['play_recording', ['hasRecording']],
      ['download_recording', ['hasRecording']],
      ['view_transcript', ['summary', 'transcriptPreview']],
      ['see_call_insights', ['sentiment', 'reviewFlag']],
    ];

    it.each(callFields)('%s: the call carries %j on its detail and in the call log for a holder, and not for anyone else', async (key, fields) => {
      const { org } = await newOrg();
      const id = await seedCall(org);
      for (const on of [true, false]) {
        const holder = await newHolder(org);
        const api = await holder.api();
        await setHolds(org, holder, withParents(on ? [key, 'access_communication'] : ['view_communication', 'access_communication']), { communication_scope: 'all' });
        const detail = await api.get(`/api/communication/calls/${id}`);
        expect(detail.status).toBe(200);
        const listed = ((await api.get('/api/communication/calls')).body.calls as Array<Record<string, unknown>>).find((c) => c.id === id)!;
        for (const [where, body] of [['detail', detail.body.call], ['call log', listed]] as Array<[string, Record<string, unknown>]>) {
          for (const field of fields) expect(field in body, `${key}=${on}: ${where} ${field}`).toBe(on);
          // The call score and who answered stay for everyone who can see the call.
          expect(body.qaScore, `${key}=${on}: ${where} call score stays`).toBe(77);
        }
      }
    });

    it('See call insights: the agents list answers with identity and no scorecard metrics without it', async () => {
      const { org } = await newOrg();
      const agent = await db.phoneAgent.create({
        data: { organization_id: org, kind: 'human', name: 'run-table agent', role: 'CSR', calls: 29, sentiment_pct: 71, revenue: 7777.77 },
      });
      for (const on of [true, false]) {
        const holder = await newHolder(org);
        await setHolds(org, holder, withParents(on ? ['see_call_insights', 'access_communication'] : ['view_communication', 'access_communication']));
        const res = await (await holder.api()).get('/api/communication/agents');
        expect(res.status).toBe(200);
        const found = (res.body.agents as Array<Record<string, unknown>>).find((a) => a.id === agent.id)!;
        expect(found.name, 'identity stays').toBe('run-table agent');
        for (const metric of ['calls', 'answerRatePct', 'bookingRatePct', 'ahtSec', 'sentimentPct', 'scriptAdherencePct']) {
          expect(metric in found, `insights=${on}: ${metric}`).toBe(on);
        }
        expect('revenue' in found, 'agent revenue needs company figures too').toBe(false);
      }
    });

    it('Phone numbers tab: the numbers list carries where a number rings only for a holder', async () => {
      const { org } = await newOrg();
      const number = await db.phoneNumber.create({
        data: { id: randomUUID(), organization_id: org, e164: '+15555550177', label: 'run-table', status: 'active' },
      });
      for (const on of [true, false]) {
        const holder = await newHolder(org);
        await setHolds(org, holder, withParents(on ? ['phone_numbers_tab', 'view_communication'] : ['view_communication', 'access_communication']), { communication_scope: 'all' });
        const res = await (await holder.api()).get('/api/communication/numbers');
        expect(res.status).toBe(200);
        const found = (res.body.numbers as Array<Record<string, unknown>>).find((n) => n.id === number.id)!;
        expect(found.e164, 'the number itself stays').toBe('+15555550177');
        for (const field of ['call_flow_id', 'forward_to']) expect(field in found, `tab=${on}: ${field}`).toBe(on);
      }
    });
  });

  describe("Edit other people's logged communications", () => {
    it('lets another person edit and delete an entry only with the switch; the author needs none', async () => {
      const { org, customer } = await newOrg();
      const job = await fx.addJob(org, customer);
      const author = await newHolder(org);
      // Logging onto a job needs the job to be one the person can open (M2): View jobs on, Jobs scope All.
      await setHolds(org, author, withParents(['log_past_communications', 'view_jobs']), { jobs_scope: 'all' });
      const authorApi = await author.api();
      const made = await authorApi.post('/api/communication/manual-log', {
        job_id: job.id, direction: 'out', occurred_at: '2026-08-26T16:00', notes: 'Called about the quote',
      });
      expect(made.status).toBe(201);
      const entry = made.body.entry.id as string;
      const edit = (who: string) => ({
        job_id: job.id, channel: 'call', direction: 'out', occurred_at: '2026-08-26T16:00', notes: 'Corrected note', performed_by: who,
      });

      for (const [key, status] of [['edit_others_logged_communications', 200], [null, 403]] as const) {
        const other = await newHolder(org);
        await setHolds(org, other, withParents(key ? [key, 'view_jobs'] : ['log_past_communications', 'view_jobs']), { jobs_scope: 'all' });
        const api = await other.api();
        expect((await api.put(`/api/communication/manual-log/${entry}`, edit(author.id))).status, `${key} edit`).toBe(status);
      }
      const holder = await newHolder(org);
      await setHolds(org, holder, withParents(['edit_others_logged_communications', 'view_jobs']), { jobs_scope: 'all' });
      expect((await (await holder.api()).delete(`/api/communication/manual-log/${entry}`)).status).toBe(204);

      const own = await authorApi.post('/api/communication/manual-log', {
        job_id: job.id, direction: 'out', occurred_at: '2026-08-26T16:00', notes: 'Mine',
      });
      expect((await authorApi.put(`/api/communication/manual-log/${own.body.entry.id}`, edit(author.id))).status, 'the author edits their own').toBe(200);
    });
  });

  describe('Communication scope and the main-line switch on each section list', () => {
    it('answers the call log, the text inbox, the unread count and the numbers list the same way for each value', async () => {
      const { org, admin, customer } = await newOrg();
      const number = async (tag: string, orgDefault = false) => {
        const id = randomUUID();
        await db.phoneNumber.create({
          data: { id, organization_id: org, e164: `+1555${String(++sequence).padStart(7, '0')}`, label: tag, is_org_default: orgDefault, status: 'active' },
        });
        return id;
      };
      const main = await number('run-main-line', true);
      const mine = await number('run-linked');
      const other = await number('run-unlinked');
      const seeded = { calls: new Map<string, string>(), threads: new Map<string, string>() };
      for (const [name, numberId] of [['main', main], ['mine', mine], ['other', other]] as const) {
        const callId = randomUUID();
        await db.callSession.create({
          data: {
            id: callId, organization_id: org, direction: 'inbound', from_number: '+15555550100', to_number: '+15555550199',
            status: 'completed', answered_by: {}, started_at: new Date(), phone_number_id: numberId,
          },
          select: { id: true },
        });
        seeded.calls.set(name, callId);
        const threadId = randomUUID();
        await db.messageThread.create({
          data: { id: threadId, organization_id: org, channel: 'sms', campaign_type: 'customer_care', customer_id: customer },
          select: { id: true },
        });
        await db.message.create({
          data: {
            id: randomUUID(), organization_id: org, thread_id: threadId, direction: 'in', body: 'run-text', ts: new Date(),
            status: 'received', phone_number_id: numberId,
          },
          select: { id: true },
        });
        seeded.threads.set(name, threadId);
      }
      const numberIds = { main, mine, other };

      // [who, scope, main-line switch, linked to "mine", the numbers they see]
      const cases: Array<[string, string, boolean, boolean, Array<keyof typeof numberIds>]> = [
        ['All', 'all', false, false, ['main', 'mine', 'other']],
        ['All with the main-line switch on', 'all', true, false, ['main', 'mine', 'other']],
        ['Linked to me, no number, main-line switch on', 'attached', true, false, ['main']],
        ['Linked to me, no number, main-line switch off', 'attached', false, false, []],
        ['Linked to me with a number, main-line switch on', 'attached', true, true, ['mine']],
        ['Linked to me with a number, main-line switch off', 'attached', false, true, ['mine']],
      ];
      for (const [label, scope, mainLine, linked, sees] of cases) {
        const holder = await newHolder(org);
        await setHolds(org, holder, withParents(['view_communication', 'access_communication', 'see_main_line_when_no_number'].filter((k) => k !== 'see_main_line_when_no_number' || mainLine)), {
          communication_scope: scope,
        });
        if (linked) {
          const res = await (await fx.signedInAs(admin)).put(`/api/communication/numbers/${mine}/assignments`, { user_ids: [holder.id] });
          expect(res.status).toBe(200);
        }
        const api = await holder.api();
        const names = Object.keys(numberIds) as Array<keyof typeof numberIds>;
        const expectedCalls = names.filter((n) => sees.includes(n)).map((n) => seeded.calls.get(n)!).sort();
        const expectedThreads = names.filter((n) => sees.includes(n)).map((n) => seeded.threads.get(n)!).sort();
        const expectedNumbers = names.filter((n) => sees.includes(n)).map((n) => numberIds[n]).sort();

        const calls = await api.get('/api/communication/calls');
        expect((calls.body.calls as Array<{ id: string }>).map((c) => c.id).sort(), `${label}: call log`).toEqual(expectedCalls);
        const threads = await api.get('/api/communication/threads');
        expect((threads.body.threads as Array<{ id: string }>).map((t) => t.id).sort(), `${label}: text inbox`).toEqual(expectedThreads);
        const unread = await api.get('/api/communication/unread-counts');
        expect(unread.body.sms, `${label}: unread texts`).toBe(expectedThreads.length);
        const numbers = await api.get('/api/communication/numbers');
        expect((numbers.body.numbers as Array<{ id: string }>).map((n) => n.id).sort(), `${label}: company numbers`).toEqual(expectedNumbers);

        // Unlinking again so the next person starts from a number nobody holds.
        if (linked) await (await fx.signedInAs(admin)).put(`/api/communication/numbers/${mine}/assignments`, { user_ids: [] });
      }
    }, 120_000);
  });
});
