/* =============================================================================
   Roles & Permissions, PRD 10, slice S10.17 - received HTML is cleaned and received attachments are stored.

   Every case goes through the REAL delivery webhook route (POST /api/webhooks/resend) with a signed fixture event and reads the
   REAL routes afterwards. Only the two calls that reach the mail provider (the received message's attachment list and one
   attachment's bytes) and the message fetch are replaced, and the storage client is the suite's mock at its boundary, so
   nothing is sent, received or uploaded from this machine.

   What is proved, each against the real tables:
     - a received message with script, event-handler attributes and hostile links is stored cleaned, on the mailbox path AND the
       reply-token path, by the very cleaner the compose path uses;
     - a customer's photo on a received message is stored the way a compose attachment is (same bucket, same path shape, same
       type and size limits), linked to the received email, and opens from the conversation for the people who can read it and
       is refused, at the route, to a person who cannot (by mailbox rule, by scope, by record reach, by section access);
     - a redelivered event stores no second copy; mail the router drops fetches nothing;
     - an attachment that fails to arrive is recorded, the message still shows, and the retry stores it once;
     - with the Email plan feature off the attachment is stored and its link answers 402;
     - what a message costs on the hosted database's ONE-connection pool, with 0, 1 and 5 attachments.

   People are on custom roles (never a built-in role name) holding exactly the switch values under test. Real migrated database
   (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed.
   ========================================================================== */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { createHmac, randomBytes, randomUUID } from 'crypto';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';

const { clientPromise, fetchReceived, listAttachments, downloadAttachment, queries } = vi.hoisted(() => {
  const queries: string[] = [];
  const clientPromise = (async () => {
    const dbUrl = process.env.TEST_DATABASE_URL;
    if (!dbUrl) return undefined;
    const { PrismaClient } = await import('@prisma/client');
    // The hosted database's pool: ONE connection and a short wait, so a query on the global client made inside the
    // webhook's transaction fails here in seconds instead of on the hosted database.
    const pooled = new URL(dbUrl);
    pooled.searchParams.set('connection_limit', '1');
    pooled.searchParams.set('pool_timeout', '4');
    const client = new PrismaClient({ datasources: { db: { url: pooled.toString() } }, log: [{ emit: 'event', level: 'query' }] });
    (client as unknown as { $on(e: 'query', cb: (q: { query: string }) => void): void }).$on('query', (q) => queries.push(q.query));
    return client;
  })();
  return { clientPromise, fetchReceived: vi.fn(), listAttachments: vi.fn(), downloadAttachment: vi.fn(), queries };
});

// The suite-wide setup mocks the app's client; here it is the real one, on the hosted pool.
vi.mock('../lib/prisma', async () => ({ prisma: await clientPromise }));

// The provider calls are the only things replaced: the received message, its attachment list and one attachment's bytes.
vi.mock('../lib/inbound-email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/inbound-email')>()),
  fetchReceivedEmail: fetchReceived,
  listReceivedAttachments: listAttachments,
  downloadReceivedAttachment: downloadAttachment,
}));

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';
import { clearTokenCache } from '../middleware/authenticate';
import { sanitizeEmailHtml } from '../lib/email-html';
import { supabaseAdmin } from '../lib/supabase';
import { ATTACHMENTS_BUCKET } from '../lib/attachment-access';
import { env } from '../config/env';
import { clearAllSwitchCaches } from '../lib/permissions/switches/cache';

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const SECRET_BYTES = randomBytes(24);
const WEBHOOK_SECRET = `whsec_${SECRET_BYTES.toString('base64')}`;
const MAILBOX_DOMAIN = 'mail.test.com';
const ARRIVED = new Date('2026-07-01T15:00:00.000Z');
const EVENT_PREFIX = 'rp-s10-17-';

const HOSTILE_HTML =
  '<p onclick="steal()">Hello there</p><script>alert(1)</script>' +
  '<a href="javascript:alert(2)">click me</a><img src="https://example.com/a.png" onerror="alert(3)">' +
  '<iframe src="https://evil.example.com"></iframe>';

suite('received mail: cleaned HTML and stored attachments (real database, real webhook route)', () => {
  let db: PrismaClient;
  let fx: ReturnType<typeof switchFixture>;
  let app: Parameters<typeof request>[0];

  beforeAll(async () => {
    db = (await clientPromise) as PrismaClient;
    app = (await import('../app.js')).default as never;
    fx = switchFixture(db, async () => app);
    // The webhook reads its secret from the environment object at request time.
    (env as { RESEND_WEBHOOK_SECRET?: string }).RESEND_WEBHOOK_SECRET = WEBHOOK_SECRET;
  }, 120_000);

  const orgs: string[] = [];
  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM notifications WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM email_attachments WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM email_read_states WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM emails WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM reply_tokens WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM email_threads WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM mailbox_readers WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM mailbox_addresses WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM mailboxes WHERE organization_id = '${org}'`));
    }
    await quietly(db.$executeRawUnsafe(`DELETE FROM resend_events WHERE resend_event_id LIKE '${EVENT_PREFIX}%'`));
    await fx.cleanup();
  });

  beforeEach(() => {
    fetchReceived.mockReset();
    listAttachments.mockReset();
    downloadAttachment.mockReset();
  });

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  type Who = Person & { api: () => Promise<Api> };
  let sequence = 0;

  /** Every switch that needs one of these goes off with it, so the set stays storable. */
  const withDependantsOff = (off: string[]): Record<string, boolean> => {
    const out: Record<string, boolean> = Object.fromEntries(off.map((k) => [k, false]));
    for (let grew = true; grew; ) {
      grew = false;
      for (const s of SWITCH_CATALOG) {
        if (!(s.key in out) && s.requires.some((r) => out[r] === false)) { out[s.key] = false; grew = true; }
      }
    }
    return out;
  };

  /** A person on a fresh custom role holding exactly these switch values. */
  async function personWith(org: string, scope: 'all' | 'attached', extra: Record<string, boolean | string> = {}): Promise<Who> {
    const key = `rc-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, 'DISPATCHER');
    await setRoleSwitchValues({
      organizationId: org, roleKey: key,
      values: {
        view_jobs: true, jobs_scope: 'attached', view_leads: true, leads_scope: 'attached', view_customers: true,
        view_estimates: true, view_invoices: true,
        access_communication: true, show_email: true, view_communication: true, communication_scope: scope, ...extra,
      },
      actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(org, `p${sequence}`, 'DISPATCHER', { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  /**
   * A company with its main mailbox and main address; a holder with a mailbox and address of their own; a person who reads
   * every mailbox; a person with a mailbox of their own who is nobody to this mail; and a customer with an estimate
   * conversation open on a job (a reply token the customer can answer on).
   */
  async function world() {
    const made = await fx.newOrg();
    orgs.push(made.org);
    const { org, tag, customer, admin } = made;

    const main = randomUUID();
    await db.mailbox.create({ data: { id: main, organization_id: org, kind: 'main', status: 'active' } });
    await db.mailboxAddress.create({ data: { local_part: `main-${tag}`, organization_id: org, mailbox_id: main, is_primary: true } });
    const holder = await personWith(org, 'attached');
    const holderBox = await fx.addUserMailbox(org, holder);
    const outsider = await personWith(org, 'attached');
    await fx.addUserMailbox(org, outsider);
    const wide = await personWith(org, 'all');
    // Holds every reading switch there is except the section itself.
    const noSection = await personWith(org, 'all', withDependantsOff(['access_communication']));

    const customerEmail = `pat-${tag}@example.com`;
    await db.customer.update({ where: { id: customer }, data: { email: customerEmail } });
    const job = await fx.addJob(org, customer, { crew: [holder.id] });
    const estimate = await fx.addEstimate(org, customer, admin.id, { jobId: job.id });
    const openThread = randomUUID();
    await db.emailThread.create({
      data: { id: openThread, organization_id: org, mailbox_id: main, origin: 'record', record_type: 'estimate', record_id: estimate.id },
    });
    const replyToken = randomBytes(16).toString('base64url');
    await db.replyToken.create({
      data: {
        token: replyToken, organization_id: org, thread_id: openThread, entity_type: 'estimate', entity_id: estimate.id,
        customer_id: customer, expected_from: customerEmail,
      },
    });

    return {
      org, tag, customer, admin: Object.assign(admin, { api: () => fx.signedInAs(admin) }) as Who, job, holder, holderBox, outsider, wide, noSection,
      main, openThread, replyToken, customerEmail,
      userAddress: `${holder.email.split('@')[0]!.toLowerCase()}@${MAILBOX_DOMAIN}`,
      mainAddress: `main-${tag}@${MAILBOX_DOMAIN}`,
      replyAddress: `${replyToken}@reply.test.com`,
    };
  }
  type World = Awaited<ReturnType<typeof world>>;

  /** The standard signature a delivery webhook carries: HMAC-SHA256 of `id.timestamp.body` under the shared secret. */
  const signed = (svixId: string, body: string) => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', SECRET_BYTES).update(`${svixId}.${timestamp}.${body}`).digest('base64');
    return { 'svix-id': svixId, 'svix-timestamp': timestamp, 'svix-signature': `v1,${signature}` };
  };

  interface File {
    id?: string;
    name?: string | null;
    type?: string;
    /** What the provider says it weighs; defaults to the bytes' length. */
    size?: number;
    bytes?: Buffer;
  }
  interface Delivery {
    to: string[];
    from?: string;
    subject?: string;
    html?: string;
    files?: File[];
    /** Repeat a delivery: the same provider event id (and so the same received message). */
    again?: { eventId: string; providerId: string };
    /** The provider cannot list the message's attachments at all (once), or cannot hand over these files' bytes. */
    listFails?: boolean;
    downloadFails?: number[];
  }

  // The smallest bytes the content check accepts as each type.
  const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('customer photo of the front door')]);

  type Provided = { id: string; filename: string | null; content_type: string; size: number; bytes: Buffer };

  /** What the provider answers for the attachments: the list, and each file's bytes. A failure is the provider being unreachable. */
  function provide(files: Provided[], failures: { listFails?: boolean; downloadFails?: number[] } = {}) {
    listAttachments.mockReset();
    downloadAttachment.mockReset();
    if (failures.listFails) listAttachments.mockRejectedValue(new Error('provider unreachable'));
    else listAttachments.mockResolvedValue(files.map(({ bytes: _bytes, ...meta }) => ({ ...meta, downloadUrl: `https://files.example.com/${meta.id}` })));
    downloadAttachment.mockImplementation(async (ref: { id: string }) => {
      const index = files.findIndex((f) => f.id === ref.id);
      if (failures.downloadFails?.includes(index)) throw new Error('provider unreachable');
      return files[index]!.bytes;
    });
  }

  /** One `email.received` event through the real route. */
  async function receive(d: Delivery) {
    const providerId = d.again?.providerId ?? `${EVENT_PREFIX}rcv-${randomUUID()}`;
    const eventId = d.again?.eventId ?? `${EVENT_PREFIX}evt-${randomUUID()}`;
    const from = d.from ?? 'Pat Payer <pat@example.com>';
    const subject = d.subject ?? 'Quick question';
    const files = (d.files ?? []).map((f, i) => {
      const bytes = f.bytes ?? JPEG;
      return {
        id: f.id ?? `${providerId}-att-${i}`,
        filename: f.name === undefined ? `door-${i}.jpg` : f.name,
        content_type: f.type ?? 'image/jpeg',
        size: f.size ?? bytes.length,
        content_disposition: 'attachment',
        content_id: null,
        bytes,
      };
    });
    fetchReceived.mockResolvedValue({
      providerId, from, receivedFor: d.to, to: d.to, subject,
      messageId: `<${providerId}@mail.example.com>`, receivedAt: ARRIVED, text: 'Are you open on Saturday?',
      html: d.html ?? '<div>Are you open on Saturday?</div>',
      headers: { 'Authentication-Results': 'amazonses.com; dmarc=pass header.from=example.com' },
      attachments: files.map(({ bytes: _bytes, ...meta }) => meta),
    });
    provide(files, { listFails: d.listFails, downloadFails: d.downloadFails });
    const body = JSON.stringify({
      type: 'email.received', created_at: ARRIVED.toISOString(),
      data: {
        email_id: providerId, created_at: ARRIVED.toISOString(), from, to: d.to, cc: [], bcc: [], received_for: d.to,
        message_id: `<${providerId}@mail.example.com>`, subject,
        attachments: files.map(({ bytes: _bytes, size: _size, ...meta }) => meta),
      },
    });
    const res = await request(app).post('/api/webhooks/resend').set('Content-Type', 'application/json').set(signed(eventId, body)).send(body);
    await settle();
    return { res, eventId, providerId, files };
  }

  /** The webhook answers first and finishes after, so a case reads the tables only once the database has been quiet a moment. */
  async function settle() {
    let seen = -1;
    for (let waited = 0; waited < 10_000 && seen !== queries.length; waited += 250) {
      seen = queries.length;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  const storedCopy = async (providerId: string) => {
    const [row, ...rest] = await db.email.findMany({ where: { provider_message_id: { startsWith: providerId } } });
    expect(rest).toEqual([]);
    return row!;
  };

  const storage = () => supabaseAdmin.storage.from(ATTACHMENTS_BUCKET) as unknown as {
    upload: ReturnType<typeof vi.fn>; createSignedUrl: ReturnType<typeof vi.fn>;
    };
  const rowsOf = (emailId: string) => db.emailAttachment.findMany({ where: { email_id: emailId }, orderBy: { position: 'asc' } });
  const link = async (person: Who, emailId: string, index = 0) =>
    (await person.api()).get(`/api/communication/emails/${emailId}/attachments/${index}`);

  describe('received HTML', () => {
    it('is stored cleaned by the compose path\'s own cleaner, on the mailbox path and on the reply-token path', async () => {
      const w: World = await world();

      const fresh = await receive({ to: [w.userAddress], html: HOSTILE_HTML });
      const reply = await receive({ to: [w.replyAddress], from: `Pat Payer <${w.customerEmail}>`, html: HOSTILE_HTML });

      for (const sent of [fresh, reply]) {
        expect(sent.res.status).toBe(200);
        const row = await storedCopy(sent.providerId);
        expect(row.body_html).toBe(sanitizeEmailHtml(HOSTILE_HTML));
        expect(row.body_html).toContain('Hello there');
        expect(row.body_html).not.toMatch(/<script|<iframe|onclick|onerror|javascript:/i);
      }
      expect((await storedCopy(reply.providerId)).thread_id).toBe(w.openThread);
    });
  });

  describe('received attachments', () => {

    it('stores a customer\'s photo the way a compose attachment is stored, linked to the received email', async () => {
      const w = await world();
      storage().upload.mockClear();

      const { res, providerId, files } = await receive({ to: [w.userAddress], files: [{ name: 'front door.jpg' }] });

      expect(res.status).toBe(200);
      const email = await storedCopy(providerId);
      expect(email).toMatchObject({ has_attachment: true, attachments_pending: false });
      const [row, ...rest] = await rowsOf(email.id);
      expect(rest).toEqual([]);
      expect(row).toMatchObject({
        email_id: email.id, organization_id: w.org, file_name: 'front door.jpg', content_type: 'image/jpeg',
        file_size: files[0]!.bytes.length, position: 0, provider_attachment_id: files[0]!.id,
      });
      // The compose path's object key: the company, then email, then this email's id, then a stamped, cleaned file name.
      expect(row!.storage_path).toMatch(new RegExp(`^${w.org}/email/${email.id}/\\d+-0-front_door\\.jpg$`));
      expect(storage().upload).toHaveBeenCalledTimes(1);
      const [path, bytes, options] = storage().upload.mock.calls[0]!;
      expect(path).toBe(row!.storage_path);
      expect(Buffer.from(bytes as Buffer).equals(files[0]!.bytes)).toBe(true);
      expect(options).toMatchObject({ contentType: 'image/jpeg', upsert: false });
    });

    it('opens from the conversation for the people who can read it and is refused, at the route, to everyone else', async () => {
      const w = await world();
      const { providerId } = await receive({ to: [w.userAddress], files: [{}] });
      const email = await storedCopy(providerId);
      const [row] = await rowsOf(email.id);
      storage().createSignedUrl.mockClear();

      // The mailbox's holder, a person who reads every mailbox, and the Admin box.
      for (const person of [w.holder, w.wide, w.admin]) {
        const res = await link(person, email.id);
        expect(res.status, person.email).toBe(200);
        expect(res.body.url).toEqual(expect.stringContaining('https://'));
      }
      expect(storage().createSignedUrl).toHaveBeenCalledWith(row!.storage_path, expect.any(Number));

      // Somebody else's mailbox, and a section they cannot open at all: nothing is signed for them.
      storage().createSignedUrl.mockClear();
      const outsider = await link(w.outsider, email.id);
      expect(outsider.status).toBe(404);
      expect(outsider.body.url).toBeUndefined();
      const noSection = await link(w.noSection, email.id);
      expect(noSection.status).toBe(403);
      expect(noSection.body.url).toBeUndefined();
      expect(storage().createSignedUrl).not.toHaveBeenCalled();
    });

    it('follows the record when it arrived on a reply token: people who can open the record read it, nobody else', async () => {
      const w = await world();
      const { providerId } = await receive({ to: [w.replyAddress], from: `Pat Payer <${w.customerEmail}>`, files: [{}] });
      const email = await storedCopy(providerId);
      expect(email.thread_id).toBe(w.openThread);
      expect(await rowsOf(email.id)).toHaveLength(1);

      // The holder is on the job's crew; the outsider is not attached to it and has no claim on the main mailbox.
      expect((await link(w.holder, email.id)).status).toBe(200);
      expect((await link(w.wide, email.id)).status).toBe(200);
      expect((await link(w.outsider, email.id)).status).toBe(404);
      expect((await link(w.noSection, email.id)).status).toBe(403);
    });

    it('shows the file on the message it arrived with, in the list a reader sees', async () => {
      const w = await world();
      const { providerId } = await receive({ to: [w.userAddress], files: [{ name: 'front door.jpg' }, { name: 'back door.jpg' }] });
      const email = await storedCopy(providerId);

      const list = await (await w.holder.api()).get('/api/communication/emails?mailbox=mine');

      expect(list.status).toBe(200);
      const shown = list.body.emails.find((i: { id: string }) => i.id === email.id);
      expect(shown.hasAttachment).toBe(true);
      expect(shown.attachments.map((a: { name: string; index: number }) => [a.name, a.index])).toEqual([['front door.jpg', 0], ['back door.jpg', 1]]);
    });

    it('stores one copy for each mailbox a message reached, downloading each file once', async () => {
      const w = await world();

      const { providerId } = await receive({ to: [w.userAddress, w.mainAddress], files: [{}] });

      const copies = await db.email.findMany({ where: { provider_message_id: { startsWith: providerId } } });
      expect(copies).toHaveLength(2);
      for (const copy of copies) {
        const rows = await rowsOf(copy.id);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.storage_path).toContain(`/email/${copy.id}/`);
        expect(copy.attachments_pending).toBe(false);
      }
      expect(listAttachments).toHaveBeenCalledTimes(1);
      expect(downloadAttachment).toHaveBeenCalledTimes(1);
    });

    describe('a redelivered event', () => {
      it('stores no second copy of the message or of its file, and asks the provider for nothing', async () => {
        const w = await world();
        const first = await receive({ to: [w.userAddress], files: [{}] });
        const email = await storedCopy(first.providerId);
        storage().upload.mockClear();

        const again = await receive({ to: [w.userAddress], files: [{}], again: { eventId: first.eventId, providerId: first.providerId } });

        expect(again.res.body).toMatchObject({ duplicate: true });
        expect(await rowsOf(email.id)).toHaveLength(1);
        expect(await db.email.count({ where: { provider_message_id: { startsWith: first.providerId } } })).toBe(1);
        expect(storage().upload).not.toHaveBeenCalled();
        expect(listAttachments).not.toHaveBeenCalled();
        expect(downloadAttachment).not.toHaveBeenCalled();
      });

      it('and bringing the same file over a second time, however it comes to run, stores it once', async () => {
        const w = await world();
        const first = await receive({ to: [w.userAddress], files: [{}] });
        const email = await storedCopy(first.providerId);
        const { bringOverReceivedAttachments } = await import('../lib/inbound-attachments.js');
        // The flag says "files on their way" again, as it would if the first run died after storing the file.
        await db.email.update({ where: { id: email.id }, data: { attachments_pending: true, attachment_attempts: 1 }, select: { id: true } });
        storage().upload.mockClear();

        await bringOverReceivedAttachments([email.id]);

        expect(await rowsOf(email.id)).toHaveLength(1);
        expect(storage().upload).not.toHaveBeenCalled();
        expect(await db.email.findUniqueOrThrow({ where: { id: email.id } })).toMatchObject({ attachments_pending: false, attachment_attempts: 2 });
      });
    });

    it('fetches nothing for mail the router drops', async () => {
      const w = await world();
      storage().upload.mockClear();

      const { res, eventId } = await receive({ to: [`never.issued.${w.tag}@${MAILBOX_DOMAIN}`], files: [{}, {}] });

      expect(res.status).toBe(200);
      expect(fetchReceived).not.toHaveBeenCalled();
      expect(listAttachments).not.toHaveBeenCalled();
      expect(downloadAttachment).not.toHaveBeenCalled();
      expect(storage().upload).not.toHaveBeenCalled();
      const [ledger] = await db.resendEvent.findMany({ where: { resend_event_id: eventId } });
      expect(ledger!.payload).toBeNull();
      expect(await db.emailAttachment.count({ where: { organization_id: w.org } })).toBe(0);
    });

    describe('a file that does not arrive', () => {
      const backdate = (emailId: string) =>
        db.$executeRawUnsafe(`UPDATE emails SET created_at = now() - interval '10 minutes' WHERE id = '${emailId}'`);

      it('is recorded, the message still shows, and the retry stores it once', async () => {
        const w = await world();
        const { res, providerId, files } = await receive({ to: [w.userAddress], files: [{ name: 'a.jpg' }, { name: 'b.jpg' }], downloadFails: [1] });

        // Acknowledged, stored, readable: the message is not held back for its files.
        expect(res.status).toBe(200);
        const email = await storedCopy(providerId);
        expect(email).toMatchObject({ has_attachment: true, attachments_pending: true, attachment_attempts: 1 });
        expect((await link(w.holder, email.id, 0)).status).toBe(200);
        expect((await (await w.holder.api()).get(`/api/communication/emails/${email.id}`)).status).toBe(200);
        expect((await rowsOf(email.id)).map((r) => r.file_name)).toEqual(['a.jpg']);

        // The provider comes back; the sweep picks the message up once it is old enough, and stores only what is missing.
        provide(files);
        storage().upload.mockClear();
        const { sweepReceivedAttachments } = await import('../lib/inbound-attachments.js');
        expect(await sweepReceivedAttachments()).toBe(0); // too fresh: the webhook that stored it owns it
        await backdate(email.id);
        expect(await sweepReceivedAttachments()).toBeGreaterThanOrEqual(1);

        expect((await rowsOf(email.id)).map((r) => [r.file_name, r.position])).toEqual([['a.jpg', 0], ['b.jpg', 1]]);
        expect(storage().upload).toHaveBeenCalledTimes(1);
        expect(await db.email.findUniqueOrThrow({ where: { id: email.id } })).toMatchObject({ attachments_pending: false, attachment_attempts: 2 });
        // Nothing left to retry.
        expect(await sweepReceivedAttachments()).toBe(0);
      });

      it('also when the provider cannot even list them; and a message that never gets them is given up on, not retried forever', async () => {
        const w = await world();
        const { providerId } = await receive({ to: [w.userAddress], files: [{}], listFails: true });
        const email = await storedCopy(providerId);
        expect(email).toMatchObject({ attachments_pending: true, attachment_attempts: 1 });
        expect(await rowsOf(email.id)).toEqual([]);
        expect((await link(w.holder, email.id)).status).toBe(404);

        const { sweepReceivedAttachments, RECEIVED_ATTACHMENT_MAX_ATTEMPTS } = await import('../lib/inbound-attachments.js');
        await backdate(email.id);
        for (let attempt = 1; attempt < RECEIVED_ATTACHMENT_MAX_ATTEMPTS; attempt++) await sweepReceivedAttachments();

        const spent = await db.email.findUniqueOrThrow({ where: { id: email.id } });
        expect(spent).toMatchObject({ attachments_pending: true, attachment_attempts: RECEIVED_ATTACHMENT_MAX_ATTEMPTS });
        listAttachments.mockClear();
        await sweepReceivedAttachments();
        expect(listAttachments).not.toHaveBeenCalled();
        // Still a message anyone who may read it can open.
        expect((await (await w.holder.api()).get(`/api/communication/emails/${email.id}`)).status).toBe(200);
      });
    });

    describe('a file the compose path would refuse', () => {
      it('is skipped for good, the others are stored, the message shows and nothing is retried', async () => {
        const w = await world();
        storage().upload.mockClear();
        const { providerId } = await receive({
          to: [w.userAddress],
          files: [
            { name: 'ok.jpg' },
            { name: 'huge.jpg', size: 26 * 1024 * 1024 },
            { name: 'run.exe', type: 'application/x-msdownload', bytes: Buffer.from('MZ not a document') },
            { name: 'liar.jpg', bytes: Buffer.from('this is plain text claiming to be a photo') },
          ],
        });

        const email = await storedCopy(providerId);
        expect((await rowsOf(email.id)).map((r) => r.file_name)).toEqual(['ok.jpg']);
        expect(email).toMatchObject({ has_attachment: true, attachments_pending: false });
        expect(storage().upload).toHaveBeenCalledTimes(1);
        // Too big and wrong type are decided from what the provider reports, so those bytes are never fetched.
        expect(downloadAttachment.mock.calls.map(([ref]) => ref.id)).toEqual([`${providerId}-att-0`, `${providerId}-att-3`]);
      });

      it('stops at the number of files an email may carry', async () => {
        const w = await world();
        const { MAX_EMAIL_ATTACHMENTS } = await import('../lib/email-attachment-limits.js');
        const { providerId } = await receive({ to: [w.userAddress], files: Array.from({ length: MAX_EMAIL_ATTACHMENTS + 2 }, (_, i) => ({ name: `p${i}.jpg` })) });

        const email = await storedCopy(providerId);
        expect(await rowsOf(email.id)).toHaveLength(MAX_EMAIL_ATTACHMENTS);
        expect(email.attachments_pending).toBe(false);
      });
    });
  });

  describe('while the Email plan feature is off', () => {
    it('stores the file with the message and hides its link like everything else of the mail, until the feature returns', async () => {
      const w = await world();
      const setEmailFeature = async (on: boolean) => {
        await db.organization.update({ where: { id: w.org }, data: { feature_overrides: on ? {} : { email: false } } });
        clearTokenCache();
      };
      await setEmailFeature(false);

      const mailbox = await receive({ to: [w.userAddress], files: [{}] });
      const token = await receive({ to: [w.replyAddress], from: `Pat Payer <${w.customerEmail}>`, files: [{}] });

      for (const sent of [mailbox, token]) {
        const email = await storedCopy(sent.providerId);
        expect(await db.emailAttachment.count({ where: { email_id: email.id } })).toBe(1);
        for (const person of [w.holder, w.wide, w.admin]) {
          const res = await link(person, email.id);
          expect(res.status, person.email).toBe(402);
          expect(res.body.url).toBeUndefined();
        }
      }

      await setEmailFeature(true);
      expect((await link(w.holder, (await storedCopy(mailbox.providerId)).id)).status).toBe(200);
    });
  });

  describe('cost, on the hosted database\'s one-connection pool', () => {
    it('adds nothing to a message with no files, and for a message with N files N + 4 statements, one list call and N downloads', async () => {
      const w = await world();
      const measure = async (count: number) => {
        await settle();
        // Ticket 37: switches read for people other than a signed-in requester are reused only for a moment, so whether a
        // message re-reads its recipients' switches depends on how long the one before took. Starting each message from an
        // empty memory puts the same reads in every count, and the differences below stay the attachments' own.
        clearAllSwitchCaches();
        queries.length = 0;
        storage().upload.mockClear();
        const { res } = await receive({ to: [w.userAddress], files: Array.from({ length: count }, (_, i) => ({ name: `p${i}.jpg` })) });
        expect(res.status).toBe(200);
        return {
          // Transaction control is Prisma's own, around a multi-row write: what is counted is the statements the code chose.
          statements: queries.filter((q) => !/^(BEGIN|COMMIT)/.test(q)).length,
          listCalls: listAttachments.mock.calls.length,
          downloads: downloadAttachment.mock.calls.length,
          uploads: storage().upload.mock.calls.length,
        };
      };

      await measure(0); // the first message of a company reads its plan, its people and its switches once
      const none = await measure(0);
      const one = await measure(1);
      const five = await measure(5);

      expect(none).toMatchObject({ listCalls: 0, downloads: 0, uploads: 0 });
      expect(one).toMatchObject({ listCalls: 1, downloads: 1, uploads: 1 });
      expect(five).toMatchObject({ listCalls: 1, downloads: 5, uploads: 5 });
      // The read of what is due, the count of the try, the read of what is already stored, one row per file, the flag cleared.
      // eslint-disable-next-line no-console
      console.info(`statements per received message: 0 files ${none.statements}, 1 file ${one.statements}, 5 files ${five.statements}`);
      expect(one.statements - none.statements).toBe(1 + 4);
      expect(five.statements - none.statements).toBe(5 + 4);
    });
  });
});
