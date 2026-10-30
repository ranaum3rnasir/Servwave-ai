/* =============================================================================
   Roles & Permissions, PRD 4, slice S04.24 - deleting and renaming files: a person's own uploads, the
   completed-job lock, and the files on a job's invoices.

   Everything goes through the public interface: the attachment routes (list, rename, delete) and the job's
   timeline, called as people on custom roles (never a built-in role name) holding exactly the switch values
   under test. Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { JobStatus, PrismaClient, Role } from '@prisma/client';

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
import { SWITCH_CATALOG, type SwitchValue } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;

/** Every switch in the catalog off (a choice at its first option, a list empty), so a case turns on exactly the ones it is about. */
const ALL_OFF: Record<string, SwitchValue> = Object.fromEntries(
  SWITCH_CATALOG.map((s) => [s.key, s.kind === 'choice' ? s.choices![0]! : s.kind === 'list' ? [] : false]),
);

/** The wording the PRD gives each refusal (its own text, not read from the code). */
const LOCK_MESSAGE = 'This job is locked. Only someone who can change locked jobs can change it.';
const OWN_ONLY_MESSAGE = 'You can only delete files you uploaded.';

/** What opening a job, a lead, an invoice and a customer takes, with no attachment switch on. */
const OPENING = {
  view_jobs: true, jobs_scope: 'all', view_leads: true, leads_scope: 'all', view_attachments: true,
  view_invoices: true, invoices_scope: 'all', view_customers: true,
};

const lockedStatuses: JobStatus[] = ['COMPLETED', 'OFFICE_REVIEW', 'READY_TO_CLOSE', 'DONE', 'CANCELLED'];

suite('deleting and renaming files (real database)', () => {
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
      for (const table of ['attachments', 'timeline_events']) {
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
    const key = `att-delete-role-${++sequence}`;
    const base = opts.base ?? 'DISPATCHER';
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { ...ALL_OFF, ...OPENING, ...values }, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, opts.name ?? `p${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  type Entity = { type: 'JOB' | 'LEAD' | 'INVOICE' | 'CUSTOMER'; id: string };

  async function addFile(org: string, entity: Entity, uploadedBy: string) {
    const id = randomUUID();
    await db.attachment.create({
      data: {
        id, organization_id: org, entity_type: entity.type, entity_id: entity.id, file_name: `${id}.pdf`,
        file_url: `https://files.example.test/${id}.pdf`, storage_path: `org/${id}.pdf`, file_type: 'application/pdf',
        file_size: 10, display_name: `File ${id.slice(0, 4)}`, uploaded_by: uploadedBy,
      },
    });
    return id;
  }

  const filesLeft = (id: string) => db.attachment.count({ where: { id } });
  const route = (e: Entity, file?: string) => `/api/attachments/${e.type.toLowerCase()}/${e.id}${file ? `/${file}` : ''}`;
  const rename = (api: Api, e: Entity, file: string) => api.patch(route(e, file), { display_name: 'Renamed' });
  const reopen = (jobId: string) => db.job.update({ where: { id: jobId }, data: { status: 'SCHEDULED' }, select: { id: true } });

  describe('a person\'s own uploads (the route-level row for Delete attachments)', () => {
    it('deletes their own file and is refused someone else\'s without the switch, on every kind of record', async () => {
      const { org, customer, admin } = await newOrg();
      const job = await fx.addJob(org, customer);
      const lead = await fx.addLead(org, customer);
      const invoice = await fx.addInvoice(org, customer, { jobId: job.id });
      const entities: Entity[] = [
        { type: 'JOB', id: job.id }, { type: 'LEAD', id: lead.id }, { type: 'INVOICE', id: invoice.id }, { type: 'CUSTOMER', id: customer },
      ];
      const person = await personWith(org, {});
      const api = await person.api();
      for (const e of entities) {
        const mine = await addFile(org, e, person.id);
        const theirs = await addFile(org, e, admin.id);
        const refused = await api.delete(route(e, theirs));
        expect(refused.status, `${e.type} someone else's`).toBe(403);
        expect(refused.body.error, `${e.type} someone else's`).toBe(OWN_ONLY_MESSAGE);
        expect(await filesLeft(theirs), `${e.type} someone else's`).toBe(1);
        expect((await api.delete(route(e, mine))).status, `${e.type} own`).toBe(200);
        expect(await filesLeft(mine), `${e.type} own`).toBe(0);
      }
    });

    it('deletes anyone\'s file with Delete attachments', async () => {
      const { org, customer, admin } = await newOrg();
      const job = await fx.addJob(org, customer);
      const person = await personWith(org, { delete_attachments: true });
      const theirs = await addFile(org, { type: 'JOB', id: job.id }, admin.id);
      expect((await (await person.api()).delete(route({ type: 'JOB', id: job.id }, theirs))).status).toBe(200);
      expect(await filesLeft(theirs)).toBe(0);
    });
  });

  describe.each(lockedStatuses)('a %s job', (status) => {
    it('refuses a file delete and a rename with the lock message, the person\'s own upload included, whatever they hold', async () => {
      const { org, customer, admin } = await newOrg();
      const job = await fx.addJob(org, customer, { status });
      const e: Entity = { type: 'JOB', id: job.id };
      const holder = await personWith(org, { delete_attachments: true, edit_attachments: true });
      const plain = await personWith(org, {});
      for (const [who, person] of [['holder', holder], ['plain', plain]] as const) {
        const api = await person.api();
        const own = await addFile(org, e, person.id);
        const other = await addFile(org, e, admin.id);
        for (const file of [own, other]) {
          const del = await api.delete(route(e, file));
          expect(del.status, `${who} delete`).toBe(403);
          expect(del.body.error, `${who} delete`).toBe(LOCK_MESSAGE);
          expect(await filesLeft(file), `${who} delete`).toBe(1);
        }
        if (who === 'holder') {
          const ren = await rename(api, e, other);
          expect(ren.status, 'rename').toBe(403);
          expect(ren.body.error, 'rename').toBe(LOCK_MESSAGE);
        }
      }
    });

    it('lets a Change locked jobs holder delete and rename, still asking the ordinary switch', async () => {
      const { org, customer, admin } = await newOrg();
      const job = await fx.addJob(org, customer, { status });
      const e: Entity = { type: 'JOB', id: job.id };
      const holder = await personWith(org, { change_locked_jobs: true, delete_attachments: true, edit_attachments: true });
      const api = await holder.api();
      const other = await addFile(org, e, admin.id);
      expect((await rename(api, e, other)).status).toBe(200);
      expect((await api.delete(route(e, other))).status).toBe(200);
      expect(await filesLeft(other)).toBe(0);

      // The key opens the lock, not the switch: without Delete attachments someone else's file stays out of reach.
      const keyOnly = await personWith(org, { change_locked_jobs: true });
      const kept = await addFile(org, e, admin.id);
      const refused = await (await keyOnly.api()).delete(route(e, kept));
      expect(refused.status).toBe(403);
      expect(refused.body.error).toBe(OWN_ONLY_MESSAGE);
      // ...but their own upload goes.
      const mine = await addFile(org, e, keyOnly.id);
      expect((await (await keyOnly.api()).delete(route(e, mine))).status).toBe(200);
    });

    it('refuses a delete and a rename on a file of the job\'s invoice, and allows them again after a reopen', async () => {
      const { org, customer, admin } = await newOrg();
      const job = await fx.addJob(org, customer, { status });
      const invoice = await fx.addInvoice(org, customer, { jobId: job.id });
      const e: Entity = { type: 'INVOICE', id: invoice.id };
      const person = await personWith(org, { delete_attachments: true, edit_attachments: true });
      const api = await person.api();
      const file = await addFile(org, e, admin.id);

      const del = await api.delete(route(e, file));
      expect(del.status).toBe(403);
      expect(del.body.error).toBe(LOCK_MESSAGE);
      const ren = await rename(api, e, file);
      expect(ren.status).toBe(403);
      expect(ren.body.error).toBe(LOCK_MESSAGE);
      expect(await filesLeft(file)).toBe(1);

      await reopen(job.id);
      expect((await rename(api, e, file)).status).toBe(200);
      expect((await api.delete(route(e, file))).status).toBe(200);
      expect(await filesLeft(file)).toBe(0);
    });

    it('still takes a new file upload route past the lock', async () => {
      const { org, customer } = await newOrg();
      const job = await fx.addJob(org, customer, { status });
      const person = await personWith(org, { upload_attachments: true });
      const res = await (await person.api()).post(`/api/attachments/job/${job.id}`, {});
      expect(res.body.error).not.toBe(LOCK_MESSAGE);
    });

    it('does not lock the originating lead\'s own files on the lead page', async () => {
      const { org, customer, admin } = await newOrg();
      const lead = await fx.addLead(org, customer);
      const job = await fx.addJob(org, customer, { status, fromLead: lead.id });
      const leadFile = await addFile(org, { type: 'LEAD', id: lead.id }, admin.id);
      const person = await personWith(org, { delete_attachments: true });
      const api = await person.api();
      // On the job page the file is listed and not changeable from there.
      const listed = (await api.get(`${route({ type: 'JOB', id: job.id })}?include_lead=true`)).body.attachments as Array<Record<string, unknown>>;
      const row = listed.find((a) => a.id === leadFile)!;
      expect(row.source).toBe('LEAD');
      expect(row.can_delete).toBe(false);
      expect(row.can_rename).toBe(false);
      // On the lead page it follows the lead's ordinary rule.
      expect((await api.delete(route({ type: 'LEAD', id: lead.id }, leadFile))).status).toBe(200);
    });
  });

  it('does not lock the files of a job that is still open, or of an invoice with no job', async () => {
    const { org, customer, admin } = await newOrg();
    const open = await fx.addJob(org, customer, { status: 'IN_PROGRESS' });
    const orphanInvoice = await fx.addInvoice(org, customer);
    const person = await personWith(org, { delete_attachments: true });
    const api = await person.api();
    for (const e of [{ type: 'JOB', id: open.id }, { type: 'INVOICE', id: orphanInvoice.id }] as Entity[]) {
      const file = await addFile(org, e, admin.id);
      expect((await api.delete(route(e, file))).status, e.type).toBe(200);
    }
  });

  it('reads the status on every request: a job Completed behind the person\'s back locks its files on the next call', async () => {
    const { org, customer, admin } = await newOrg();
    const job = await fx.addJob(org, customer, { status: 'IN_PROGRESS' });
    const e: Entity = { type: 'JOB', id: job.id };
    const person = await personWith(org, { delete_attachments: true });
    const api = await person.api();
    const first = await addFile(org, e, admin.id);
    const second = await addFile(org, e, admin.id);
    expect((await api.delete(route(e, first))).status).toBe(200);
    await db.job.update({ where: { id: job.id }, data: { status: 'COMPLETED' }, select: { id: true } });
    expect((await api.delete(route(e, second))).body.error).toBe(LOCK_MESSAGE);
  });

  it('locks the files of an invoice for a person who can open the invoice but not its job', async () => {
    const { org, customer, admin } = await newOrg();
    const job = await fx.addJob(org, customer, { status: 'DONE' });
    const invoice = await fx.addInvoice(org, customer, { jobId: job.id });
    const person = await personWith(org, { delete_attachments: true, jobs_scope: 'attached' });
    const e: Entity = { type: 'INVOICE', id: invoice.id };
    const file = await addFile(org, e, admin.id);
    const res = await (await person.api()).delete(route(e, file));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(LOCK_MESSAGE);
    expect(await filesLeft(file)).toBe(1);
  });

  it('never tells anyone the lock of a job they cannot open', async () => {
    const { org, customer, admin } = await newOrg();
    const job = await fx.addJob(org, customer, { status: 'COMPLETED' });
    const file = await addFile(org, { type: 'JOB', id: job.id }, admin.id);
    const person = await personWith(org, { delete_attachments: true, jobs_scope: 'attached' });
    const res = await (await person.api()).delete(route({ type: 'JOB', id: job.id }, file));
    expect(res.status).toBe(403);
    expect(res.body.error).not.toBe(LOCK_MESSAGE);
  });

  describe('the activity entry of a delete', () => {
    it('names who deleted the file and whose upload it was, on the job and on the job\'s invoice', async () => {
      const { org, customer } = await newOrg();
      const job = await fx.addJob(org, customer);
      const invoice = await fx.addInvoice(org, customer, { jobId: job.id });
      const uploader = await personWith(org, {}, { name: 'Uma' });
      const deleter = await personWith(org, { delete_attachments: true, view_invoices: true }, { name: 'Dan' });
      const api = await deleter.api();
      for (const e of [{ type: 'JOB', id: job.id }, { type: 'INVOICE', id: invoice.id }] as Entity[]) {
        const file = await addFile(org, e, uploader.id);
        expect((await api.delete(route(e, file))).status).toBe(200);
      }

      const events = (await api.get(`/api/jobs/${job.id}/timeline`)).body.events as Array<{
        event_type: string; description: string; metadata: Record<string, unknown>; creator: { id: string } | null;
      }>;
      const deletes = events.filter((ev) => ev.event_type === 'ATTACHMENT_DELETED');
      expect(deletes).toHaveLength(2);
      for (const ev of deletes) {
        expect(ev.description).toContain('Dan Tester');
        expect(ev.description).toContain('Uma Tester');
        expect(ev.creator?.id).toBe(deleter.id);
        expect(ev.metadata).toMatchObject({ deleted_by: deleter.id, uploaded_by: uploader.id });
      }
    });

    it('records a delete made through Change locked jobs the same way', async () => {
      const { org, customer } = await newOrg();
      const job = await fx.addJob(org, customer, { status: 'DONE' });
      const uploader = await personWith(org, {}, { name: 'Uma' });
      const holder = await personWith(org, { change_locked_jobs: true, delete_attachments: true }, { name: 'Dan' });
      const file = await addFile(org, { type: 'JOB', id: job.id }, uploader.id);
      const api = await holder.api();
      expect((await api.delete(route({ type: 'JOB', id: job.id }, file))).status).toBe(200);
      const events = (await api.get(`/api/jobs/${job.id}/timeline`)).body.events as Array<{ event_type: string; description: string; metadata: Record<string, unknown> }>;
      const entry = events.find((ev) => ev.event_type === 'ATTACHMENT_DELETED')!;
      expect(entry.description).toContain('Dan Tester');
      expect(entry.description).toContain('Uma Tester');
      // The office review lists a deleted file by the name it was shown under (S06.8).
      expect(entry.metadata.display_name).toBeTruthy();
      expect(entry.description).toContain(String(entry.metadata.display_name));
    });
  });

  describe('the list\'s per-file answer', () => {
    const rowOf = async (api: Api, e: Entity, file: string) => {
      const res = await api.get(route(e));
      expect(res.status).toBe(200);
      return { row: (res.body.attachments as Array<Record<string, unknown>>).find((a) => a.id === file)! };
    };

    it('lets delete show only on the person\'s own files without Delete attachments, and on every file with it', async () => {
      const { org, customer, admin } = await newOrg();
      const job = await fx.addJob(org, customer);
      const e: Entity = { type: 'JOB', id: job.id };
      const plain = await personWith(org, {});
      const holder = await personWith(org, { delete_attachments: true, edit_attachments: true });
      const mine = await addFile(org, e, plain.id);
      const theirs = await addFile(org, e, admin.id);

      const asPlain = await plain.api();
      expect((await rowOf(asPlain, e, mine)).row).toMatchObject({ can_delete: true, can_rename: false, locked_actions: [] });
      expect((await rowOf(asPlain, e, theirs)).row).toMatchObject({ can_delete: false, can_rename: false, locked_actions: [] });
      const asHolder = await holder.api();
      expect((await rowOf(asHolder, e, theirs)).row).toMatchObject({ can_delete: true, can_rename: true, locked_actions: [] });
    });

    it('withholds both on a locked job and names what the lock took, only for what the person would otherwise hold', async () => {
      const { org, customer, admin } = await newOrg();
      const job = await fx.addJob(org, customer, { status: 'OFFICE_REVIEW' });
      const invoice = await fx.addInvoice(org, customer, { jobId: job.id });
      const holder = await personWith(org, { delete_attachments: true, edit_attachments: true });
      const plain = await personWith(org, {});
      const keyHolder = await personWith(org, { change_locked_jobs: true, delete_attachments: true, edit_attachments: true });

      for (const e of [{ type: 'JOB', id: job.id }, { type: 'INVOICE', id: invoice.id }] as Entity[]) {
        const theirs = await addFile(org, e, admin.id);
        const asHolder = await rowOf(await holder.api(), e, theirs);
        expect(asHolder.row, e.type).toMatchObject({ can_delete: false, can_rename: false });
        expect([...(asHolder.row.locked_actions as string[])].sort(), e.type).toEqual(['delete', 'rename']);

        // Someone who would not have held the control anyway is not shown a disabled one.
        const asPlain = await rowOf(await plain.api(), e, theirs);
        expect(asPlain.row, e.type).toMatchObject({ can_delete: false, can_rename: false, locked_actions: [] });

        const asKey = await rowOf(await keyHolder.api(), e, theirs);
        expect(asKey.row, e.type).toMatchObject({ can_delete: true, can_rename: true, locked_actions: [] });
      }
    });

    it('answers the person\'s own file as locked on a locked job, since the lock wins over the own-upload rule', async () => {
      const { org, customer } = await newOrg();
      const job = await fx.addJob(org, customer, { status: 'COMPLETED' });
      const plain = await personWith(org, {});
      const mine = await addFile(org, { type: 'JOB', id: job.id }, plain.id);
      const { row } = await rowOf(await plain.api(), { type: 'JOB', id: job.id }, mine);
      expect(row).toMatchObject({ can_delete: false, can_rename: false, locked_actions: ['delete'] });
    });
  });
});
