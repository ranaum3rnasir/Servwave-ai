/* =============================================================================
   #3104 (B7 follow-up): the lead's general note. The new-lead form's Notes box becomes an ordinary note in the lead's
   Notes list (by the creator, at the creation time, in the lead's own transaction), and the Edit lead form's Notes box
   edits that one note in place, with one history entry per edit. The lead's own `notes` column is never written.

   Through the HTTP API, as people on custom roles, on a real migrated database (TEST_DATABASE_URL); skips when unset.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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
vi.unmock('../lib/numbering');

import { switchFixture } from './permission-switches-fixture';
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';

const suite = realClient ? describe : describe.skip;

type SwitchValue = boolean | string | string[];
const ALL_OFF: Record<string, SwitchValue> = Object.fromEntries(
  SWITCH_CATALOG.map((s) => [s.key, s.kind === 'choice' ? s.choices![0]! : s.kind === 'list' ? [] : false]),
);
const CREATOR = { view_leads: true, leads_scope: 'all', edit_leads: true, create_leads: true };
const EDITOR = { view_leads: true, leads_scope: 'all', edit_leads: true };

type Api = Awaited<ReturnType<ReturnType<typeof switchFixture>['signedInAs']>>;
type ListedNote = {
  id: string; content: string; created_at: string; edited_at: string | null;
  creator: { id: string; first_name: string; last_name: string };
  editor: { id: string; first_name: string; last_name: string } | null;
  source?: string;
};

suite('the lead\'s general note (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);

  const orgs: string[] = [];
  afterAll(async () => {
    // Notes hold their author by a foreign key the fixture's cleanup does not clear: remove them first.
    for (const org of orgs) await db.$executeRawUnsafe(`DELETE FROM notes WHERE organization_id = '${org}'`).catch(() => undefined);
    await fx.cleanup();
  });

  let sequence = 0;
  async function newOrg() {
    const made = await fx.newOrg();
    orgs.push(made.org);
    return made;
  }
  async function person(org: string, values: Record<string, SwitchValue>, name?: [string, string]) {
    const key = `general-note-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, 'DISPATCHER');
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { ...ALL_OFF, ...values }, actorId: null, reason: 'manual' });
    const p = await fx.addUser(org, `gn${sequence}`, 'DISPATCHER', { customRoleId: role.id });
    if (name) await db.user.update({ where: { id: p.id }, data: { first_name: name[0], last_name: name[1] } });
    return p;
  }

  const notesOf = async (api: Api, leadId: string) => (await api.get(`/api/leads/${leadId}/notes`)).body.notes as ListedNote[];
  const noteEvents = (leadId: string) =>
    db.timelineEvent.findMany({
      where: { entity_type: 'LEAD', entity_id: leadId, event_type: { in: ['NOTE_EDITED', 'NOTE_DELETED'] } },
      orderBy: { created_at: 'asc' },
    });
  const columnOf = async (leadId: string) => (await db.lead.findUniqueOrThrow({ where: { id: leadId }, select: { notes: true } })).notes;

  it('Dana writes it on the new-lead form; Morgan fixes one word from Edit lead; the job shows it From Lead', async () => {
    const { org, customer, admin } = await newOrg();
    const dana = await person(org, CREATOR, ['Dana', 'Ruiz']);
    const morgan = await person(org, EDITOR, ['Morgan', 'Diaz']);
    const asDana = await fx.signedInAs(dana);

    const created = await asDana.post('/api/leads', { customer_id: customer, service_request: 'Garage door won\'t close', notes: 'Customer prefers mornings.' });
    expect(created.status).toBe(201);
    const leadId = created.body.lead.id as string;
    const leadRow = await db.lead.findUniqueOrThrow({ where: { id: leadId }, select: { created_at: true, notes: true } });

    // The first entry of Notes (N): by the creator, at the lead's creation time. The lead's own column is not written.
    const [first, ...others] = await notesOf(asDana, leadId);
    expect(others).toEqual([]);
    expect(first).toMatchObject({ content: 'Customer prefers mornings.', creator: { id: dana.id, first_name: 'Dana', last_name: 'Ruiz' }, edited_at: null, editor: null });
    expect(new Date(first!.created_at).getTime()).toBe(leadRow.created_at.getTime());
    expect(leadRow.notes).toBeNull();

    // The Edit lead form opens with the general note's text.
    const asMorgan = await fx.signedInAs(morgan);
    expect((await asMorgan.get(`/api/leads/${leadId}`)).body.lead.general_note).toEqual({ id: first!.id, content: 'Customer prefers mornings.' });

    // Morgan changes the word and saves: the same note, its author and time kept, now marked edited by Morgan.
    const saved = await asMorgan.patch(`/api/leads/${leadId}`, { service_request: 'Garage door won\'t close', notes: 'Customer prefers afternoons.' });
    expect(saved.status).toBe(200);
    const [edited, ...stillNoOthers] = await notesOf(asMorgan, leadId);
    expect(stillNoOthers).toEqual([]);
    expect(edited).toMatchObject({
      id: first!.id, content: 'Customer prefers afternoons.', created_at: first!.created_at,
      creator: { id: dana.id }, editor: { id: morgan.id, first_name: 'Morgan', last_name: 'Diaz' },
    });
    expect(edited!.edited_at).not.toBeNull();

    // One history entry: who, and the text before and after.
    const events = await noteEvents(leadId);
    expect(events.map((e) => [e.event_type, e.created_by, e.metadata])).toEqual([
      ['NOTE_EDITED', morgan.id, expect.objectContaining({ note_id: first!.id, from: 'Customer prefers mornings.', to: 'Customer prefers afternoons.', edited_by_name: 'Morgan Diaz' })],
    ]);
    // The lead's timeline route answers it too (the Activity panel's source).
    const timeline = (await asMorgan.get(`/api/leads/${leadId}/timeline`)).body.events as Array<{ event_type: string; creator: { id: string } | null }>;
    expect(timeline.filter((e) => e.event_type === 'NOTE_EDITED').map((e) => e.creator?.id)).toEqual([morgan.id]);

    // Saving again without a change writes nothing.
    const again = await asMorgan.patch(`/api/leads/${leadId}`, { service_request: 'Garage door won\'t close', notes: 'Customer prefers afternoons.' });
    expect(again.status).toBe(200);
    expect(await noteEvents(leadId)).toHaveLength(1);
    expect((await notesOf(asMorgan, leadId))[0]!.edited_at).toBe(edited!.edited_at);
    expect(await columnOf(leadId)).toBeNull();

    // The job made from the lead lists it, marked as the lead's, edit marks included.
    const job = await fx.addJob(org, customer, { fromLead: leadId });
    const asAdmin = await fx.signedInAs(admin);
    const jobNotes = (await asAdmin.get(`/api/jobs/${job.id}/notes?include_lead=true`)).body.notes as ListedNote[];
    expect(jobNotes.filter((n) => n.source === 'LEAD')).toEqual([
      expect.objectContaining({ id: first!.id, content: 'Customer prefers afternoons.', editor: expect.objectContaining({ id: morgan.id }), edited_at: edited!.edited_at }),
    ]);
  });

  // Every writer of the lead's own `notes` column, and what each must do instead. One row per way in.
  const writers: Array<[string, (api: Api, ctx: { customer: string; leadId: string }) => Promise<{ status: number; leadId: string }>]> = [
    ['create, existing customer', async (api, { customer }) => {
      const res = await api.post('/api/leads', { customer_id: customer, service_request: 'Fix the door', notes: 'Gate code 4411' });
      return { status: res.status, leadId: res.body.lead?.id };
    }],
    ['create, new customer', async (api) => {
      const res = await api.post('/api/leads', {
        new_customer: { first_name: 'Morgan', last_name: 'Diaz', phone: `+1617555${String(1000 + ++sequence).slice(-4)}` },
        service_request: 'Fix the door', notes: 'Gate code 4411',
      });
      return { status: res.status, leadId: res.body.lead?.id };
    }],
    ['update (Edit lead)', async (api, { leadId }) => {
      const res = await api.patch(`/api/leads/${leadId}`, { notes: 'Gate code 4411' });
      return { status: res.status, leadId };
    }],
  ];

  it.each(writers)('%s: writes the general note, never the lead\'s own notes column', async (_way, write) => {
    const { org, customer } = await newOrg();
    const me = await person(org, { ...CREATOR, create_customers: true, view_customers: true, edit_customers: true });
    const existing = await fx.addLead(org, customer);
    const api = await fx.signedInAs(me);

    const { status, leadId } = await write(api, { customer, leadId: existing.id });
    expect([200, 201]).toContain(status);
    expect(await columnOf(leadId)).toBeNull();
    const general = await db.note.findMany({ where: { entity_type: 'LEAD', entity_id: leadId, is_general: true }, select: { content: true, created_by: true } });
    expect(general).toEqual([{ content: 'Gate code 4411', created_by: me.id }]);
  });

  it.each([['an empty box', ''], ['a box of blanks', '   \n '], ['no notes field', undefined]])(
    'creating a lead with %s writes no note', async (_name, notes) => {
      const { org, customer } = await newOrg();
      const api = await fx.signedInAs(await person(org, CREATOR));
      const res = await api.post('/api/leads', { customer_id: customer, service_request: 'Fix the door', ...(notes === undefined ? {} : { notes }) });
      expect(res.status).toBe(201);
      expect(await db.note.count({ where: { entity_type: 'LEAD', entity_id: res.body.lead.id } })).toBe(0);
    },
  );

  // Ran's build ruling 3 (#3104): the typed text is saved for a creator who holds Add notes or Edit leads at all, even when
  // their Leads scope does not reach the lead afterwards, or reaches it only through the walkthrough booked with it.
  const unreachedCreators: Array<[string, Record<string, SwitchValue>, (me: string) => object, number]> = [
    ['whose scope does not reach the lead (Attached, nobody named)', {}, () => ({}), 404],
    [
      'who reaches the lead only through the walkthrough booked with it',
      { book_walkthroughs: true, can_be_on_crew: true },
      (me) => ({ walkthrough_performer_ids: [me] }),
      201,
    ],
  ];
  it.each(unreachedCreators)('a creator %s still gets the typed text as the general note, by them', async (_who, extra, booking, noteDoor) => {
    const { org, customer } = await newOrg();
    const me = await person(org, { ...CREATOR, leads_scope: 'attached', assign_people_to_leads: true, ...extra }, ['Dana', 'Ruiz']);
    const api = await fx.signedInAs(me);

    const res = await api.post('/api/leads', {
      customer_id: customer, service_request: 'Fix the door', notes: 'Gate code 4411', assigned_to: null, dispatcher_id: null, ...booking(me.id),
    });
    expect(res.status).toBe(201);
    const leadId = res.body.lead.id as string;
    const lead = await db.lead.findUniqueOrThrow({ where: { id: leadId }, select: { created_at: true, notes: true } });
    const notes = await db.note.findMany({ where: { entity_type: 'LEAD', entity_id: leadId }, select: { content: true, created_by: true, created_at: true, is_general: true } });
    expect(notes).toEqual([{ content: 'Gate code 4411', created_by: me.id, created_at: lead.created_at, is_general: true }]);
    expect(lead.notes).toBeNull();
    // What the Notes tab's own door answers this person afterwards: out of reach (404), or in reach through the crew (201).
    expect((await api.post(`/api/leads/${leadId}/notes`, { content: 'Second note' })).status).toBe(noteDoor);
  });

  it('parallel Edit-lead saves on leads with no general note: no failed save, one general note each, every Before exact', async () => {
    const { org, customer } = await newOrg();
    const editors = [await person(org, EDITOR, ['Morgan', 'Diaz']), await person(org, EDITOR, ['Dana', 'Ruiz'])];
    const apis = await Promise.all(editors.map((e) => fx.signedInAs(e)));
    const leads = await Promise.all([1, 2, 3, 4].map(() => fx.addLead(org, customer)));
    const texts = (leadNo: number) => [1, 2, 3, 4, 5, 6].map((n) => `Lead ${leadNo} text ${n}`);

    // 24 saves at once: 6 per lead, from two people.
    const saves = leads.flatMap((lead, i) => texts(i).map((text, n) => apis[n % 2]!.patch(`/api/leads/${lead.id}`, { notes: text })));
    const statuses = (await Promise.all(saves)).map((r) => r.status);
    expect(statuses.filter((s) => s !== 200)).toEqual([]);

    for (const [i, lead] of leads.entries()) {
      const sent = texts(i);
      const general = await db.note.findMany({ where: { entity_type: 'LEAD', entity_id: lead.id, is_general: true }, select: { content: true } });
      expect(general).toHaveLength(1);
      const final = general[0]!.content;
      const edits = (await noteEvents(lead.id)).map((e) => e.metadata as { from: string; to: string });
      // One save wrote the note, the five others each replaced the text the one before left: every Before is a text that
      // was really there and is replaced once, every After is one save's text, and the last After is what is stored.
      expect(edits).toHaveLength(5);
      const froms = edits.map((e) => e.from).sort();
      const tos = edits.map((e) => e.to).sort();
      expect(froms).toEqual(sent.filter((t) => t !== final).sort());
      const created = sent.find((t) => !tos.includes(t))!;
      expect(tos).toEqual(sent.filter((t) => t !== created).sort());
    }
  }, 60_000);

  it('an Edit-lead save without the Notes box leaves the general note as another person left it, and writes no history', async () => {
    // Ran's build ruling 4: the form sends `notes` only when its box was changed. A save without it changes the lead only.
    const { org, customer, admin } = await newOrg();
    const asMorgan = await fx.signedInAs(await person(org, EDITOR, ['Morgan', 'Diaz']));
    const asDana = await fx.signedInAs(await person(org, EDITOR, ['Dana', 'Ruiz']));
    for (const meanwhile of ['edited', 'removed and written again'] as const) {
      const lead = await fx.addLead(org, customer);
      await db.note.create({ data: { organization_id: org, entity_type: 'LEAD', entity_id: lead.id, content: 'Customer prefers mornings.', created_by: admin.id, is_general: true } });
      // Dana opens the form; meanwhile Morgan changes the note.
      if (meanwhile === 'edited') {
        expect((await asMorgan.patch(`/api/leads/${lead.id}`, { notes: 'Customer prefers afternoons.' })).status).toBe(200);
      } else {
        expect((await asMorgan.patch(`/api/leads/${lead.id}`, { notes: '' })).status).toBe(200);
        expect((await asMorgan.patch(`/api/leads/${lead.id}`, { notes: 'Customer prefers afternoons.' })).status).toBe(200);
      }
      const before = await db.note.findMany({ where: { entity_type: 'LEAD', entity_id: lead.id }, orderBy: { id: 'asc' } });
      const historyBefore = (await noteEvents(lead.id)).length;

      // Dana saves her form without touching the box.
      expect((await asDana.patch(`/api/leads/${lead.id}`, { service_request: 'Garage door won\'t close' })).status).toBe(200);

      expect(await db.note.findMany({ where: { entity_type: 'LEAD', entity_id: lead.id }, orderBy: { id: 'asc' } })).toEqual(before);
      expect(await noteEvents(lead.id)).toHaveLength(historyBefore);
      expect((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).service_request).toBe('Garage door won\'t close');
    }
  });

  it('a save of status and notes does not deadlock with a booking that inserted a visit and then locks the lead', async () => {
    const { org, customer, admin } = await newOrg();
    const asAdmin = await fx.signedInAs(admin);
    const lead = await fx.addLead(org, customer);
    let save: Awaited<ReturnType<typeof asAdmin.patch>> | undefined;
    // The other writer: the key-share lock a visit insert takes on its lead, then the lead lock the walkthrough status sync
    // takes (FOR NO KEY UPDATE), with the save in between.
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM leads WHERE id = ${lead.id}::uuid FOR KEY SHARE`;
      const holder = (await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`)[0]!.pid;
      const saving = asAdmin.patch(`/api/leads/${lead.id}`, { status: 'CONTACTED', notes: 'Customer prefers mornings.' }).then((r) => { save = r; });
      // Until the save is either waiting on this transaction or done.
      for (const until = Date.now() + 20_000; !save && Date.now() < until; ) {
        const [{ n }] = await db.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${holder}::int = ANY(pg_blocking_pids(pid))`;
        if (n > 0) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      await tx.$queryRaw`SELECT id FROM leads WHERE id = ${lead.id}::uuid FOR NO KEY UPDATE`;
      void saving;
    }, { timeout: 30_000, maxWait: 10_000 });
    for (const until = Date.now() + 20_000; !save && Date.now() < until; ) await new Promise((r) => setTimeout(r, 25));

    expect(save?.status).toBe(200);
    expect(await db.note.count({ where: { entity_type: 'LEAD', entity_id: lead.id, is_general: true } })).toBe(1);
  }, 60_000);

  it('an Edit-lead save racing a delete from the Notes tab never fails, and never leaves two general notes', async () => {
    const { org, customer, admin } = await newOrg();
    const asMorgan = await fx.signedInAs(await person(org, EDITOR, ['Morgan', 'Diaz']));
    const asAdmin = await fx.signedInAs(admin);
    for (let round = 1; round <= 8; round++) {
      const lead = await fx.addLead(org, customer);
      const note = await db.note.create({ data: { organization_id: org, entity_type: 'LEAD', entity_id: lead.id, content: 'Customer prefers mornings.', created_by: admin.id, is_general: true } });
      const [save, del] = await Promise.all([
        asMorgan.patch(`/api/leads/${lead.id}`, { notes: `Round ${round}: afternoons.` }),
        asAdmin.delete(`/api/leads/${lead.id}/notes/${note.id}`),
      ]);
      expect(save.status).toBe(200);
      expect([200, 404]).toContain(del.status);
      const general = await db.note.findMany({ where: { entity_type: 'LEAD', entity_id: lead.id, is_general: true }, select: { content: true } });
      expect(general.length).toBeLessThanOrEqual(1);
      // Kept, it holds the save's text; an edit entry, if any, replaced the text that was really there.
      for (const g of general) expect(g.content).toBe(`Round ${round}: afternoons.`);
      for (const e of await noteEvents(lead.id)) {
        if (e.event_type === 'NOTE_EDITED') expect(e.metadata).toMatchObject({ from: 'Customer prefers mornings.', to: `Round ${round}: afternoons.` });
      }
    }
  }, 60_000);

  it('a lead that is not created leaves no note behind', async () => {
    const { org, customer } = await newOrg();
    const me = await person(org, { ...CREATOR, book_walkthroughs: true, can_be_on_crew: true });
    const api = await fx.signedInAs(me);
    // The walkthrough the request books is written after the lead and its note, in the same transaction; refuse that
    // write so the transaction fails after the note was written.
    const fn = `refuse_visit_${org.slice(0, 8)}`;
    await db.$executeRawUnsafe(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.organization_id = '${org}'::uuid THEN RAISE EXCEPTION 'refused for the test'; END IF; RETURN NEW; END $$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER ${fn} BEFORE INSERT ON visits FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
    try {
      const res = await api.post('/api/leads', { customer_id: customer, service_request: 'Fix the door', notes: 'Gate code 4411', walkthrough_performer_ids: [me.id] });
      expect(res.status).toBe(500);
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${fn} ON visits`);
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${fn}()`);
    }
    expect(await db.lead.count({ where: { organization_id: org } })).toBe(0);
    expect(await db.note.count({ where: { organization_id: org } })).toBe(0);
  });

  it('emptying the Edit form\'s box removes the general note and records the removal with its text', async () => {
    const { org, customer } = await newOrg();
    const dana = await person(org, CREATOR, ['Dana', 'Ruiz']);
    const morgan = await person(org, EDITOR, ['Morgan', 'Diaz']);
    const created = await (await fx.signedInAs(dana)).post('/api/leads', { customer_id: customer, service_request: 'Fix the door', notes: 'Customer prefers mornings.' });
    const leadId = created.body.lead.id as string;
    const asMorgan = await fx.signedInAs(morgan);

    expect((await asMorgan.patch(`/api/leads/${leadId}`, { notes: '' })).status).toBe(200);
    expect(await db.note.count({ where: { entity_type: 'LEAD', entity_id: leadId } })).toBe(0);
    expect((await asMorgan.get(`/api/leads/${leadId}`)).body.lead.general_note).toBeNull();
    const events = await noteEvents(leadId);
    expect(events.map((e) => [e.event_type, e.created_by])).toEqual([['NOTE_DELETED', morgan.id]]);
    expect(events[0]!.metadata).toMatchObject({ note_content: 'Customer prefers mornings.', written_by: dana.id, deleted_by: morgan.id });

    // A second empty save has nothing to remove and records nothing.
    expect((await asMorgan.patch(`/api/leads/${leadId}`, { notes: null })).status).toBe(200);
    expect(await noteEvents(leadId)).toHaveLength(1);
    expect(await columnOf(leadId)).toBeNull();
  });

  it('after the general note is deleted from the Notes tab, the box is empty and typing in it writes a new general note', async () => {
    const { org, customer } = await newOrg();
    const dana = await person(org, CREATOR, ['Dana', 'Ruiz']);
    const morgan = await person(org, EDITOR, ['Morgan', 'Diaz']);
    const asDana = await fx.signedInAs(dana);
    const leadId = (await asDana.post('/api/leads', { customer_id: customer, service_request: 'Fix the door', notes: 'Customer prefers mornings.' })).body.lead.id as string;
    const [general] = await notesOf(asDana, leadId);
    expect((await asDana.delete(`/api/leads/${leadId}/notes/${general!.id}`)).status).toBe(200);

    const asMorgan = await fx.signedInAs(morgan);
    expect((await asMorgan.get(`/api/leads/${leadId}`)).body.lead.general_note).toBeNull();
    expect((await asMorgan.patch(`/api/leads/${leadId}`, { notes: 'Customer prefers afternoons.' })).status).toBe(200);

    const listed = await notesOf(asMorgan, leadId);
    expect(listed).toEqual([expect.objectContaining({ content: 'Customer prefers afternoons.', creator: expect.objectContaining({ id: morgan.id }), edited_at: null })]);
    expect((await asMorgan.get(`/api/leads/${leadId}`)).body.lead.general_note).toEqual({ id: listed[0]!.id, content: 'Customer prefers afternoons.' });
    // A new note shows itself; no "edited" entry is written for it.
    expect((await noteEvents(leadId)).map((e) => e.event_type)).toEqual(['NOTE_DELETED']);
  });

  it('only the general note is edited: another note on the lead is left exactly as it was, and no route edits a note', async () => {
    const { org, customer, admin } = await newOrg();
    const morgan = await person(org, EDITOR, ['Morgan', 'Diaz']);
    const lead = await fx.addLead(org, customer);
    const other = await db.note.create({ data: { organization_id: org, entity_type: 'LEAD', entity_id: lead.id, content: 'Dog in the yard', created_by: admin.id } });
    const asMorgan = await fx.signedInAs(morgan);

    expect((await asMorgan.patch(`/api/leads/${lead.id}`, { notes: 'Customer prefers afternoons.' })).status).toBe(200);
    const kept = await db.note.findUniqueOrThrow({ where: { id: other.id } });
    expect(kept).toMatchObject({ content: 'Dog in the yard', is_general: null, edited_at: null, edited_by: null });
    expect(await db.note.count({ where: { entity_type: 'LEAD', entity_id: lead.id, is_general: true } })).toBe(1);

    // Every other note stays add-and-delete: no route takes an edit to a note by its id.
    for (const call of [asMorgan.patch(`/api/leads/${lead.id}/notes/${other.id}`, { content: 'x' }), asMorgan.put(`/api/leads/${lead.id}/notes/${other.id}`, { content: 'x' })]) {
      expect((await call).status).toBe(404);
    }
    expect((await db.note.findUniqueOrThrow({ where: { id: other.id } })).content).toBe('Dog in the yard');
  });

  it('a person who cannot open the lead reads and writes nothing, on every route', async () => {
    const { org, customer, admin } = await newOrg();
    const lead = await fx.addLead(org, customer);
    await db.note.create({ data: { organization_id: org, entity_type: 'LEAD', entity_id: lead.id, content: 'secret text', created_by: admin.id, is_general: true } });
    const api = await fx.signedInAs(await person(org, { ...EDITOR, add_notes: true, leads_scope: 'attached' }));

    const responses = [
      await api.get(`/api/leads/${lead.id}`),
      await api.get(`/api/leads/${lead.id}/notes`),
      await api.get(`/api/leads/${lead.id}/timeline`),
      await api.patch(`/api/leads/${lead.id}`, { notes: 'overwritten' }),
      await api.patch(`/api/leads/${lead.id}`, { notes: '' }),
    ];
    for (const res of responses) {
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain('secret text');
    }
    const kept = await db.note.findMany({ where: { entity_type: 'LEAD', entity_id: lead.id }, select: { content: true, edited_at: true } });
    expect(kept).toEqual([{ content: 'secret text', edited_at: null }]);
    expect(await noteEvents(lead.id)).toEqual([]);
  });

  it('editing the general note needs Edit leads: Add notes alone cannot', async () => {
    const { org, customer, admin } = await newOrg();
    const lead = await fx.addLead(org, customer);
    await db.note.create({ data: { organization_id: org, entity_type: 'LEAD', entity_id: lead.id, content: 'Customer prefers mornings.', created_by: admin.id, is_general: true } });
    const api = await fx.signedInAs(await person(org, { view_leads: true, leads_scope: 'all', add_notes: true }));

    expect((await api.patch(`/api/leads/${lead.id}`, { notes: 'Customer prefers afternoons.' })).status).toBe(403);
    expect((await db.note.findFirstOrThrow({ where: { entity_id: lead.id } })).content).toBe('Customer prefers mornings.');
    expect(await noteEvents(lead.id)).toEqual([]);
  });
});
