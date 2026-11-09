/* =============================================================================
   Roles & Permissions, PRD 6, slice S06.26 - the lead and estimate alerts on M6's two-lane chain.

   "New lead with no owner", "Walkthrough scheduled" and the estimate alerts (won, declined, archived, deposit paid,
   deposit waived, approval voided, status corrected) used to go to "every Admin" and "every Dispatcher" by role. Now each
   goes through the chain: lane 1 is the record's people (a lead's Owner, walkthrough performers and Dispatcher; for an
   estimate its lead's Owner and the people of its job, else of its lead); lane 2 is who must act (the record's Dispatcher,
   else the holders of the verb's step switch who can open it, else the company's Admins, stopping at the first step that
   finds someone; an Admin holds every switch, so an Admin who can be told is found at the step already, AL-18); holders of the area's "Alert me about every ..." switch get a copy. "Someone" is active,
   can open the record (for an estimate, the estimate itself too) and is not the person who did it. Nobody comes from a role
   name.

   One table drives every verb of a record kind, so a row of the chain is checked the same way for each. The chain is asked
   through the module that sends these alerts (the writers the lead and estimate routes call after their response), called as
   the routes call it, with people on custom roles holding exactly the switch values under test (every other toggle off);
   the doors themselves (each route, the public pages, the website form) are checked at the end by the alerts they leave.
   Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. The client holds ONE connection, as the
   hosted database does. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { PrismaClient, Role } from '@prisma/client';

// One client holding ONE connection, as the hosted database's does: a query on the global client from inside a
// transaction waits for a second connection that never comes, which a local pool of several hides.
const { realClient } = vi.hoisted(() => {
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    const pooled = new URL(url);
    pooled.searchParams.set('connection_limit', '1');
    pooled.searchParams.set('pool_timeout', '10');
    return new PrismaClient({ datasources: { db: { url: pooled.toString() } } });
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined };
});

// The suite-wide setup mocks the app's client; here it is the real one.
vi.mock('../lib/prisma', () => ({ prisma: realClient }));
// ...and so is the numbering allocator (the setup's stub hands every record the same number).
vi.unmock('../lib/numbering');

import { switchFixture, type Person } from './permission-switches-fixture';
import { SWITCH_CATALOG, type SwitchValue } from '../lib/permissions/switches/catalog';
import { logger } from '../lib/logger';
import { reviewAttentionSettled } from '../services/notifications/reviewAttentionQueue';

const suite = realClient ? describe : describe.skip;

/** Every switch in the catalog off (a choice at its first option, a list empty), so a case turns on exactly the ones it is about. */
const ALL_OFF: Record<string, SwitchValue> = Object.fromEntries(
  SWITCH_CATALOG.map((s) => [s.key, s.kind === 'choice' ? s.choices![0]! : s.kind === 'list' ? [] : false]),
);

const opensLeads = { view_leads: true, leads_scope: 'all' };
// An Admin (the flag, AL-18): holds every switch, the step and the copy switches included, and opens every record.
const adminValues = { ...opensLeads, is_admin: true, view_users: true };

/** One row of the lead table: a verb, the switch that is its lane 2 step, and what the bell says. */
interface LeadVerb {
  verb: 'lead.unassigned_created' | 'lead.walkthrough_scheduled';
  /** What the bell says about lead number N. */
  title: (leadNumber: string) => string;
  /** The priority the walkthrough's performers got, which is what the verb always gave them. */
  performerPriority: 'FEED' | 'INTERRUPT';
  /** Whether the lead's Owner is told (a lead with an Owner raises no "no owner" alert at all). */
  ownerIsTold: boolean;
}

const LEAD_VERBS: LeadVerb[] = [
  { verb: 'lead.unassigned_created', title: (n) => `New lead with no owner (${n})`, performerPriority: 'FEED', ownerIsTold: false },
  { verb: 'lead.walkthrough_scheduled', title: (n) => `Walkthrough scheduled for ${n}`, performerPriority: 'INTERRUPT', ownerIsTold: true },
];

/** What a person needs to open an estimate and the lead or job it is on. */
const opensEstimates = { view_estimates: true, ...opensLeads, view_jobs: true, jobs_scope: 'all', view_invoices: true };

/** One row of the estimate table: a verb, what the bell says, and how it asks and interrupts. */
interface EstimateVerb {
  verb: 'estimate.approved' | 'estimate.declined' | 'estimate.deposit_paid' | 'estimate.cancelled' | 'estimate.deposit_waived' | 'estimate.approval_voided' | 'estimate.status_corrected';
  /** What the bell says about estimate number N. */
  title: (estimateNumber: string) => string;
  /** The switch whose holders must act when the estimate is on a lead with no Dispatcher. */
  leadStep: 'assign_people_to_leads' | 'assign_people_to_jobs';
  /** How the why line names that step when nobody holding it could take the alert. */
  leadStepWords: string;
  /** Whether the people who must act are asked to schedule the job. */
  asksToSchedule: boolean;
  /** The priority the estimate's Owner got, which is what the verb always gave them. */
  ownerPriority: 'FEED' | 'INTERRUPT';
  /** Every "Alert me about every ..." switch whose holders get a copy. */
  copySwitches: string[];
  /** The kind of alert as the log line names it. */
  kind: string;
}

const ESTIMATE_VERBS: EstimateVerb[] = [
  { verb: 'estimate.approved', title: (n) => `${n} won`, leadStep: 'assign_people_to_jobs', leadStepWords: 'assign people to jobs', asksToSchedule: true, ownerPriority: 'INTERRUPT', copySwitches: ['alert_every_estimate'], kind: 'estimate won' },
  { verb: 'estimate.declined', title: (n) => `${n} declined`, leadStep: 'assign_people_to_leads', leadStepWords: 'assign people to leads', asksToSchedule: false, ownerPriority: 'INTERRUPT', copySwitches: ['alert_every_estimate'], kind: 'estimate declined' },
  { verb: 'estimate.deposit_paid', title: (n) => `Deposit paid for ${n}`, leadStep: 'assign_people_to_jobs', leadStepWords: 'assign people to jobs', asksToSchedule: true, ownerPriority: 'INTERRUPT', copySwitches: ['alert_every_estimate', 'alert_every_invoice'], kind: 'deposit paid' },
  { verb: 'estimate.cancelled', title: (n) => `${n} archived`, leadStep: 'assign_people_to_leads', leadStepWords: 'assign people to leads', asksToSchedule: false, ownerPriority: 'FEED', copySwitches: ['alert_every_estimate'], kind: 'estimate archived' },
  { verb: 'estimate.deposit_waived', title: (n) => `Deposit waived for ${n}`, leadStep: 'assign_people_to_leads', leadStepWords: 'assign people to leads', asksToSchedule: false, ownerPriority: 'FEED', copySwitches: ['alert_every_estimate'], kind: 'deposit waived' },
  { verb: 'estimate.approval_voided', title: (n) => `Approval voided for ${n}`, leadStep: 'assign_people_to_leads', leadStepWords: 'assign people to leads', asksToSchedule: false, ownerPriority: 'FEED', copySwitches: ['alert_every_estimate'], kind: 'approval voided' },
  { verb: 'estimate.status_corrected', title: (n) => `${n} status corrected`, leadStep: 'assign_people_to_leads', leadStepWords: 'assign people to leads', asksToSchedule: false, ownerPriority: 'FEED', copySwitches: ['alert_every_estimate'], kind: 'estimate status corrected' },
];

suite('the lead and estimate alerts (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());
  afterEach(() => vi.restoreAllMocks());

  let sequence = 0;

  /** A person on a fresh custom role holding exactly these switch values (every other switch off). */
  async function personWith(org: string, values: Record<string, SwitchValue>, base: Role = 'DISPATCHER'): Promise<Person> {
    const key = `lead-estimate-role-${++sequence}`;
    // `is_admin: true` makes the person an Admin (the flag, AL-18): it is not a switch, so it never reaches the role.
    const { is_admin: asAdmin, ...switchValues } = values;
    const role = await fx.addCustomRole(org, key, base);
    await fx.setRoleSwitches(org, key, { ...ALL_OFF, ...switchValues });
    return fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id, isAdmin: asAdmin === true });
  }

  /** A company with nobody but built people, so only they can be alerted. */
  async function quietOrg() {
    const world = await fx.newOrg();
    await db.user.update({ where: { id: world.admin.id }, data: { is_active: false } });
    return world;
  }

  const alertsFor = (verb: string, recordId: string) =>
    db.notification.findMany({ where: { object_id: recordId, verb }, include: { recipients: true }, orderBy: { created_at: 'asc' } });
  type Alerts = Awaited<ReturnType<typeof alertsFor>>;
  const recipientsOf = (rows: Alerts) => rows.flatMap((n) => n.recipients.map((r) => r.recipient_id)).sort();
  const ids = (...people: Person[]) => people.map((p) => p.id).sort();
  /** The why line one person's alert carries (null when it carries none). */
  const whyFor = (rows: Alerts, person: Person) => rows.find((n) => n.recipients.some((r) => r.recipient_id === person.id))?.body ?? null;
  const rowFor = (rows: Alerts, person: Person) => rows.flatMap((n) => n.recipients).find((r) => r.recipient_id === person.id);
  const gapsLogged = (warn: ReturnType<typeof vi.spyOn>, kind: string) =>
    (warn.mock.calls as unknown[][]).filter((call) => String(call[0]).includes(`${kind} alert: nobody to tell`));

  describe.each(LEAD_VERBS)('$verb', (row) => {
    const stepValues = { ...opensLeads, assign_people_to_leads: true };

    /** Send this verb's alert for a lead, as the lead routes do after their response. */
    async function send(org: string, actor: Person | null, leadId: string, performers: string[] = []) {
      const { alertLead } = await import('../services/notifications/leadEstimateAlerts.js');
      await alertLead({ verb: row.verb, organizationId: org, actorId: actor?.id ?? null, leadId, performerIds: performers });
    }
    const lead = (org: string, customer: string, opts: { owner?: string; dispatcher?: string; walkthroughCrew?: string[] }) =>
      fx.addLead(org, customer, opts);

    it('says what it says, as a bell alert that asks nobody to act, and the performers have the priority it always gave them', async () => {
      const { org, customer } = await quietOrg();
      const me = await personWith(org, opensLeads);
      const performer = await personWith(org, opensLeads);
      const dispatcher = await personWith(org, opensLeads);
      const l = await lead(org, customer, { dispatcher: dispatcher.id, walkthroughCrew: [performer.id] });
      const number = (await db.lead.findUniqueOrThrow({ where: { id: l.id }, select: { lead_number: true } })).lead_number;

      await send(org, me, l.id, [performer.id]);

      const alerts = await alertsFor(row.verb, l.id);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.title).toBe(row.title(number));
      // The word "unassigned" is gone from everything a person reads.
      expect(`${alerts[0]!.title} ${alerts[0]!.body ?? ''}`).not.toMatch(/unassigned/i);
      expect(alerts[0]).toMatchObject({ object_type: 'LEAD', object_id: l.id, category: 'LEAD', needs_action: false });
      expect(rowFor(alerts, performer)).toMatchObject({ priority: row.performerPriority, needs_action: false });
      expect(rowFor(alerts, dispatcher)).toMatchObject({ priority: 'FEED', needs_action: false });
    });

    it('with a Dispatcher: lane 1 and the Dispatcher are alerted, and no step holder; no role list reaches anyone', async () => {
      const { org, customer } = await quietOrg();
      const me = await personWith(org, opensLeads);
      const performer = await personWith(org, opensLeads);
      const dispatcher = await personWith(org, opensLeads);
      const holder = await personWith(org, stepValues);
      // A Dispatcher-role person and an Admin-role person holding nothing: a role name tells nobody anything now.
      const dispatcherRole = await personWith(org, opensLeads, 'DISPATCHER');
      const adminRole = await personWith(org, opensLeads, 'ADMIN');
      const l = await lead(org, customer, { dispatcher: dispatcher.id, walkthroughCrew: [performer.id] });

      await send(org, me, l.id, [performer.id]);

      const got = recipientsOf(await alertsFor(row.verb, l.id));
      expect(got).toEqual(ids(performer, dispatcher));
      for (const who of [holder, dispatcherRole, adminRole, me]) expect(got).not.toContain(who.id);
    });

    it('without a Dispatcher: lane 1 plus every step switch holder on a custom role who can open the lead; an Admin-role person with the switch off is not one', async () => {
      const { org, customer } = await quietOrg();
      const me = await personWith(org, opensLeads);
      const performer = await personWith(org, opensLeads);
      const holder = await personWith(org, stepValues);
      const secondHolder = await personWith(org, stepValues, 'TECHNICIAN');
      // Based on the Admin role with the step switch off: a role name holds nothing, the switch does.
      const adminSwitchOff = await personWith(org, opensLeads, 'ADMIN');
      const cannotOpen = await personWith(org, { view_leads: true, leads_scope: 'attached', assign_people_to_leads: true });
      const gone = await personWith(org, stepValues);
      await db.user.update({ where: { id: gone.id }, data: { is_active: false } });
      // An Admin holds the step switch too (every switch), so they are one of the holders.
      const admin = await personWith(org, adminValues);
      const l = await lead(org, customer, { walkthroughCrew: [performer.id] });

      await send(org, me, l.id, [performer.id]);

      const got = recipientsOf(await alertsFor(row.verb, l.id));
      expect(got).toEqual(ids(performer, holder, secondHolder, admin));
      for (const who of [adminSwitchOff, cannotOpen, gone]) expect(got).not.toContain(who.id);
    });

    it('without a Dispatcher and with no other step holder who can open the lead: the Admins, told as holders of the step', async () => {
      const { org, customer } = await quietOrg();
      const me = await personWith(org, opensLeads);
      const admin = await personWith(org, adminValues);
      const cannotOpen = await personWith(org, { view_leads: true, leads_scope: 'attached', assign_people_to_leads: true });
      const noSwitch = await personWith(org, opensLeads);
      const l = await lead(org, customer, {});

      await send(org, me, l.id);

      const alerts = await alertsFor(row.verb, l.id);
      expect(recipientsOf(alerts)).toEqual(ids(admin));
      expect(recipientsOf(alerts)).not.toContain(cannotOpen.id);
      expect(recipientsOf(alerts)).not.toContain(noSwitch.id);
      // An Admin holds the step, and the "Alert me about every ..." switch too: told once, without the why line (a covering
      // person who also has a copy is told without it), never twice.
      expect(whyFor(alerts, admin)).toBeNull();
      expect(alerts.filter((n) => n.recipients.some((r) => r.recipient_id === admin.id))).toHaveLength(1);
    });

    describe('a Dispatcher who cannot take the alert sends the chain to step 2 with the matching why line', () => {
      const cases: Array<[string, string, (org: string, dispatcher: Person, me: Person) => Promise<Person>]> = [
        ['is deactivated', "This lead's Dispatcher is not available.", async (_org, dispatcher) => {
          await db.user.update({ where: { id: dispatcher.id }, data: { is_active: false } });
          return dispatcher;
        }],
        ['did the action', "This lead's Dispatcher made this change.", async (_org, _dispatcher, me) => me],
        // Being the lead's Dispatcher attaches them to it, so only a role that cannot see leads at all cannot open it.
        ['cannot open the lead', "This lead's Dispatcher is not available.", async (org) => personWith(org, {})],
      ];
      it.each(cases)('a Dispatcher who %s', async (_label, line, makeDispatcher) => {
        const { org, customer } = await quietOrg();
        const me = await personWith(org, opensLeads);
        const holder = await personWith(org, stepValues);
        const dispatcher = await makeDispatcher(org, await personWith(org, opensLeads), me);
        const l = await lead(org, customer, { dispatcher: dispatcher.id });

        await send(org, me, l.id);

        const alerts = await alertsFor(row.verb, l.id);
        expect(recipientsOf(alerts)).toContain(holder.id);
        expect(whyFor(alerts, holder)).toBe(line);
        // The actor is never alerted, even as the lead's own Dispatcher.
        expect(recipientsOf(alerts)).not.toContain(me.id);
      });
    });

    it('a person found twice gets one alert', async () => {
      const { org, customer } = await quietOrg();
      const me = await personWith(org, opensLeads);
      // Performer, step holder and follower at once.
      const everywhere = await personWith(org, { ...stepValues, alert_every_lead: true });
      const l = await lead(org, customer, { walkthroughCrew: [everywhere.id] });

      await send(org, me, l.id, [everywhere.id]);

      const alerts = await alertsFor(row.verb, l.id);
      expect(recipientsOf(alerts)).toEqual(ids(everywhere));
      // ...and a performer found in every lane keeps the verb's performer priority.
      expect(rowFor(alerts, everywhere)).toMatchObject({ priority: row.performerPriority });
    });

    it('copies reach "Alert me about every lead" holders on leads they can open, also when there is a Dispatcher, never on leads they cannot open; a copy never stops the chain', async () => {
      const { org, customer } = await quietOrg();
      const me = await personWith(org, opensLeads);
      const dispatcher = await personWith(org, opensLeads);
      const follower = await personWith(org, { ...opensLeads, alert_every_lead: true });
      const blindFollower = await personWith(org, { view_leads: true, leads_scope: 'attached', alert_every_lead: true });
      const withDispatcher = await lead(org, customer, { dispatcher: dispatcher.id });

      await send(org, me, withDispatcher.id);

      const first = await alertsFor(row.verb, withDispatcher.id);
      expect(recipientsOf(first)).toEqual(ids(dispatcher, follower));
      expect(recipientsOf(first)).not.toContain(blindFollower.id);
      expect(rowFor(first, follower)).toMatchObject({ priority: 'FEED', needs_action: false });

      // No Dispatcher and no other step holder: the follower is told as a copy and the chain still goes on, to the Admin.
      const admin = await personWith(org, adminValues);
      const bare = await lead(org, customer, {});
      await send(org, me, bare.id);
      expect(recipientsOf(await alertsFor(row.verb, bare.id))).toEqual(ids(follower, admin));
    });

    it('the why line is on step 2 and step 3 and not on lane 1, step 1 or copies', async () => {
      const { org, customer } = await quietOrg();
      const me = await personWith(org, opensLeads);
      const performer = await personWith(org, opensLeads);
      const follower = await personWith(org, { ...opensLeads, alert_every_lead: true });
      const holder = await personWith(org, stepValues);
      const dispatcher = await personWith(org, opensLeads);

      // Step 2: no Dispatcher, so the step holder is covering.
      const noDispatcher = await lead(org, customer, { walkthroughCrew: [performer.id] });
      await send(org, me, noDispatcher.id, [performer.id]);
      const step2 = await alertsFor(row.verb, noDispatcher.id);
      expect(whyFor(step2, holder)).toBe('This lead has no Dispatcher.');
      expect(whyFor(step2, performer)).toBeNull();
      expect(whyFor(step2, follower)).toBeNull();

      // Step 1: the Dispatcher took it; nobody is covering, so no line anywhere.
      const withDispatcher = await lead(org, customer, { dispatcher: dispatcher.id, walkthroughCrew: [performer.id] });
      await send(org, me, withDispatcher.id, [performer.id]);
      const step1 = await alertsFor(row.verb, withDispatcher.id);
      expect(step1.every((n) => n.body === null)).toBe(true);
      expect(recipientsOf(step1)).toEqual(ids(performer, dispatcher, follower));
    });

    it('a chain that finds nobody writes one log entry with the alert kind, record id and org id and no customer content; one that finds someone writes none', async () => {
      const { org, customer } = await quietOrg();
      const me = await personWith(org, opensLeads);
      const warn = vi.spyOn(logger, 'warn');
      const kind = row.verb === 'lead.unassigned_created' ? 'new lead with no owner' : 'walkthrough scheduled';

      const lonely = await lead(org, customer, {});
      await send(org, me, lonely.id);

      expect(await alertsFor(row.verb, lonely.id)).toEqual([]);
      expect(gapsLogged(warn, kind)).toHaveLength(1);
      expect(gapsLogged(warn, kind)[0]![1]).toMatchObject({ organizationId: org, recordId: lonely.id });
      // The customer on this lead is called Pat Payer: nothing of the customer reaches the log.
      expect(JSON.stringify(gapsLogged(warn, kind)[0])).not.toMatch(/Pat|Payer/);

      warn.mockClear();
      const holder = await personWith(org, stepValues);
      const covered = await lead(org, customer, {});
      await send(org, me, covered.id);
      expect(recipientsOf(await alertsFor(row.verb, covered.id))).toEqual(ids(holder));
      expect(gapsLogged(warn, kind)).toHaveLength(0);
    });

    it('a lane 1 person alone is somebody: no log, even when nobody can act', async () => {
      const { org, customer } = await quietOrg();
      const me = await personWith(org, opensLeads);
      const performer = await personWith(org, opensLeads);
      const warn = vi.spyOn(logger, 'warn');
      const l = await lead(org, customer, { walkthroughCrew: [performer.id] });

      await send(org, me, l.id, [performer.id]);

      expect(recipientsOf(await alertsFor(row.verb, l.id))).toEqual(ids(performer));
      expect((warn.mock.calls as unknown[][]).filter((call) => String(call[0]).includes('nobody to tell'))).toHaveLength(0);
    });

    it('nobody is told about a lead in another company or one that is gone, and nothing throws', async () => {
      const { org } = await quietOrg();
      const { org: other, customer: theirCustomer } = await quietOrg();
      const holderHere = await personWith(org, stepValues);
      const theirs = await lead(other, theirCustomer, {});

      await send(org, null, theirs.id);
      await send(org, null, '00000000-0000-4000-8000-000000000000');

      expect(await alertsFor(row.verb, theirs.id)).toEqual([]);
      expect(recipientsOf(await db.notification.findMany({ where: { organization_id: org, verb: row.verb }, include: { recipients: true } }))).not.toContain(holderHere.id);
    });
  });


  describe.each(ESTIMATE_VERBS)('$verb', (row) => {
    const copyValues = Object.fromEntries(row.copySwitches.map((key) => [key, true]));

    /** Send this verb's alert for an estimate, as the estimate routes do after their response. */
    async function send(org: string, actor: Person | null, estimateId: string, extra: { data?: Record<string, unknown>; dedupKey?: string } = {}) {
      const { alertEstimate } = await import('../services/notifications/leadEstimateAlerts.js');
      await alertEstimate({ verb: row.verb, organizationId: org, actorId: actor?.id ?? null, estimateId, ...extra });
    }

    /** An estimate on a lead (with its Owner, Dispatcher and walkthrough crew), on a job, or on neither. */
    async function estimateOn(
      place: 'lead' | 'job' | 'neither',
      world: { org: string; customer: string; admin: Person },
      people: { owner?: Person; dispatcher?: Person; performers?: Person[]; soldBy?: Person; crew?: Person[] } = {},
    ) {
      const { org, customer, admin } = world;
      if (place === 'neither') return fx.addEstimate(org, customer, admin.id);
      const lead = await fx.addLead(org, customer, {
        owner: people.owner?.id, dispatcher: place === 'lead' ? people.dispatcher?.id : undefined, walkthroughCrew: (people.performers ?? []).map((p) => p.id),
      });
      if (place === 'lead') return fx.addEstimate(org, customer, admin.id, { leadId: lead.id });
      const job = await fx.addJob(org, customer, { soldBy: people.soldBy?.id, dispatcher: people.dispatcher?.id, crew: (people.crew ?? []).map((p) => p.id) });
      return fx.addEstimate(org, customer, admin.id, { leadId: lead.id, jobId: job.id });
    }
    const numberOf = async (estimateId: string) => (await db.estimate.findUniqueOrThrow({ where: { id: estimateId }, select: { estimate_number: true } })).estimate_number;
    const quiet = async () => {
      const world = await quietOrg();
      return { ...world, me: await personWith(world.org, opensEstimates) };
    };

    it('says what it says, and the Owner, the people who must act and the rest have the priority and "needs action" it always gave them', async () => {
      const world = await quiet();
      const owner = await personWith(world.org, opensEstimates);
      const dispatcher = await personWith(world.org, opensEstimates);
      const performer = await personWith(world.org, opensEstimates);
      const e = await estimateOn('lead', world, { owner, dispatcher, performers: [performer] });

      await send(world.org, world.me, e.id);

      const alerts = await alertsFor(row.verb, e.id);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.title).toBe(row.title(await numberOf(e.id)));
      expect(alerts[0]).toMatchObject({ object_type: 'ESTIMATE', object_id: e.id, category: 'ESTIMATE' });
      expect(rowFor(alerts, owner)).toMatchObject({ priority: row.ownerPriority, needs_action: false });
      expect(rowFor(alerts, performer)).toMatchObject({ priority: 'FEED', needs_action: false });
      // The Dispatcher took step 1, so they are who must act: asked to schedule the job on a win and a deposit, only told otherwise.
      expect(rowFor(alerts, dispatcher)).toMatchObject({ priority: 'FEED', needs_action: row.asksToSchedule });
    });

    it('on a lead with a Dispatcher: the Owner, the performers and the Dispatcher are alerted, and no step holder; no role list reaches anyone', async () => {
      const world = await quiet();
      const owner = await personWith(world.org, opensEstimates);
      const dispatcher = await personWith(world.org, opensEstimates);
      const performer = await personWith(world.org, opensEstimates);
      const holder = await personWith(world.org, { ...opensEstimates, assign_people_to_leads: true, assign_people_to_jobs: true });
      const dispatcherRole = await personWith(world.org, opensEstimates, 'DISPATCHER');
      const adminRole = await personWith(world.org, opensEstimates, 'ADMIN');
      const e = await estimateOn('lead', world, { owner, dispatcher, performers: [performer] });

      await send(world.org, world.me, e.id);

      const got = recipientsOf(await alertsFor(row.verb, e.id));
      expect(got).toEqual(ids(owner, dispatcher, performer));
      for (const who of [holder, dispatcherRole, adminRole, world.me]) expect(got).not.toContain(who.id);
    });

    it('on a lead with no Dispatcher: the Owner plus every step switch holder on a custom role who can open the estimate and the lead; an Admin-role person with the switch off is not one', async () => {
      const world = await quiet();
      const owner = await personWith(world.org, opensEstimates);
      const stepValues = { ...opensEstimates, [row.leadStep]: true };
      const holder = await personWith(world.org, stepValues);
      const secondHolder = await personWith(world.org, stepValues, 'TECHNICIAN');
      const adminSwitchOff = await personWith(world.org, opensEstimates, 'ADMIN');
      // Holds the step but cannot open the estimate, and one who can open the estimate but not the lead.
      const cannotOpenEstimate = await personWith(world.org, { ...stepValues, view_estimates: false });
      const cannotOpenLead = await personWith(world.org, { ...stepValues, leads_scope: 'attached' });
      const gone = await personWith(world.org, stepValues);
      await db.user.update({ where: { id: gone.id }, data: { is_active: false } });
      // An Admin holds the step switch too (every switch), so they are one of the holders.
      const admin = await personWith(world.org, { ...opensEstimates, is_admin: true, view_users: true });
      const e = await estimateOn('lead', world, { owner });

      await send(world.org, world.me, e.id);

      const got = recipientsOf(await alertsFor(row.verb, e.id));
      expect(got).toEqual(ids(owner, holder, secondHolder, admin));
      for (const who of [adminSwitchOff, cannotOpenEstimate, cannotOpenLead, gone]) expect(got).not.toContain(who.id);
    });

    it('on a lead with no Dispatcher and no other step holder who can open it: the Admins, told as holders of the step, with the why line', async () => {
      const world = await quiet();
      const admin = await personWith(world.org, { ...opensEstimates, is_admin: true, view_users: true });
      const cannotOpen = await personWith(world.org, { ...opensEstimates, jobs_scope: 'attached', leads_scope: 'attached', [row.leadStep]: true });
      const noSwitch = await personWith(world.org, opensEstimates);
      const e = await estimateOn('lead', world);

      await send(world.org, world.me, e.id);

      const alerts = await alertsFor(row.verb, e.id);
      expect(recipientsOf(alerts)).toEqual(ids(admin));
      expect(recipientsOf(alerts)).not.toContain(cannotOpen.id);
      expect(recipientsOf(alerts)).not.toContain(noSwitch.id);
      // An Admin holds the step, and the "Alert me about every ..." switch too: told once, without the why line (a covering
      // person who also has a copy is told without it), never twice.
      expect(whyFor(alerts, admin)).toBeNull();
      expect(alerts.filter((n) => n.recipients.some((r) => r.recipient_id === admin.id))).toHaveLength(1);
    });

    it('on a job: its Sold By, crew and Dispatcher and the estimate\'s Owner, and Assign people to jobs is the step whatever the verb', async () => {
      const world = await quiet();
      const owner = await personWith(world.org, opensEstimates);
      const soldBy = await personWith(world.org, opensEstimates);
      const crew = await personWith(world.org, opensEstimates);
      const dispatcher = await personWith(world.org, opensEstimates);
      const jobHolder = await personWith(world.org, { ...opensEstimates, assign_people_to_jobs: true });
      const leadHolder = await personWith(world.org, { ...opensEstimates, assign_people_to_leads: true });

      const withDispatcher = await estimateOn('job', world, { owner, soldBy, crew: [crew], dispatcher });
      await send(world.org, world.me, withDispatcher.id);
      expect(recipientsOf(await alertsFor(row.verb, withDispatcher.id))).toEqual(ids(owner, soldBy, crew, dispatcher));

      const without = await estimateOn('job', world, { owner, soldBy, crew: [crew] });
      await send(world.org, world.me, without.id);
      const alerts = await alertsFor(row.verb, without.id);
      expect(recipientsOf(alerts)).toEqual(ids(owner, soldBy, crew, jobHolder));
      expect(recipientsOf(alerts)).not.toContain(leadHolder.id);
      expect(whyFor(alerts, jobHolder)).toBe('This job has no Dispatcher.');
      expect(whyFor(alerts, owner)).toBeNull();
    });

    it('a standalone estimate (no lead, no job) starts at step 2 with "This estimate has no lead or job.", no lane 1', async () => {
      const world = await quiet();
      const holder = await personWith(world.org, { ...opensEstimates, [row.leadStep]: true });
      const e = await estimateOn('neither', world);

      await send(world.org, world.me, e.id);
      let alerts = await alertsFor(row.verb, e.id);
      expect(recipientsOf(alerts)).toEqual(ids(holder));
      expect(whyFor(alerts, holder)).toBe('This estimate has no lead or job.');

      // The holder gone, an Admin is the one who holds the step (every switch); they hold the copy switches too, so they are
      // told once, without the line.
      await db.user.update({ where: { id: holder.id }, data: { is_active: false } });
      const admin = await personWith(world.org, { ...opensEstimates, is_admin: true, view_users: true });
      await db.notification.deleteMany({ where: { object_id: e.id } });
      await send(world.org, world.me, e.id);
      alerts = await alertsFor(row.verb, e.id);
      expect(recipientsOf(alerts)).toEqual(ids(admin));
      expect(whyFor(alerts, admin)).toBeNull();
    });

    describe('a Dispatcher who cannot take the alert sends the chain to step 2 with the matching why line', () => {
      const cases: Array<[string, string, (org: string, dispatcher: Person, me: Person) => Promise<Person>]> = [
        ['is deactivated', "This lead's Dispatcher is not available.", async (_org, dispatcher) => {
          await db.user.update({ where: { id: dispatcher.id }, data: { is_active: false } });
          return dispatcher;
        }],
        ['did the action', "This lead's Dispatcher made this change.", async (_org, _dispatcher, me) => me],
        // Being the lead's Dispatcher attaches them to the lead, but opening the ESTIMATE is its own question.
        ['cannot open the estimate', "This lead's Dispatcher is not available.", async (org) => personWith(org, { ...opensLeads, view_estimates: false })],
        ['cannot open the lead', "This lead's Dispatcher is not available.", async (org) => personWith(org, { view_estimates: true, jobs_scope: 'all', leads_scope: 'all' })],
      ];
      it.each(cases)('a Dispatcher who %s', async (_label, line, makeDispatcher) => {
        const world = await quiet();
        const holder = await personWith(world.org, { ...opensEstimates, [row.leadStep]: true });
        const dispatcher = await makeDispatcher(world.org, await personWith(world.org, opensEstimates), world.me);
        const e = await estimateOn('lead', world, { dispatcher });

        await send(world.org, world.me, e.id);

        const alerts = await alertsFor(row.verb, e.id);
        expect(recipientsOf(alerts)).toContain(holder.id);
        expect(whyFor(alerts, holder)).toBe(line);
        expect(recipientsOf(alerts)).not.toContain(world.me.id);
        if (dispatcher.id !== world.me.id) expect(recipientsOf(alerts)).not.toContain(dispatcher.id);
      });
    });

    it('an alert never names an estimate to someone who cannot open it, not even the lead\'s Owner or a performer: they are left out and the chain goes on', async () => {
      const world = await quiet();
      // On the lead, but View estimates is off for them.
      const blindOwner = await personWith(world.org, opensLeads);
      const blindPerformer = await personWith(world.org, opensLeads);
      const sighted = await personWith(world.org, opensEstimates);
      const holder = await personWith(world.org, { ...opensEstimates, [row.leadStep]: true });
      const e = await estimateOn('lead', world, { owner: blindOwner, performers: [blindPerformer, sighted] });

      await send(world.org, world.me, e.id);

      const alerts = await alertsFor(row.verb, e.id);
      expect(recipientsOf(alerts)).toEqual(ids(sighted, holder));
      for (const n of alerts) expect(recipientsOf([n])).not.toContain(blindOwner.id);
      expect(recipientsOf(alerts)).not.toContain(blindPerformer.id);
    });

    it('a person found twice gets one alert, and the Owner found in every lane keeps the Owner\'s priority', async () => {
      const world = await quiet();
      const everywhere = await personWith(world.org, { ...opensEstimates, [row.leadStep]: true, ...copyValues });
      const e = await estimateOn('lead', world, { owner: everywhere, performers: [everywhere] });

      await send(world.org, world.me, e.id);

      const alerts = await alertsFor(row.verb, e.id);
      expect(recipientsOf(alerts)).toEqual(ids(everywhere));
      expect(rowFor(alerts, everywhere)).toMatchObject({ priority: row.ownerPriority, needs_action: row.asksToSchedule });
    });

    it('copies reach the holders of the copy switches on estimates they can open, also when there is a Dispatcher, once each, never on estimates they cannot open; a copy never stops the chain', async () => {
      const world = await quiet();
      const dispatcher = await personWith(world.org, opensEstimates);
      const followers: Person[] = [];
      for (const key of row.copySwitches) followers.push(await personWith(world.org, { ...opensEstimates, [key]: true }));
      // A person holding every copy switch is still one alert.
      const holdsAll = await personWith(world.org, { ...opensEstimates, ...copyValues });
      const blind = await personWith(world.org, { ...opensEstimates, jobs_scope: 'attached', leads_scope: 'attached', ...copyValues });
      const withDispatcher = await estimateOn('lead', world, { dispatcher });

      await send(world.org, world.me, withDispatcher.id);

      const first = await alertsFor(row.verb, withDispatcher.id);
      expect(recipientsOf(first)).toEqual(ids(dispatcher, holdsAll, ...followers));
      expect(recipientsOf(first)).not.toContain(blind.id);
      expect(rowFor(first, holdsAll)).toMatchObject({ priority: 'FEED', needs_action: false });

      // No Dispatcher and no other step holder: the copies still go, and the chain goes on to the Admin.
      const admin = await personWith(world.org, { ...opensEstimates, is_admin: true, view_users: true });
      const bare = await estimateOn('lead', world);
      await send(world.org, world.me, bare.id);
      expect(recipientsOf(await alertsFor(row.verb, bare.id))).toEqual(ids(admin, holdsAll, ...followers));
    });

    it('the why line is on step 2 and step 3 and not on lane 1, step 1 or copies', async () => {
      const world = await quiet();
      const owner = await personWith(world.org, opensEstimates);
      const follower = await personWith(world.org, { ...opensEstimates, alert_every_estimate: true });
      const holder = await personWith(world.org, { ...opensEstimates, [row.leadStep]: true });
      const dispatcher = await personWith(world.org, opensEstimates);

      const noDispatcher = await estimateOn('lead', world, { owner });
      await send(world.org, world.me, noDispatcher.id);
      const step2 = await alertsFor(row.verb, noDispatcher.id);
      expect(whyFor(step2, holder)).toBe('This lead has no Dispatcher.');
      expect(whyFor(step2, owner)).toBeNull();
      expect(whyFor(step2, follower)).toBeNull();

      const withDispatcher = await estimateOn('lead', world, { owner, dispatcher });
      await send(world.org, world.me, withDispatcher.id);
      const step1 = await alertsFor(row.verb, withDispatcher.id);
      expect(step1.every((n) => n.body === null)).toBe(true);
      expect(recipientsOf(step1)).toEqual(ids(owner, dispatcher, follower));
    });

    it('a chain that finds nobody writes one log entry with the alert kind, record id and org id and no customer content; one that finds someone writes none', async () => {
      const world = await quiet();
      const warn = vi.spyOn(logger, 'warn');

      const lonely = await estimateOn('lead', world);
      await send(world.org, world.me, lonely.id);

      expect(await alertsFor(row.verb, lonely.id)).toEqual([]);
      expect(gapsLogged(warn, row.kind)).toHaveLength(1);
      expect(gapsLogged(warn, row.kind)[0]![1]).toMatchObject({ organizationId: world.org, recordId: lonely.id });
      expect(JSON.stringify(gapsLogged(warn, row.kind)[0])).not.toMatch(/Pat|Payer/);

      warn.mockClear();
      const holder = await personWith(world.org, { ...opensEstimates, [row.leadStep]: true });
      const covered = await estimateOn('lead', world);
      await send(world.org, world.me, covered.id);
      expect(recipientsOf(await alertsFor(row.verb, covered.id))).toEqual(ids(holder));
      expect(gapsLogged(warn, row.kind)).toHaveLength(0);
    });

    it('doors that report one event share a key: the second report sends nothing, and the covering people\'s alert is not mistaken for the others\'', async () => {
      const world = await quiet();
      const owner = await personWith(world.org, opensEstimates);
      const holder = await personWith(world.org, { ...opensEstimates, [row.leadStep]: true });
      const e = await estimateOn('lead', world, { owner });
      const dedupKey = `${row.verb}:${e.id}`;

      await send(world.org, world.me, e.id, { dedupKey });
      await send(world.org, world.me, e.id, { dedupKey });

      const alerts = await alertsFor(row.verb, e.id);
      expect(alerts).toHaveLength(2); // one without the line (the Owner), one with it (the covering holder)
      expect(recipientsOf(alerts)).toEqual(ids(owner, holder));
    });

    it('nobody is told about an estimate in another company or one that is gone, and nothing throws', async () => {
      const { org } = await quietOrg();
      const other = await quietOrg();
      const holderHere = await personWith(org, { ...opensEstimates, [row.leadStep]: true });
      const theirs = await fx.addEstimate(other.org, other.customer, other.admin.id);

      await send(org, null, theirs.id);
      await send(org, null, '00000000-0000-4000-8000-000000000000');

      expect(await alertsFor(row.verb, theirs.id)).toEqual([]);
      expect(recipientsOf(await db.notification.findMany({ where: { organization_id: org, verb: row.verb }, include: { recipients: true } }))).not.toContain(holderHere.id);
    });
  });


  describe('every door that raises an estimate alert', () => {
    type Door = {
      name: string;
      verb: EstimateVerb['verb'];
      /** The status the estimate is in when the door is used. */
      status: 'DRAFT' | 'SENT' | 'WON';
      /** Called as the Admin-box actor; the public pages are called with the estimate's token and nobody signed in. */
      call: (api: Awaited<ReturnType<typeof fx.signedInAs>>, id: string, token: string) => Promise<{ status: number; body: unknown }>;
      /** Nobody is signed in: there is no person who did it, so the company's own Admin-box people are told like anyone else. */
      publicPage?: boolean;
      /** Anything the door needs to find on the estimate first. */
      arrange?: (org: string, customer: string, estimateId: string) => Promise<void>;
    };
    const publicCall = async (path: string, body: object) => {
      const { default: request } = await import('supertest');
      const app = await fx.listener();
      const res = await request(app).post(path).send(body);
      return { status: res.status, body: res.body as unknown };
    };
    const DOORS: Door[] = [
      { name: 'Approve estimate (staff)', verb: 'estimate.approved', status: 'SENT', call: (api, id) => api.post(`/api/estimates/${id}/approve-internal`, {}) },
      { name: 'Decline estimate (staff)', verb: 'estimate.declined', status: 'SENT', call: (api, id) => api.post(`/api/estimates/${id}/decline-internal`, { lost_reason: 'PRICE' }) },
      { name: 'Archive (cancel) estimate', verb: 'estimate.cancelled', status: 'SENT', call: (api, id) => api.post(`/api/estimates/${id}/cancel`, { cancelled_reason: 'Customer went elsewhere' }) },
      {
        name: 'Waive the deposit', verb: 'estimate.deposit_waived', status: 'SENT',
        arrange: async (org, customer, estimateId) => {
          const deposit = await fx.addInvoice(org, customer, { estimateId });
          await db.invoice.update({ where: { id: deposit.id }, data: { kind: 'DEPOSIT', status: 'SENT' } });
        },
        call: (api, id) => api.post(`/api/estimates/${id}/waive-deposit`, { action: 'waive' }),
      },
      { name: 'Void the approval', verb: 'estimate.approval_voided', status: 'WON', call: (api, id) => api.post(`/api/estimates/${id}/void-approval`, {}) },
      { name: 'Set the status back to draft', verb: 'estimate.status_corrected', status: 'SENT', call: (api, id) => api.patch(`/api/estimates/${id}/status`, { transition: 'backtodraft' }) },
      { name: 'Set the status to Won (the pill)', verb: 'estimate.approved', status: 'SENT', call: (api, id) => api.patch(`/api/estimates/${id}/status`, { status: 'WON' }) },
      { name: 'Record the deposit payment', verb: 'estimate.deposit_paid', status: 'DRAFT', call: (api, id) => api.post(`/api/estimates/${id}/record-payment`, { amount: 10, payment_method: 'CASH' }) },
      {
        name: 'The customer approves on the public page (nobody signed in)', verb: 'estimate.approved', status: 'SENT', publicPage: true,
        call: (_api, id, token) => publicCall(`/api/estimates/${id}/approve?token=${token}`, { signature_data: 'data:image/png;base64,AAAA', terms_accepted: true }),
      },
      {
        name: 'The customer declines on the public page (nobody signed in)', verb: 'estimate.declined', status: 'SENT', publicPage: true,
        call: (_api, id, token) => publicCall(`/api/estimates/${id}/decline?token=${token}`, {}),
      },
    ];

    it.each(DOORS)('$name raises $verb for the Owner and the people who must act, after the response, and never for the person who did it', async (door) => {
      const world = await fx.newOrg();
      const owner = await personWith(world.org, opensEstimates);
      const holder = await personWith(world.org, { ...opensEstimates, assign_people_to_leads: true, assign_people_to_jobs: true });
      const lead = await fx.addLead(world.org, world.customer, { owner: owner.id });
      const e = await fx.addEstimate(world.org, world.customer, world.admin.id, { leadId: lead.id });
      const token = `tok${e.id}`;
      await db.estimate.update({ where: { id: e.id }, data: { status: door.status, public_token: token } });
      await door.arrange?.(world.org, world.customer, e.id);
      const api = await fx.signedInAs(world.admin);

      const res = await door.call(api, e.id, token);
      expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
      await reviewAttentionSettled();

      const alerts = await alertsFor(door.verb, e.id);
      // Nobody signed in did a public page's action; everywhere else the person who did it is left out.
      expect(recipientsOf(alerts), door.name).toEqual(door.publicPage ? ids(owner, holder, world.admin) : ids(owner, holder));
      expect(whyFor(alerts, holder)).toBe('This lead has no Dispatcher.');
      expect(whyFor(alerts, owner)).toBeNull();
      if (!door.publicPage) expect(recipientsOf(alerts)).not.toContain(world.admin.id);
    });
  });

  /** Wait for a condition the website form's own background work reaches after it has answered. */
  async function until<T>(read: () => Promise<T | null | undefined | false>, what: string): Promise<T> {
    for (let i = 0; i < 100; i += 1) {
      const found = await read();
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`gave up waiting for ${what}`);
  }

  describe('New lead with no owner, from every source', () => {
    const makesLeads = { ...opensLeads, edit_leads: true, create_leads: true, assign_people_to_leads: true };
    const holderValues = { ...opensLeads, assign_people_to_leads: true };
    const verb = 'lead.unassigned_created';
    const leadsOf = (org: string) => db.lead.findMany({ where: { organization_id: org }, select: { id: true, lead_number: true } });

    it('the new-lead form: a lead saved with no Owner alerts the Assign people to leads holders, with the why line; one with an Owner raises none', async () => {
      const { org, customer } = await quietOrg();
      const creator = await personWith(org, makesLeads);
      const holder = await personWith(org, holderValues);
      const owner = await personWith(org, { ...opensLeads, can_own_leads: true });
      const api = await fx.signedInAs(creator);

      const bare = await api.post('/api/leads', { customer_id: customer, service_request: 'Fix the door' });
      expect(bare.status, JSON.stringify(bare.body)).toBe(201);
      const owned = await api.post('/api/leads', { customer_id: customer, service_request: 'Fix the gate', assigned_to: owner.id });
      expect(owned.status, JSON.stringify(owned.body)).toBe(201);
      await reviewAttentionSettled();

      const alerts = await alertsFor(verb, bare.body.lead.id);
      expect(recipientsOf(alerts)).toEqual(ids(holder));
      expect(whyFor(alerts, holder)).toBe('This lead has no Dispatcher.');
      expect(alerts[0]!.title).toBe(`New lead with no owner (${bare.body.lead.lead_number})`);
      // The creator is the actor: never told. A lead with an Owner raises nothing at all.
      expect(await alertsFor(verb, owned.body.lead.id)).toEqual([]);
    });

    it('a lead made together with a new customer (the way a call from a new number becomes a lead) alerts the same people', async () => {
      const { org } = await quietOrg();
      const creator = await personWith(org, { ...makesLeads, view_customers: true, edit_customers: true, create_customers: true });
      const holder = await personWith(org, holderValues);
      const api = await fx.signedInAs(creator);

      const res = await api.post('/api/leads', { new_customer: { first_name: 'Cal', last_name: 'Ler', phone: '6095550142' }, service_request: 'AC not cooling' });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      await reviewAttentionSettled();

      const alerts = await alertsFor(verb, res.body.lead.id);
      expect(recipientsOf(alerts)).toEqual(ids(holder));
      expect(whyFor(alerts, holder)).toBe('This lead has no Dispatcher.');
    });

    it('the website form: a lead nobody made by hand reaches the Assign people to leads holders with the why line, and the copy holders without it', async () => {
      const { org } = await quietOrg();
      const holder = await personWith(org, holderValues);
      const follower = await personWith(org, { ...opensLeads, alert_every_lead: true });
      const token = `s0626${'f'.repeat(40)}${sequence}`;
      await db.webFormIntegration.create({ data: { organization_id: org, provider: 'forminator', url_token: token, enabled: true } });
      try {
        const { default: request } = await import('supertest');
        const app = await fx.listener();
        const res = await request(app)
          .post(`/api/webhooks/web-form/forminator/${token}`)
          .set('Content-Type', 'application/json')
          .send(JSON.stringify({ name_1: 'Dana', name_2: 'Okafor', email_1: 'dana.okafor@example.test', phone_1: '(609) 555-0123', textarea_1: 'A new front door.', form_title: 'Request a Quote' }));
        expect(res.status).toBe(200);

        const lead = await until(async () => (await leadsOf(org))[0], 'the website form lead');
        const alerts = await until(async () => {
          const found = await alertsFor(verb, lead.id);
          return found.length >= 2 ? found : null;
        }, 'the website form lead alert');
        expect(recipientsOf(alerts)).toEqual(ids(holder, follower));
        expect(whyFor(alerts, holder)).toBe('This lead has no Dispatcher.');
        expect(whyFor(alerts, follower)).toBeNull();
        // Nobody signed in made it, so there is nobody to leave out; a copy holder is told as one.
        expect(alerts.every((n) => n.actor_id === null)).toBe(true);
      } finally {
        await db.webFormSubmission.deleteMany({ where: { organization_id: org } });
        await db.webFormIntegration.deleteMany({ where: { organization_id: org } });
      }
    });

    it('the website form, with nobody to tell, logs the gap instead of dropping it silently', async () => {
      const { org } = await quietOrg();
      const warn = vi.spyOn(logger, 'warn');
      const token = `s0626${'e'.repeat(40)}${sequence}`;
      await db.webFormIntegration.create({ data: { organization_id: org, provider: 'forminator', url_token: token, enabled: true } });
      try {
        const { default: request } = await import('supertest');
        const app = await fx.listener();
        await request(app)
          .post(`/api/webhooks/web-form/forminator/${token}`)
          .set('Content-Type', 'application/json')
          .send(JSON.stringify({ name_1: 'Dana', name_2: 'Okafor', phone_1: '(609) 555-0123', textarea_1: 'A new front door.', form_title: 'Request a Quote' }));
        const lead = await until(async () => (await leadsOf(org))[0], 'the website form lead');
        await until(async () => gapsLogged(warn, 'new lead with no owner').length > 0, 'the log entry');
        expect(gapsLogged(warn, 'new lead with no owner')[0]![1]).toMatchObject({ organizationId: org, recordId: lead.id });
      } finally {
        await db.webFormSubmission.deleteMany({ where: { organization_id: org } });
        await db.webFormIntegration.deleteMany({ where: { organization_id: org } });
      }
    });
  });

  describe('Walkthrough scheduled, from the new-lead form', () => {
    it('a walkthrough booked while the lead is made tells the people booked (interrupting them) and whoever covers for the missing Dispatcher', async () => {
      const { org, customer } = await quietOrg();
      const creator = await personWith(org, { ...opensLeads, view_jobs: true, jobs_scope: 'all', edit_leads: true, create_leads: true, assign_people_to_leads: true, assign_work_to_others: true });
      const performer = await personWith(org, { ...opensLeads, can_be_on_crew: true });
      const holder = await personWith(org, { ...opensLeads, assign_people_to_leads: true });
      const api = await fx.signedInAs(creator);

      const res = await api.post('/api/leads', {
        customer_id: customer, service_request: 'Fix the door', scheduled_start: new Date(Date.now() + 3 * 86_400_000).toISOString(),
        walkthrough_performer_ids: [performer.id], send_email: false,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      await reviewAttentionSettled();

      const alerts = await alertsFor('lead.walkthrough_scheduled', res.body.lead.id);
      expect(recipientsOf(alerts)).toEqual(ids(performer, holder));
      expect(rowFor(alerts, performer)).toMatchObject({ priority: 'INTERRUPT' });
      expect(rowFor(alerts, holder)).toMatchObject({ priority: 'FEED' });
      expect(whyFor(alerts, holder)).toBe('This lead has no Dispatcher.');
    });
  });

  describe('Deposit paid, from the invoice page', () => {
    it('recording the full payment on a deposit invoice raises the alert for the estimate\'s people, after the response', async () => {
      const world = await fx.newOrg();
      const owner = await personWith(world.org, opensEstimates);
      const holder = await personWith(world.org, { ...opensEstimates, assign_people_to_jobs: true });
      const lead = await fx.addLead(world.org, world.customer, { owner: owner.id });
      const e = await fx.addEstimate(world.org, world.customer, world.admin.id, { leadId: lead.id });
      await db.estimate.update({ where: { id: e.id }, data: { status: 'SENT' } });
      const deposit = await fx.addInvoice(world.org, world.customer, { estimateId: e.id });
      await db.invoice.update({ where: { id: deposit.id }, data: { kind: 'DEPOSIT', status: 'SENT' } });
      const api = await fx.signedInAs(world.admin);

      const res = await api.post(`/api/invoices/${deposit.id}/payments`, { amount: 100, method: 'CASH' });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      await reviewAttentionSettled();

      const alerts = await alertsFor('estimate.deposit_paid', e.id);
      expect(recipientsOf(alerts)).toEqual(ids(owner, holder));
      // The one who must act is asked to schedule the job.
      expect(rowFor(alerts, holder)).toMatchObject({ needs_action: true });
      expect(rowFor(alerts, owner)).toMatchObject({ priority: 'INTERRUPT', needs_action: false });
    });
  });

  describe('Walkthrough scheduled, from the lead page', () => {
    it('tells the Owner, the people booked and the lead\'s Dispatcher, and interrupts only the people booked', async () => {
      const { org, customer } = await quietOrg();
      const booker = await personWith(org, { ...opensLeads, view_jobs: true, jobs_scope: 'all', book_walkthroughs: true, assign_work_to_others: true });
      const performer = await personWith(org, { ...opensLeads, can_be_on_crew: true });
      const owner = await personWith(org, opensLeads);
      const dispatcher = await personWith(org, opensLeads);
      const l = await fx.addLead(org, customer, { owner: owner.id, dispatcher: dispatcher.id });
      const api = await fx.signedInAs(booker);

      const res = await api.post(`/api/leads/${l.id}/walkthrough/schedule`, {
        walkthrough_scheduled_at: new Date(Date.now() + 3 * 86_400_000).toISOString(), performer_ids: [performer.id], send_email: false,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await reviewAttentionSettled();

      const alerts = await alertsFor('lead.walkthrough_scheduled', l.id);
      expect(recipientsOf(alerts)).toEqual(ids(owner, performer, dispatcher));
      expect(rowFor(alerts, performer)).toMatchObject({ priority: 'INTERRUPT' });
      expect(rowFor(alerts, owner)).toMatchObject({ priority: 'FEED' });
      expect(rowFor(alerts, dispatcher)).toMatchObject({ priority: 'FEED' });
    });
  });
});
