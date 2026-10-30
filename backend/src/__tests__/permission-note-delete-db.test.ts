/* =============================================================================
   Roles & Permissions, PRD 4, slice S04.25 and AL-07 (P10, A8d) - deleting a note on a job or a lead: the author's own,
   anyone's with the record's Edit (Edit jobs, Edit leads), the completed-job lock, and the activity entry that keeps the
   text. There is no Delete-other-people's-notes switch: a note is the record's own data.

   Everything goes through the public interface: the note routes (list, delete) and the record's timeline, called as
   people on custom roles (never a built-in role name) holding exactly the switch values under test. Real migrated
   database (TEST_DATABASE_URL); the suite skips when it is unset.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { JobStatus, LeadStatus, PrismaClient, Role } from '@prisma/client';

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
import { SWITCH_CATALOG, findSwitch, type SwitchValue } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;

/** Every switch in the catalog off (a choice at its first option, a list empty), so a case turns on exactly the ones it is about. */
const ALL_OFF: Record<string, SwitchValue> = Object.fromEntries(
  SWITCH_CATALOG.map((s) => [s.key, s.kind === 'choice' ? s.choices![0]! : s.kind === 'list' ? [] : false]),
);

/** The wording the PRD gives the lock refusal (its own text, not read from the code). */
const LOCK_MESSAGE = 'This job is locked. Only someone who can change locked jobs can change it.';

/** What opening a job and a lead takes, with no note switch on. */
const OPENING = { view_jobs: true, jobs_scope: 'all', view_leads: true, leads_scope: 'all' };

/** The Edit of each record a note hangs on: what deletes anyone's note on it. */
const EDITS = { edit_jobs: true, edit_leads: true };

const lockedStatuses: JobStatus[] = ['COMPLETED', 'OFFICE_REVIEW', 'READY_TO_CLOSE', 'DONE', 'CANCELLED'];

suite('deleting a note on a job or a lead (real database)', () => {
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
      for (const table of ['notes', 'timeline_events']) {
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

  /** A person on a fresh custom role holding exactly these switch values over everything else off. */
  async function personWith(org: string, values: Record<string, SwitchValue>, opts: { base?: Role; name?: string } = {}) {
    const key = `note-delete-role-${++sequence}`;
    const base = opts.base ?? 'DISPATCHER';
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { ...ALL_OFF, ...OPENING, ...values }, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, opts.name ?? `p${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  type Entity = { type: 'JOB' | 'LEAD'; id: string };

  async function addNote(org: string, entity: Entity, writtenBy: string, content = `note ${randomUUID().slice(0, 6)}`) {
    const note = await db.note.create({
      data: { organization_id: org, entity_type: entity.type, entity_id: entity.id, content, created_by: writtenBy },
      select: { id: true },
    });
    return note.id;
  }

  const notesLeft = (id: string) => db.note.count({ where: { id } });
  const route = (e: Entity, note?: string) => `/api/${e.type.toLowerCase()}s/${e.id}/notes${note ? `/${note}` : ''}`;
  const reopen = (jobId: string) => db.job.update({ where: { id: jobId }, data: { status: 'SCHEDULED' }, select: { id: true } });

  describe('a person\'s own notes, and the record\'s Edit for anyone else\'s', () => {
    it('deletes their own note on an unlocked job and on a lead, with no note switch on, and is refused someone else\'s', async () => {
      const { org, customer, admin } = await newOrg();
      const job = await fx.addJob(org, customer);
      const lead = await fx.addLead(org, customer);
      const person = await personWith(org, {});
      const api = await person.api();
      for (const e of [{ type: 'JOB', id: job.id }, { type: 'LEAD', id: lead.id }] as Entity[]) {
        const mine = await addNote(org, e, person.id);
        const theirs = await addNote(org, e, admin.id);
        const refused = await api.delete(route(e, theirs));
        expect(refused.status, `${e.type} someone else's`).toBe(403);
        expect(refused.body.error, `${e.type} someone else's`).toBe('You can only delete notes you wrote.');
        expect(await notesLeft(theirs), `${e.type} someone else's`).toBe(1);
        expect((await api.delete(route(e, mine))).status, `${e.type} own`).toBe(200);
        expect(await notesLeft(mine), `${e.type} own`).toBe(0);
      }
    });

    it('lets anyone\'s note go with the record\'s Edit, and the note leaves the list', async () => {
      const { org, customer, admin } = await newOrg();
      const job = await fx.addJob(org, customer);
      const lead = await fx.addLead(org, customer);
      const person = await personWith(org, EDITS);
      const api = await person.api();
      for (const e of [{ type: 'JOB', id: job.id }, { type: 'LEAD', id: lead.id }] as Entity[]) {
        const theirs = await addNote(org, e, admin.id);
        expect((await api.delete(route(e, theirs))).status, e.type).toBe(200);
        expect(await notesLeft(theirs), e.type).toBe(0);
        const listed = (await api.get(route(e))).body.notes as Array<{ id: string }>;
        expect(listed.map((n) => n.id), e.type).not.toContain(theirs);
      }
    });

    it('refuses the Edit holder on a record they cannot open, and answers not found for a note that is not on this record', async () => {
      const { org, customer, admin } = await newOrg();
      const elsewhere = await fx.addJob(org, customer);
      const person = await personWith(org, { ...EDITS, jobs_scope: 'attached' });
      const crewJob = await fx.addJob(org, customer, { crew: [person.id] });
      const api = await person.api();
      const hidden = await addNote(org, { type: 'JOB', id: elsewhere.id }, admin.id);
      expect((await api.delete(route({ type: 'JOB', id: elsewhere.id }, hidden))).status).toBe(404);
      expect(await notesLeft(hidden)).toBe(1);

      // A note on one job is not reachable through another job's route, and a missing note is not found.
      const all = await personWith(org, EDITS);
      const other = await all.api();
      const onElsewhere = await addNote(org, { type: 'JOB', id: elsewhere.id }, admin.id);
      expect((await other.delete(route({ type: 'JOB', id: crewJob.id }, onElsewhere))).status).toBe(404);
      expect((await other.delete(route({ type: 'JOB', id: crewJob.id }, randomUUID()))).status).toBe(404);
      expect(await notesLeft(onElsewhere)).toBe(1);
    });

    it('keeps a lead note off the job route and a job note off the lead route', async () => {
      const { org, customer, admin } = await newOrg();
      const job = await fx.addJob(org, customer);
      const lead = await fx.addLead(org, customer);
      const person = await personWith(org, EDITS);
      const api = await person.api();
      const leadNote = await addNote(org, { type: 'LEAD', id: lead.id }, admin.id);
      const jobNote = await addNote(org, { type: 'JOB', id: job.id }, admin.id);
      expect((await api.delete(route({ type: 'JOB', id: job.id }, leadNote))).status).toBe(404);
      expect((await api.delete(route({ type: 'LEAD', id: lead.id }, jobNote))).status).toBe(404);
    });

    it('does not touch the notes of another company', async () => {
      const mine = await newOrg();
      const theirs = await newOrg();
      const theirJob = await fx.addJob(theirs.org, theirs.customer);
      const theirNote = await addNote(theirs.org, { type: 'JOB', id: theirJob.id }, theirs.admin.id);
      const person = await personWith(mine.org, EDITS);
      const res = await (await person.api()).delete(route({ type: 'JOB', id: theirJob.id }, theirNote));
      expect([403, 404]).toContain(res.status);
      expect(await notesLeft(theirNote)).toBe(1);
    });
  });

  describe.each(lockedStatuses)('a %s job', (status) => {
    it('refuses the author deleting their own note with the lock message, whatever else they hold', async () => {
      const { org, customer, admin } = await newOrg();
      const job = await fx.addJob(org, customer, { status });
      const e: Entity = { type: 'JOB', id: job.id };
      const holder = await personWith(org, EDITS);
      const plain = await personWith(org, {});
      for (const [who, person] of [['holder', holder], ['plain', plain]] as const) {
        const api = await person.api();
        const own = await addNote(org, e, person.id);
        const other = await addNote(org, e, admin.id);
        for (const note of [own, other]) {
          const res = await api.delete(route(e, note));
          expect(res.status, `${who} delete`).toBe(403);
          expect(res.body.error, `${who} delete`).toBe(LOCK_MESSAGE);
          expect(await notesLeft(note), `${who} delete`).toBe(1);
        }
      }
    });

    it('lets a Change locked jobs holder delete their own note, and anyone\'s only with the job\'s Edit too', async () => {
      const { org, customer, admin } = await newOrg();
      const job = await fx.addJob(org, customer, { status });
      const e: Entity = { type: 'JOB', id: job.id };
      const keyOnly = await personWith(org, { change_locked_jobs: true });
      const keyApi = await keyOnly.api();
      const mine = await addNote(org, e, keyOnly.id);
      expect((await keyApi.delete(route(e, mine))).status).toBe(200);
      expect(await notesLeft(mine)).toBe(0);

      // The key opens the lock, not the Edit: someone else's note stays out of reach without Edit jobs.
      const theirs = await addNote(org, e, admin.id);
      const refused = await keyApi.delete(route(e, theirs));
      expect(refused.status).toBe(403);
      expect(refused.body.error).toBe('You can only delete notes you wrote.');
      expect(await notesLeft(theirs)).toBe(1);

      const both = await personWith(org, { change_locked_jobs: true, ...EDITS });
      expect((await (await both.api()).delete(route(e, theirs))).status).toBe(200);
      expect(await notesLeft(theirs)).toBe(0);
    });

    it('still takes a new note past the lock, and lets the author delete it again once the job is reopened', async () => {
      const { org, customer } = await newOrg();
      const job = await fx.addJob(org, customer, { status });
      const e: Entity = { type: 'JOB', id: job.id };
      const person = await personWith(org, { add_notes: true });
      const api = await person.api();
      const added = await api.post(route(e), { content: 'added after the lock' });
      expect(added.status).toBe(201);
      const noteId = added.body.note.id as string;
      expect((await api.delete(route(e, noteId))).body.error).toBe(LOCK_MESSAGE);

      await reopen(job.id);
      expect((await api.delete(route(e, noteId))).status).toBe(200);
      expect(await notesLeft(noteId)).toBe(0);
    });
  });

  it('reads the status on every request: a job Completed behind the person\'s back locks its notes on the next call', async () => {
    const { org, customer } = await newOrg();
    const job = await fx.addJob(org, customer, { status: 'IN_PROGRESS' });
    const e: Entity = { type: 'JOB', id: job.id };
    const person = await personWith(org, {});
    const api = await person.api();
    const first = await addNote(org, e, person.id);
    const second = await addNote(org, e, person.id);
    expect((await api.delete(route(e, first))).status).toBe(200);
    await db.job.update({ where: { id: job.id }, data: { status: 'COMPLETED' }, select: { id: true } });
    expect((await api.delete(route(e, second))).body.error).toBe(LOCK_MESSAGE);
  });

  it('never tells anyone the lock of a job they cannot open', async () => {
    const { org, customer, admin } = await newOrg();
    const job = await fx.addJob(org, customer, { status: 'COMPLETED' });
    const note = await addNote(org, { type: 'JOB', id: job.id }, admin.id);
    const person = await personWith(org, { ...EDITS, jobs_scope: 'attached' });
    const res = await (await person.api()).delete(route({ type: 'JOB', id: job.id }, note));
    // A job the person cannot open is refused whatever its lock, and the lock is never told.
    expect(res.status).toBe(404);
    expect(res.body.error).not.toBe(LOCK_MESSAGE);
  });

  describe.each(['WON', 'LOST'] as LeadStatus[])('a %s lead', (status) => {
    it('never takes the job lock and does not stop a note delete: the closed-lead lock covers only the lead\'s contact entries', async () => {
      const { org, customer, admin } = await newOrg();
      const lead = await fx.addLead(org, customer);
      await db.lead.update({ where: { id: lead.id }, data: { status }, select: { id: true } });
      const e: Entity = { type: 'LEAD', id: lead.id };
      const person = await personWith(org, {});
      const mine = await addNote(org, e, person.id);
      expect((await (await person.api()).delete(route(e, mine))).status).toBe(200);
      const holder = await personWith(org, EDITS);
      const theirs = await addNote(org, e, admin.id);
      expect((await (await holder.api()).delete(route(e, theirs))).status).toBe(200);
    });
  });

  describe('the activity entry of a delete', () => {
    type TimelineEntry = {
      event_type: string; description: string; metadata: Record<string, unknown>; created_at: string; creator: { id: string } | null;
    };

    it('keeps the text and names who deleted the note and who wrote it, on a job and on a lead', async () => {
      const { org, customer } = await newOrg();
      const job = await fx.addJob(org, customer);
      const lead = await fx.addLead(org, customer);
      const author = await personWith(org, {}, { name: 'Uma' });
      const deleter = await personWith(org, EDITS, { name: 'Dan' });
      const api = await deleter.api();
      const written = new Map<string, Date>();
      for (const e of [{ type: 'JOB', id: job.id }, { type: 'LEAD', id: lead.id }] as Entity[]) {
        const text = `The gate code is 4417 (${e.type})`;
        const id = await addNote(org, e, author.id, text);
        written.set(e.type, (await db.note.findUniqueOrThrow({ where: { id }, select: { created_at: true } })).created_at);
        expect((await api.delete(route(e, id))).status, e.type).toBe(200);
        expect(await notesLeft(id), e.type).toBe(0);

        const events = (await api.get(`/api/${e.type.toLowerCase()}s/${e.id}/timeline`)).body.events as TimelineEntry[];
        const entry = events.find((ev) => ev.event_type === 'NOTE_DELETED');
        expect(entry, `${e.type} entry`).toBeDefined();
        expect(entry!.description, e.type).toContain(text);
        expect(entry!.description, e.type).toContain('Dan Tester');
        expect(entry!.description, e.type).toContain('Uma Tester');
        expect(entry!.creator?.id, e.type).toBe(deleter.id);
        expect(entry!.metadata, e.type).toMatchObject({
          note_id: id, note_content: text, written_by: author.id, written_by_name: 'Uma Tester',
          deleted_by: deleter.id, deleted_by_name: 'Dan Tester', written_at: written.get(e.type)!.toISOString(),
        });
        expect(new Date(entry!.created_at).getTime()).toBeGreaterThan(written.get(e.type)!.getTime() - 1);
      }
    });

    it('records a delete made through Change locked jobs the same way, and a refused delete writes nothing', async () => {
      const { org, customer } = await newOrg();
      const job = await fx.addJob(org, customer, { status: 'DONE' });
      const e: Entity = { type: 'JOB', id: job.id };
      const author = await personWith(org, {}, { name: 'Uma' });
      const holder = await personWith(org, { change_locked_jobs: true, ...EDITS }, { name: 'Dan' });
      const blocked = await personWith(org, EDITS, { name: 'Bea' });
      const note = await addNote(org, e, author.id, 'Spare key under the mat');
      expect((await (await blocked.api()).delete(route(e, note))).status).toBe(403);
      expect(await db.timelineEvent.count({ where: { entity_id: job.id, event_type: 'NOTE_DELETED' } })).toBe(0);

      const api = await holder.api();
      expect((await api.delete(route(e, note))).status).toBe(200);
      const events = (await api.get(`/api/jobs/${job.id}/timeline`)).body.events as TimelineEntry[];
      const entry = events.find((ev) => ev.event_type === 'NOTE_DELETED')!;
      expect(entry.description).toContain('Spare key under the mat');
      expect(entry.description).toContain('Dan Tester');
      expect(entry.description).toContain('Uma Tester');
    });
  });

  describe('the lists\' per-note answer', () => {
    type Row = Record<string, unknown> & { id: string };
    const rowOf = async (api: Api, e: Entity, note: string, query = '') => {
      const res = await api.get(`${route(e)}${query}`);
      expect(res.status).toBe(200);
      return (res.body.notes as Row[]).find((n) => n.id === note)!;
    };

    it('lets delete show only on the person\'s own notes without the record\'s Edit, and on every note with it', async () => {
      const { org, customer, admin } = await newOrg();
      const job = await fx.addJob(org, customer);
      const lead = await fx.addLead(org, customer);
      const plain = await personWith(org, {});
      const holder = await personWith(org, EDITS);
      for (const e of [{ type: 'JOB', id: job.id }, { type: 'LEAD', id: lead.id }] as Entity[]) {
        const mine = await addNote(org, e, plain.id);
        const theirs = await addNote(org, e, admin.id);
        const asPlain = await plain.api();
        expect(await rowOf(asPlain, e, mine), e.type).toMatchObject({ can_delete: true, locked_actions: [] });
        expect(await rowOf(asPlain, e, theirs), e.type).toMatchObject({ can_delete: false, locked_actions: [] });
        expect(await rowOf(await holder.api(), e, theirs), e.type).toMatchObject({ can_delete: true, locked_actions: [] });
      }
    });

    it('withholds delete on a locked job, names what the lock took only for what the person would otherwise hold, and lifts for the key', async () => {
      const { org, customer, admin } = await newOrg();
      const job = await fx.addJob(org, customer, { status: 'OFFICE_REVIEW' });
      const e: Entity = { type: 'JOB', id: job.id };
      const plain = await personWith(org, {});
      const holder = await personWith(org, EDITS);
      const keyHolder = await personWith(org, { change_locked_jobs: true, ...EDITS });
      const mine = await addNote(org, e, plain.id);
      const theirs = await addNote(org, e, admin.id);

      // Their own note: the lock alone stops them.
      expect(await rowOf(await plain.api(), e, mine)).toMatchObject({ can_delete: false, locked_actions: ['delete'] });
      // Someone else's note without the switch: they would never have held the control, so no disabled one.
      expect(await rowOf(await plain.api(), e, theirs)).toMatchObject({ can_delete: false, locked_actions: [] });
      expect(await rowOf(await holder.api(), e, theirs)).toMatchObject({ can_delete: false, locked_actions: ['delete'] });
      expect(await rowOf(await keyHolder.api(), e, theirs)).toMatchObject({ can_delete: true, locked_actions: [] });
    });

    it('offers no delete on the originating lead\'s notes shown on the job page, locked or not', async () => {
      const { org, customer, admin } = await newOrg();
      const lead = await fx.addLead(org, customer);
      const job = await fx.addJob(org, customer, { fromLead: lead.id });
      const leadNote = await addNote(org, { type: 'LEAD', id: lead.id }, admin.id);
      const person = await personWith(org, EDITS);
      const row = await rowOf(await person.api(), { type: 'JOB', id: job.id }, leadNote, '?include_lead=true');
      expect(row).toMatchObject({ source: 'LEAD', can_delete: false, locked_actions: [] });
      // On the lead page it follows the lead's ordinary rule.
      expect((await (await person.api()).delete(route({ type: 'LEAD', id: lead.id }, leadNote))).status).toBe(200);
    });
  });

  describe('the record\'s Edit decides the notes of other people', () => {
    it('has no Delete-other-people\'s-notes switch any more', () => {
      expect(findSwitch('delete_others_notes')).toBeUndefined();
    });

    it.each([['JOB'], ['LEAD']] as const)('%s: lets the request in with the record\'s Edit and refuses it without', async (type) => {
      const { org, customer, admin } = await newOrg();
      const record = type === 'JOB' ? await fx.addJob(org, customer) : await fx.addLead(org, customer);
      const e: Entity = { type, id: record.id };
      const on = await personWith(org, EDITS);
      const off = await personWith(org, {});
      const note = await addNote(org, e, admin.id);
      const refused = await (await off.api()).delete(route(e, note));
      expect(refused.status).toBe(403);
      expect(await notesLeft(note)).toBe(1);
      expect((await (await on.api()).delete(route(e, note))).status).toBe(200);
    });
  });
});
