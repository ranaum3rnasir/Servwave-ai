/* =============================================================================
   #3019 - the split of existing text conversations by their pair of numbers (scripts/sms-conversation-pair-split.ts).

   Real migrated database (TEST_DATABASE_URL; skips when unset). The script's public entry is run on seeded companies, the way a
   person runs it: a dry run prints the split counts and writes nothing; a run with --confirm splits each customer's (and each
   unknown number's) conversation by pair - the other party's number and the company number each text went through, the main
   line when a text has none, but a reply that did not go out (skipped, failed or still queued: no company number stored)
   goes to its conversation's own pair and never decides a conversation's pair - keeping every text, every read marker and
   every unread count; a second run changes nothing;
   staff, vendor and group conversations are left alone; a company not named is left alone; a company that is not an id is
   refused; with no company named it refuses unless --all asks for every company.
   A run stopped at any write (a failure injected at the database edge, the Prisma client's own query hook) and run again
   ends as one clean run does; a text that lands in a keyed conversation for another pair is moved by the next run.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';
import { runPairSplit } from '../sms-conversation-pair-split';

const { realClient } = (() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  if (!dbUrl) return { realClient: undefined };
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return { realClient: new PrismaClient({ datasources: { db: { url: dbUrl } } }) as PrismaClient };
})();

const suite = realClient ? describe : describe.skip;

const CUSTOMER_PHONE = '+15550103002';
const at = (minute: number) => new Date(Date.UTC(2026, 9, 30, 10, minute));

suite('the split of text conversations by pair of numbers (real database)', () => {
  const db = realClient as PrismaClient;
  const orgs: string[] = [];
  let sequence = 0;

  async function seedOrg() {
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    await db.organization.create({
      data: {
        id: org, name: `split-${tag}`, email: `split-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
      },
    });
    const n = ++sequence;
    const main = await db.phoneNumber.create({
      data: { organization_id: org, e164: `+1555020${String(n).padStart(4, '0')}`, is_org_default: true, status: 'active', sms_enabled: true },
    });
    const dana = await db.phoneNumber.create({
      data: { organization_id: org, e164: `+1555021${String(n).padStart(4, '0')}`, status: 'active', sms_enabled: true },
    });
    const person = async (first: string) => {
      const id = randomUUID();
      await db.user.create({ data: { id, organization_id: org, email: `${first}-${tag}@example.test`, first_name: first, last_name: 'Tester', role: 'ADMIN' } });
      return id;
    };
    return { org, main: main.id, mainLine: main.e164, dana: dana.id, danaLine: dana.e164, reader: await person('reader'), other: await person('other') };
  }
  type Org = Awaited<ReturnType<typeof seedOrg>>;

  async function customer(org: string, created: Date) {
    const id = randomUUID();
    await db.customer.create({
      data: { id, organization_id: org, customer_number: `C-${id.slice(0, 8)}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Pat', last_name: 'Lee', phone: '5550103002', created_at: created },
    });
    return id;
  }

  async function conversation(org: string, data: { id?: string; customer_id?: string; title?: string; kind?: string; user_id?: string; vendor_id?: string; other_party_e164?: string; our_number_e164?: string; created_at?: Date; updated_at?: Date }) {
    return (await db.messageThread.create({ data: { organization_id: org, channel: 'sms', campaign_type: 'customer_care', ...data } })).id;
  }

  async function text(org: string, threadId: string, body: string, direction: 'in' | 'out', minute: number, opts: { via?: string | null; otherParty?: string | null; status?: string | null } = {}) {
    await db.message.create({
      data: {
        organization_id: org, thread_id: threadId, direction, body, ts: at(minute),
        status: opts.status !== undefined ? opts.status : direction === 'in' ? 'received' : 'delivered',
        phone_number_id: opts.via ?? null, other_party_e164: opts.otherParty === undefined ? CUSTOMER_PHONE : opts.otherParty,
      },
    });
  }

  async function readBy(org: string, threadId: string, userId: string, minute: number) {
    await db.messageThreadReadState.create({ data: { organization_id: org, thread_id: threadId, user_id: userId, read_at: at(minute) } });
  }

  /** A company's text conversations as a person reads them: their pair, their texts' words, who is filed on, each person's unread count. */
  async function conversationsOf(o: Org) {
    const threads = await db.messageThread.findMany({
      where: { organization_id: o.org },
      select: {
        customer_id: true, kind: true, other_party_e164: true, our_number_e164: true,
        messages: { select: { body: true, direction: true, ts: true }, orderBy: { body: 'asc' } },
        read_states: { select: { user_id: true, read_at: true } },
      },
    });
    // Unread, as the inbox counts it: incoming texts newer than the person's marker (all of them with no marker).
    const unread = (t: (typeof threads)[number], userId: string) => {
      const marker = t.read_states.find((r) => r.user_id === userId)?.read_at;
      return t.messages.filter((m) => m.direction !== 'out' && (!marker || m.ts > marker)).length;
    };
    return threads
      .map((t) => ({
        pair: t.other_party_e164 ? [t.other_party_e164, t.our_number_e164] : null,
        customer: t.customer_id, kind: t.kind,
        texts: t.messages.map((m) => m.body),
        unread: { reader: unread(t, o.reader), other: unread(t, o.other) },
      }))
      .sort((a, b) => JSON.stringify(a.texts).localeCompare(JSON.stringify(b.texts)));
  }

  /** Everything the split could touch, to prove a run wrote nothing. */
  async function snapshot(orgIds: string[]) {
    const where = { organization_id: { in: orgIds } };
    return {
      threads: await db.messageThread.findMany({ where, orderBy: { id: 'asc' } }),
      texts: await db.message.findMany({ where, select: { id: true, thread_id: true }, orderBy: { id: 'asc' } }),
      markers: await db.messageThreadReadState.findMany({ where, orderBy: { id: 'asc' } }),
      alerts: await db.notification.findMany({ where, select: { id: true, object_id: true }, orderBy: { id: 'asc' } }),
    };
  }

  const run = async (args: string[]) => {
    const printed: string[] = [];
    const result = await runPairSplit(args, { prisma: db, print: (l) => printed.push(l) });
    return { result, printed };
  };

  /** Company A's conversations as they stand before the split (the cases the split must handle), returning their ids. */
  async function seedScenario(o: Org) {
    const ids: Record<string, string> = {};
    // A customer texted from Dana's number and from the main line, in ONE conversation from before pairs.
    const pat = await customer(o.org, new Date('2021-01-01T00:00:00Z'));
    ids.pat = pat;
    const mixed = await conversation(o.org, { customer_id: pat, created_at: at(0), updated_at: at(9) });
    ids.mixed = mixed;
    await text(o.org, mixed, 'Dana: your estimate is ready', 'out', 1, { via: o.dana });
    await text(o.org, mixed, 'Customer to Dana: shall we book it?', 'in', 2, { via: o.dana });
    await text(o.org, mixed, 'Office: reminder for Tuesday', 'out', 3, { via: o.main });
    await text(o.org, mixed, 'Customer to the office: thanks', 'in', 4, { via: null }); // no company number: the main line
    await text(o.org, mixed, 'Customer to Dana: any morning works', 'in', 6, { via: o.dana });
    await text(o.org, mixed, 'An old text nobody placed', 'out', 0, { via: null, otherParty: null });
    // The reader read up to minute 5: the text to the office is read, the latest one to Dana is not. The other person read
    // nothing.
    await readBy(o.org, mixed, o.reader, 5);

    // Two customers share the number, each with a conversation from before pairs on the main line: they join the older.
    const older = await customer(o.org, new Date('2022-01-01T00:00:00Z'));
    const newer = await customer(o.org, new Date('2024-01-01T00:00:00Z'));
    ids.older = older;
    const olderConv = await conversation(o.org, { customer_id: older, created_at: at(10), updated_at: at(12) });
    const newerConv = await conversation(o.org, { customer_id: newer, created_at: at(11), updated_at: at(14) });
    ids.newerConv = newerConv;
    ids.olderConv = olderConv;
    await text(o.org, olderConv, 'Older: hello', 'in', 12, { via: o.main, otherParty: '+15550107007' });
    await text(o.org, newerConv, 'Newer: hello', 'in', 14, { via: o.main, otherParty: '+15550107007' });
    await readBy(o.org, olderConv, o.reader, 13); // read the older's text, not the newer's
    await readBy(o.org, newerConv, o.other, 15); // read the newer's text, not the older's
    await db.notification.create({
      data: {
        organization_id: o.org, verb: 'communication.sms_inbound', category: 'COMMUNICATION', priority: 'FEED',
        object_type: 'MESSAGE_THREAD', object_id: newerConv, title: 'New text',
      },
    });

    // A conversation live traffic already keyed (after the deploy, before the split) and an old one with the same pair.
    const liveCustomer = await customer(o.org, new Date('2023-01-01T00:00:00Z'));
    const live = await conversation(o.org, { customer_id: liveCustomer, other_party_e164: '+15550108008', our_number_e164: o.danaLine, created_at: at(30) });
    ids.live = live;
    const old = await conversation(o.org, { customer_id: liveCustomer, created_at: at(20) });
    await text(o.org, old, 'Old: before the deploy', 'out', 21, { via: o.dana, otherParty: '+15550108008' });
    await text(o.org, live, 'Live: after the deploy', 'in', 31, { via: o.dana, otherParty: '+15550108008' });

    // An unknown number's conversation, texted on both lines.
    const unknown = await conversation(o.org, { title: '+15550109009', created_at: at(40) });
    await text(o.org, unknown, 'Unknown to the office', 'in', 41, { via: o.main, otherParty: '+15550109009' });
    await text(o.org, unknown, 'Unknown to Dana', 'in', 42, { via: o.dana, otherParty: '+15550109009' });

    // Left alone: staff, vendor and group conversations, and a conversation with no text placed.
    const staff = await conversation(o.org, { kind: 'team', user_id: o.other, title: 'other Tester' });
    await text(o.org, staff, 'Staff: on my way', 'in', 50, { via: o.main, otherParty: '+15550301111' });
    const vendorId = randomUUID();
    await db.vendor.create({ data: { id: vendorId, organization_id: o.org, name: 'Parts supplier', category: 'Parts' } });
    const vendor = await conversation(o.org, { vendor_id: vendorId });
    await text(o.org, vendor, 'Vendor: parts shipped', 'in', 51, { via: o.dana, otherParty: '+15550302222' });
    const group = await conversation(o.org, { kind: 'group', title: 'Crew' });
    await text(o.org, group, 'Group: crew note', 'out', 52, { via: o.main, otherParty: null });
    const unplaced = await conversation(o.org, { customer_id: pat });
    await text(o.org, unplaced, 'Nobody placed this one either', 'out', 53, { via: o.dana, otherParty: null });
    return ids;
  }

  /** Company A's conversations after the split, as a person reads them. */
  const splitAsExpected = (o: Org, ids: Record<string, string>) =>
    [
      { pair: [CUSTOMER_PHONE, o.danaLine], customer: ids.pat, kind: null,
        // The text nobody placed stays with its conversation's own texts.
        texts: ['An old text nobody placed', 'Customer to Dana: any morning works', 'Customer to Dana: shall we book it?', 'Dana: your estimate is ready'],
        unread: { reader: 1, other: 2 } },
      { pair: [CUSTOMER_PHONE, o.mainLine], customer: ids.pat, kind: null,
        texts: ['Customer to the office: thanks', 'Office: reminder for Tuesday'],
        unread: { reader: 0, other: 1 } },
      { pair: null, customer: null, kind: 'group', texts: ['Group: crew note'], unread: { reader: 0, other: 0 } },
      { pair: ['+15550108008', o.danaLine], customer: expect.any(String), kind: null,
        texts: ['Live: after the deploy', 'Old: before the deploy'], unread: { reader: 1, other: 1 } },
      { pair: null, customer: ids.pat, kind: null, texts: ['Nobody placed this one either'], unread: { reader: 0, other: 0 } },
      // The two customers' conversations on one pair are one, filed on the older. No text turned read: the other person, who
      // had read only the newer's text, keeps the older's unread, so the newer's reads unread again beside it.
      { pair: ['+15550107007', o.mainLine], customer: ids.older, kind: null,
        texts: ['Newer: hello', 'Older: hello'], unread: { reader: 1, other: 2 } },
      { pair: null, customer: null, kind: 'team', texts: ['Staff: on my way'], unread: { reader: 1, other: 1 } },
      { pair: ['+15550109009', o.danaLine], customer: null, kind: null, texts: ['Unknown to Dana'], unread: { reader: 1, other: 1 } },
      { pair: ['+15550109009', o.mainLine], customer: null, kind: null, texts: ['Unknown to the office'], unread: { reader: 1, other: 1 } },
      { pair: null, customer: null, kind: null, texts: ['Vendor: parts shipped'], unread: { reader: 1, other: 1 } },
    ].sort((a, b) => JSON.stringify(a.texts).localeCompare(JSON.stringify(b.texts)));

  /** Each conversation's read markers, by its texts and the person (no ids), to compare two companies' end states. */
  async function markersOf(o: Org) {
    const threads = await db.messageThread.findMany({
      where: { organization_id: o.org },
      select: { messages: { select: { body: true }, orderBy: { body: 'asc' } }, read_states: { select: { user_id: true, read_at: true } } },
    });
    const by = (t: (typeof threads)[number], userId: string) => t.read_states.find((r) => r.user_id === userId)?.read_at.toISOString() ?? null;
    return threads
      .map((t) => ({ texts: t.messages.map((m) => m.body), reader: by(t, o.reader), other: by(t, o.other), markers: t.read_states.length }))
      .sort((a, b) => JSON.stringify(a.texts).localeCompare(JSON.stringify(b.texts)));
  }

  /** The conversation each alert opens, by its texts. */
  async function alertsOpen(o: Org) {
    const alerts = await db.notification.findMany({ where: { organization_id: o.org, object_type: 'MESSAGE_THREAD' }, select: { object_id: true } });
    const opens: string[][] = [];
    for (const alert of alerts) {
      opens.push((await db.message.findMany({ where: { organization_id: o.org, thread_id: alert.object_id! }, select: { body: true }, orderBy: { body: 'asc' } })).map((m) => m.body));
    }
    return opens.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }

  const WRITES = new Set(['create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'updateManyAndReturn', 'upsert', 'delete', 'deleteMany', '$executeRaw', '$executeRawUnsafe']);

  /**
   * The database as the script sees it, with a failure injected at the database edge (Prisma's own query hook): the
   * write numbered `failAt` throws, as a dropped connection would, and every write is counted.
   */
  function databaseFailingAt(failAt: number | null) {
    const seen = { writes: 0 };
    const client = db.$extends({
      query: {
        $allModels: {
          async $allOperations({ operation, args, query }) {
            if (WRITES.has(operation)) {
              seen.writes += 1;
              if (seen.writes === failAt) throw new Error(`connection lost at write ${failAt}`);
            }
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;
    return { client, seen };
  }

  let A: Org;
  let B: Org;
  let ids: Record<string, string> = {};

  beforeAll(async () => {
    A = await seedOrg();
    B = await seedOrg();
    ids = await seedScenario(A);

    // Company B, not named in the --org runs: a mixed conversation of its own.
    const bPat = await customer(B.org, new Date('2021-01-01T00:00:00Z'));
    const bMixed = await conversation(B.org, { customer_id: bPat });
    await text(B.org, bMixed, 'B: from Dana', 'out', 1, { via: B.dana });
    await text(B.org, bMixed, 'B: from the office', 'out', 2, { via: B.main });
  }, 120_000);

  afterAll(async () => {
    for (const table of ['notifications', 'message_thread_read_states', 'messages', 'message_threads', 'vendors', 'customers', 'phone_numbers', 'users']) {
      await db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = ANY($1::uuid[])`, orgs);
    }
    await db.organization.deleteMany({ where: { id: { in: orgs } } });
    await db.$disconnect();
  });

  it('a dry run prints the split counts and writes nothing', async () => {
    const before = await snapshot([A.org, B.org]);

    const { result, printed } = await run(['--org', A.org]);

    expect(result).toMatchObject({ ok: true, confirmed: false });
    expect(printed).toEqual([
      'Text conversations split by pair of numbers - 1 company(ies)',
      'Dry run: nothing is written. Re-run with --confirm to write.',
      '  conversations examined: 7',
      // The customer's mixed conversation, the older of the two sharing a number, the older of the two on the live pair, and
      // the unknown number's.
      '  conversations keyed by their own pair (to be): 4',
      '  conversations made for a pair (to be): 2',
      "  conversations joined into their pair's and removed (to be): 2",
      '  texts moved (to be): 5',
      '  read markers copied (to be): 1',
      '  read markers joined (to be): 1',
      '  conversations left as they are (no text with a number): 1',
    ]);
    expect(await snapshot([A.org, B.org])).toEqual(before);
  });

  it('a run with --confirm splits each conversation by pair, keeping every text, read marker and unread count', async () => {
    const before = await conversationsOf(A);
    expect(before.find((c) => c.texts.includes('Dana: your estimate is ready'))!.unread).toEqual({ reader: 1, other: 3 });

    const { result } = await run(['--org', A.org, '--confirm']);

    expect(result).toMatchObject({ ok: true, confirmed: true });
    expect(await conversationsOf(A)).toEqual(splitAsExpected(A, ids));
    const kept = await db.message.findFirstOrThrow({ where: { organization_id: A.org, body: 'An old text nobody placed' }, select: { thread_id: true } });
    expect(kept.thread_id).toBe(ids.mixed);
  });

  it('an alert on a conversation that joined its pair\'s opens the conversation its texts went to', async () => {
    const alert = await db.notification.findFirstOrThrow({ where: { organization_id: A.org, object_type: 'MESSAGE_THREAD' }, select: { object_id: true } });
    expect(alert.object_id).toBe(ids.olderConv);
  });

  it('a conversation keeps its place in the inbox', async () => {
    const mixed = await db.messageThread.findUniqueOrThrow({ where: { id: ids.mixed }, select: { updated_at: true } });
    expect(mixed.updated_at).toEqual(at(9));
  });

  it('a second run changes nothing', async () => {
    const before = await snapshot([A.org, B.org]);

    const { printed } = await run(['--org', A.org, '--confirm']);

    expect(printed.slice(2)).toEqual([
      '  conversations examined: 7',
      '  conversations keyed by their own pair: 0',
      '  conversations made for a pair: 0',
      "  conversations joined into their pair's and removed: 0",
      '  texts moved: 0',
      '  read markers copied: 0',
      '  read markers joined: 0',
      '  conversations left as they are (no text with a number): 1',
    ]);
    expect(await snapshot([A.org, B.org])).toEqual(before);
  });

  it('a company not named is left alone', async () => {
    expect((await conversationsOf(B)).map((c) => ({ pair: c.pair, texts: c.texts }))).toEqual([
      { pair: null, texts: ['B: from Dana', 'B: from the office'] },
    ]);
  });


  it('with no company named it refuses, before reading anything', async () => {
    const before = await snapshot([A.org, B.org]);

    const { result, printed } = await run(['--confirm']);

    expect(result).toEqual({ ok: false, error: 'Name the companies with --org <id> (repeatable), or pass --all.' });
    expect(printed).toEqual(['Name the companies with --org <id> (repeatable), or pass --all.']);
    expect(await snapshot([A.org, B.org])).toEqual(before);
  });

  it('refuses a company named together with --all', async () => {
    const { result, printed } = await run(['--org', A.org, '--all', '--confirm']);
    expect(result).toEqual({ ok: false, error: 'Pass either --org <id> or --all, not both.' });
    expect(printed).toEqual(['Pass either --org <id> or --all, not both.']);
  });

  it('--all runs every company, a company never named among them', async () => {
    const counted = async (argv: string[]) => {
      const { result } = await run(argv);
      if (!result.ok) throw new Error(result.error);
      return result.counts;
    };
    const a = await counted(['--org', A.org]);
    const b = await counted(['--org', B.org]);
    const before = await snapshot([A.org, B.org]);

    const { result, printed } = await run(['--all']);

    expect(printed.slice(0, 2)).toEqual([
      'Text conversations split by pair of numbers - every company',
      'Dry run: nothing is written. Re-run with --confirm to write.',
    ]);
    // Company B's mixed conversation would be split: it is counted with company A's.
    expect(b.texts_moved).toBe(1);
    expect(result.ok && result.counts.conversations_examined).toBeGreaterThanOrEqual(a.conversations_examined + b.conversations_examined);
    expect(result.ok && result.counts.texts_moved).toBeGreaterThanOrEqual(a.texts_moved + b.texts_moved);
    expect(await snapshot([A.org, B.org])).toEqual(before);
  });

  /**
   * Stops a run at each of its writes in turn (on a freshly seeded company each time), runs again, and expects every end
   * state to equal one clean run's: every text with its pair, every read marker and unread count, every alert.
   */
  async function stoppedAtEveryWriteEndsAsOneCleanRun(
    seed: (o: Org) => Promise<Record<string, string>>,
    expected: (o: Org, ids: Record<string, string>) => unknown[],
    alerts: string[][],
  ) {
    const clean = await seedOrg();
    const cleanIds = await seed(clean);
    const counting = databaseFailingAt(null);
    await runPairSplit(['--org', clean.org, '--confirm'], { prisma: counting.client, print: () => {} });
    expect(await conversationsOf(clean)).toEqual(expected(clean, cleanIds));
    expect(await alertsOpen(clean)).toEqual(alerts);
    const cleanMarkers = await markersOf(clean);
    expect(counting.seen.writes).toBeGreaterThan(1);

    for (let failAt = 1; failAt <= counting.seen.writes; failAt += 1) {
      const o = await seedOrg();
      const oIds = await seed(o);
      const stopped = databaseFailingAt(failAt);
      await expect(runPairSplit(['--org', o.org, '--confirm'], { prisma: stopped.client, print: () => {} })).rejects.toThrow(
        `connection lost at write ${failAt}`,
      );

      await run(['--org', o.org, '--confirm']);

      expect({ failAt, conversations: await conversationsOf(o) }).toEqual({ failAt, conversations: expected(o, oIds) });
      expect({ failAt, markers: await markersOf(o) }).toEqual({ failAt, markers: cleanMarkers });
      expect({ failAt, alerts: await alertsOpen(o) }).toEqual({ failAt, alerts });
    }
  }

  it('a run stopped at any write, then run again, ends as one clean run does: every text with its pair, every read marker and unread count, every alert', async () => {
    await stoppedAtEveryWriteEndsAsOneCleanRun(seedScenario, splitAsExpected, [['Newer: hello', 'Older: hello']]);
  }, 600_000);

  describe('a text that lands in a keyed conversation for another pair (it arrived while a run was going)', () => {
    let L: Org;

    it('is moved by the next run to its pair\'s conversation, its read markers following it', async () => {
      L = await seedOrg();
      const lIds = await seedScenario(L);
      await run(['--org', L.org, '--confirm']);
      // The customer's conversation with Dana's number holds a text the customer sent to the main line.
      await text(L.org, lIds.mixed, 'Customer to the office: one more thing', 'in', 7, { via: L.main });

      const { printed } = await run(['--org', L.org, '--confirm']);

      expect(printed).toContain('  texts moved: 1');
      const expected = splitAsExpected(L, lIds).map((c) =>
        JSON.stringify(c.pair) === JSON.stringify([CUSTOMER_PHONE, L.mainLine])
          ? {
              ...c,
              texts: ['Customer to the office: one more thing', 'Customer to the office: thanks', 'Office: reminder for Tuesday'],
              // The reader read up to minute 5 and the other person nothing: the new text is unread for both.
              unread: { reader: 1, other: 2 },
            }
          : c,
      );
      expect(await conversationsOf(L)).toEqual(expected.sort((a, b) => JSON.stringify(a.texts).localeCompare(JSON.stringify(b.texts))));
    });

    it('joins the conversation an earlier run made for its pair from this one (the same created date), and makes none', async () => {
      const o = await seedOrg();
      const pat = await customer(o.org, new Date('2021-01-01T00:00:00Z'));
      // As an earlier run left them: the conversation made for the main line is a copy of the customer's conversation, so it
      // has the same created date; the ids are chosen so that the customer's conversation sorts first.
      const tail = randomUUID().slice(8);
      const danaConv = await conversation(o.org, { id: `00000000${tail}`, customer_id: pat, other_party_e164: CUSTOMER_PHONE, our_number_e164: o.danaLine, created_at: at(0), updated_at: at(2) });
      const mainConv = await conversation(o.org, { id: `ffffffff${tail}`, customer_id: pat, other_party_e164: CUSTOMER_PHONE, our_number_e164: o.mainLine, created_at: at(0), updated_at: at(3) });
      await text(o.org, danaConv, 'Customer to Dana', 'in', 2, { via: o.dana });
      await text(o.org, mainConv, 'Customer to the office', 'in', 3, { via: o.main });
      await text(o.org, danaConv, 'Customer to the office: one more thing', 'in', 7, { via: o.main });

      const { printed } = await run(['--org', o.org, '--confirm']);

      expect(printed).toContain('  conversations made for a pair: 0');
      expect(printed).toContain('  texts moved: 1');
      expect((await conversationsOf(o)).map((c) => ({ pair: c.pair, texts: c.texts }))).toEqual([
        { pair: [CUSTOMER_PHONE, o.danaLine], texts: ['Customer to Dana'] },
        { pair: [CUSTOMER_PHONE, o.mainLine], texts: ['Customer to the office', 'Customer to the office: one more thing'] },
      ]);
      expect(await db.messageThread.count({ where: { id: mainConv } })).toBe(1);
    });

    it('and a run after that changes nothing', async () => {
      const before = await snapshot([L.org]);

      const { printed } = await run(['--org', L.org, '--confirm']);

      expect(printed).toContain('  texts moved: 0');
      expect(await snapshot([L.org])).toEqual(before);
    });
  });

  /**
   * Conversations live traffic keyed on a staff member's line, as they stand before the split:
   *  - a reply sent from one that was not delivered (skipped, or still queued) - the send route stores no company number on
   *    a text that did not go out;
   *  - two customers share a number: the older one's conversation from before pairs is on the main line, the newer one's is
   *    keyed on Dana's line and holds a main-line text (it landed while a run was going);
   *  - two customers share another number on Dana's line: the older one's conversation from before pairs, the newer one's
   *    keyed by live traffic;
   *  - two customers share a third number, each with a conversation from before pairs: the older one's is on Dana's line and
   *    holds one main-line text, the newer one's is on the main line.
   */
  async function seedStaffLineScenario(o: Org) {
    const ids: Record<string, string> = {};
    const jo = await customer(o.org, new Date('2021-01-01T00:00:00Z'));
    ids.jo = jo;
    const joDana = await conversation(o.org, { customer_id: jo, other_party_e164: '+15550104004', our_number_e164: o.danaLine, created_at: at(60), updated_at: at(63) });
    ids.joDana = joDana;
    await text(o.org, joDana, 'Jo to Dana: is Tuesday ok?', 'in', 61, { via: o.dana, otherParty: '+15550104004' });
    await text(o.org, joDana, 'Dana to Jo: not sent, opted out', 'out', 62, { via: null, otherParty: '+15550104004', status: 'skipped' });
    await text(o.org, joDana, 'Dana to Jo: still queued', 'out', 63, { via: null, otherParty: '+15550104004', status: 'queued' });
    await readBy(o.org, joDana, o.reader, 61);

    const pat = await customer(o.org, new Date('2022-01-01T00:00:00Z'));
    const sam = await customer(o.org, new Date('2024-01-01T00:00:00Z'));
    ids.pat = pat;
    ids.sam = sam;
    const patOld = await conversation(o.org, { customer_id: pat, created_at: at(70), updated_at: at(72) });
    ids.patOld = patOld;
    await text(o.org, patOld, 'Pat to the office', 'in', 71, { via: o.main, otherParty: '+15550105005' });
    await text(o.org, patOld, 'Office to Pat', 'out', 72, { via: o.main, otherParty: '+15550105005' });
    await readBy(o.org, patOld, o.reader, 71);
    const samDana = await conversation(o.org, { customer_id: sam, other_party_e164: '+15550105005', our_number_e164: o.danaLine, created_at: at(80), updated_at: at(82) });
    await text(o.org, samDana, 'Sam to Dana', 'in', 81, { via: o.dana, otherParty: '+15550105005' });
    await text(o.org, samDana, 'Sam to the office', 'in', 82, { via: o.main, otherParty: '+15550105005' });
    await readBy(o.org, samDana, o.other, 81);
    await alert(o.org, patOld);

    const lee = await customer(o.org, new Date('2022-01-01T00:00:00Z'));
    const kim = await customer(o.org, new Date('2024-01-01T00:00:00Z'));
    ids.lee = lee;
    ids.kim = kim;
    const leeOld = await conversation(o.org, { customer_id: lee, created_at: at(90), updated_at: at(91) });
    await text(o.org, leeOld, 'Lee to Dana', 'in', 91, { via: o.dana, otherParty: '+15550106006' });
    await readBy(o.org, leeOld, o.reader, 91);
    const kimLive = await conversation(o.org, { customer_id: kim, other_party_e164: '+15550106006', our_number_e164: o.danaLine, created_at: at(95), updated_at: at(96) });
    await text(o.org, kimLive, 'Kim to Dana', 'in', 96, { via: o.dana, otherParty: '+15550106006' });
    await readBy(o.org, kimLive, o.other, 96);
    await alert(o.org, kimLive);

    const ray = await customer(o.org, new Date('2022-01-01T00:00:00Z'));
    const una = await customer(o.org, new Date('2024-01-01T00:00:00Z'));
    ids.ray = ray;
    ids.una = una;
    const rayOld = await conversation(o.org, { customer_id: ray, created_at: at(100), updated_at: at(102) });
    await text(o.org, rayOld, 'Office to Ray', 'out', 101, { via: o.main, otherParty: '+15550107117' });
    await text(o.org, rayOld, 'Ray to Dana', 'in', 102, { via: o.dana, otherParty: '+15550107117' });
    await readBy(o.org, rayOld, o.reader, 102);
    const unaOld = await conversation(o.org, { customer_id: una, created_at: at(105), updated_at: at(106) });
    await text(o.org, unaOld, 'Una to the office', 'in', 106, { via: o.main, otherParty: '+15550107117' });
    return ids;
  }

  async function alert(org: string, threadId: string) {
    await db.notification.create({
      data: {
        organization_id: org, verb: 'communication.sms_inbound', category: 'COMMUNICATION', priority: 'FEED',
        object_type: 'MESSAGE_THREAD', object_id: threadId, title: 'New text',
      },
    });
  }

  /** The staff-line scenario after the split, as a person reads it. */
  const staffLineSplitAsExpected = (o: Org, ids: Record<string, string>) =>
    [
      // The replies that did not go out stay in the conversation they were sent from; no main-line conversation is made.
      { pair: ['+15550104004', o.danaLine], customer: ids.jo, kind: null,
        texts: ['Dana to Jo: not sent, opted out', 'Dana to Jo: still queued', 'Jo to Dana: is Tuesday ok?'],
        unread: { reader: 0, other: 1 } },
      // The main-line text joins the OLDER customer's main-line conversation, which stays filed on that customer. No text
      // turned read: the reader had not read it (no marker on the newer conversation), the other person had read only up to
      // Dana's text.
      { pair: ['+15550105005', o.mainLine], customer: ids.pat, kind: null,
        texts: ['Office to Pat', 'Pat to the office', 'Sam to the office'],
        unread: { reader: 1, other: 2 } },
      { pair: ['+15550105005', o.danaLine], customer: ids.sam, kind: null,
        texts: ['Sam to Dana'], unread: { reader: 1, other: 0 } },
      // One conversation per pair, filed on the older conversation's customer (Ran's ruling).
      { pair: ['+15550106006', o.danaLine], customer: ids.lee, kind: null,
        texts: ['Kim to Dana', 'Lee to Dana'], unread: { reader: 1, other: 2 } },
      { pair: ['+15550107117', o.danaLine], customer: ids.ray, kind: null,
        texts: ['Ray to Dana'], unread: { reader: 0, other: 1 } },
      // The older customer's main-line text and the newer customer's are one conversation, filed on the OLDER customer.
      { pair: ['+15550107117', o.mainLine], customer: ids.ray, kind: null,
        texts: ['Office to Ray', 'Una to the office'], unread: { reader: 1, other: 1 } },
    ].sort((a, b) => JSON.stringify(a.texts).localeCompare(JSON.stringify(b.texts)));

  const STAFF_LINE_ALERTS = [['Kim to Dana', 'Lee to Dana'], ['Office to Pat', 'Pat to the office', 'Sam to the office']];

  describe('conversations keyed on a staff member\'s line, and numbers two customers share', () => {
    let S: Org;
    let sIds: Record<string, string>;

    beforeAll(async () => {
      S = await seedOrg();
      sIds = await seedStaffLineScenario(S);
    });

    it('a reply that did not go out stays in the conversation it was sent from; a pair\'s texts join the OLDER customer\'s conversation', async () => {
      const { result } = await run(['--org', S.org, '--confirm']);

      expect(result).toMatchObject({ ok: true, confirmed: true });
      expect(await conversationsOf(S)).toEqual(staffLineSplitAsExpected(S, sIds));
      expect(await alertsOpen(S)).toEqual(STAFF_LINE_ALERTS);
      const joDana = await db.messageThread.findUniqueOrThrow({ where: { id: sIds.joDana }, select: { updated_at: true } });
      expect(joDana.updated_at).toEqual(at(63));
      const patOld = await db.messageThread.findUniqueOrThrow({ where: { id: sIds.patOld }, select: { created_at: true } });
      expect(patOld.created_at).toEqual(at(70));
    });

    it('after the main line changes, a run again moves nothing', async () => {
      await db.phoneNumber.updateMany({ where: { organization_id: S.org }, data: { is_org_default: false } });
      await db.phoneNumber.create({ data: { organization_id: S.org, e164: '+15550299999', is_org_default: true, status: 'active', sms_enabled: true } });
      const before = await snapshot([S.org]);

      const { printed } = await run(['--org', S.org, '--confirm']);

      expect(printed).toContain('  texts moved: 0');
      expect(await snapshot([S.org])).toEqual(before);
    });

    it('a run stopped at any write, then run again, ends as one clean run does', async () => {
      await stoppedAtEveryWriteEndsAsOneCleanRun(seedStaffLineScenario, staffLineSplitAsExpected, STAFF_LINE_ALERTS);
    }, 600_000);
  });

  /**
   * Conversations from before pairs (not keyed yet) holding a reply that did not go out: skipped, failed or still queued, so
   * the send route stored no company number on it (Ran's rulings, 2026-11-06: such a text goes to its conversation's own pair -
   * the company number of the conversation's latest text with the same other party that has one; when that other party has
   * none, the company number of the conversation's latest text of ANY other party that has one; the main line only when no
   * text in the conversation has a company number. A reply that did not go out never decides a conversation's pair: one not
   * keyed yet stays with its latest text that is not such a reply):
   *  - Ava only texted Dana's line; Dana's failed reply is the conversation's latest text;
   *  - Ben only texted Dana's line; Dana's skipped reply sits between his texts;
   *  - Cal's conversation has no text with a company number at all;
   *  - Dee was texted from the main line, then texted Dana's line; Dana's queued reply comes after;
   *  - Eve texted Dana's line, Dana's failed reply follows, then Eve texted the main line (the latest text with a number);
   *  - Fay (older) and Gus (newer) share a number: Fay's conversation from before pairs holds her text to Dana's line and
   *    Dana's skipped reply (the latest); Gus's conversation was keyed on Dana's line by live traffic and has an alert;
   *  - Hal texted Dana's line from one phone and the main line from another (the latest text with a number); Dana's queued
   *    reply to his first phone is the latest text: it goes with that phone's pair, and the conversation stays with Hal's
   *    text to the main line;
   *  - unchanged from round 5, a KEYED conversation: Ivy's, keyed on Dana's line by live traffic, holds a text Ivy sent to the
   *    main line (it landed while a run was going) and then Dana's skipped reply: the reply is the conversation's own;
   *  - Jon texted Dana's line from his new number; Dana's skipped reply went to his phone, which has no text with a company
   *    number: the reply goes to (his phone, Dana's line), the conversation stays with his new number's text;
   *  - Kai's other phone texted the main line, then Dana's line (the conversation's latest text with a number); Dana's failed
   *    reply went to his first phone: (his first phone, Dana's line);
   *  - Lia's conversation is KEYED on Dana's line: a text her other phone sent to Eli's line landed in it, then Dana's skipped
   *    reply to that phone (it goes with Eli's line) and a queued reply to her third phone, which has no text (it takes the
   *    conversation's latest company number, Eli's line);
   *  - Max texted Dana's line; an older outbound text to him has no company number and no status: it is not a reply that did
   *    not go out, so it is on the main line, and as the latest text it keeps the conversation.
   */
  async function seedUnsentReplyScenario(o: Org) {
    const ids: Record<string, string> = {};
    const conv = async (name: string, minute: number, extra: { other_party_e164?: string; our_number_e164?: string } = {}) => {
      ids[name] = await customer(o.org, new Date('2022-01-01T00:00:00Z'));
      ids[`${name}Conv`] = await conversation(o.org, { customer_id: ids[name], created_at: at(minute), updated_at: at(minute), ...extra });
      return ids[`${name}Conv`]!;
    };

    const ava = await conv('ava', 200);
    await text(o.org, ava, 'Ava to Dana', 'in', 201, { via: o.dana, otherParty: '+15550101101' });
    await text(o.org, ava, 'Dana to Ava: failed', 'out', 202, { via: null, otherParty: '+15550101101', status: 'failed' });
    await readBy(o.org, ava, o.reader, 201);

    const ben = await conv('ben', 210);
    await text(o.org, ben, 'Ben to Dana', 'in', 211, { via: o.dana, otherParty: '+15550101102' });
    await text(o.org, ben, 'Dana to Ben: skipped', 'out', 212, { via: null, otherParty: '+15550101102', status: 'skipped' });
    await text(o.org, ben, 'Ben to Dana again', 'in', 213, { via: o.dana, otherParty: '+15550101102' });

    const cal = await conv('cal', 220);
    await text(o.org, cal, 'Cal to the office', 'in', 221, { via: null, otherParty: '+15550101103' });
    await text(o.org, cal, 'Office to Cal: queued', 'out', 222, { via: null, otherParty: '+15550101103', status: 'queued' });

    const dee = await conv('dee', 230);
    await text(o.org, dee, 'Office to Dee', 'out', 231, { via: o.main, otherParty: '+15550101104' });
    await text(o.org, dee, 'Dee to Dana', 'in', 232, { via: o.dana, otherParty: '+15550101104' });
    await text(o.org, dee, 'Dana to Dee: queued', 'out', 233, { via: null, otherParty: '+15550101104', status: 'queued' });
    await readBy(o.org, dee, o.other, 232);

    const eve = await conv('eve', 240);
    await text(o.org, eve, 'Eve to Dana', 'in', 241, { via: o.dana, otherParty: '+15550101105' });
    await text(o.org, eve, 'Dana to Eve: failed', 'out', 242, { via: null, otherParty: '+15550101105', status: 'failed' });
    await text(o.org, eve, 'Eve to the office', 'in', 243, { via: o.main, otherParty: '+15550101105' });

    const fay = await conv('fay', 250);
    await text(o.org, fay, 'Fay to Dana', 'in', 251, { via: o.dana, otherParty: '+15550101106' });
    await text(o.org, fay, 'Dana to Fay: skipped', 'out', 252, { via: null, otherParty: '+15550101106', status: 'skipped' });
    await readBy(o.org, fay, o.reader, 251);
    const gus = await conv('gus', 255, { other_party_e164: '+15550101106', our_number_e164: o.danaLine });
    await text(o.org, gus, 'Gus to Dana', 'in', 256, { via: o.dana, otherParty: '+15550101106' });
    await readBy(o.org, gus, o.other, 256);
    await alert(o.org, gus);

    const hal = await conv('hal', 260);
    await text(o.org, hal, 'Hal to Dana', 'in', 261, { via: o.dana, otherParty: '+15550101107' });
    await text(o.org, hal, 'Hal from his other phone to the office', 'in', 262, { via: o.main, otherParty: '+15550101108' });
    await text(o.org, hal, 'Dana to Hal: queued', 'out', 263, { via: null, otherParty: '+15550101107', status: 'queued' });

    const ivy = await conv('ivy', 270, { other_party_e164: '+15550101109', our_number_e164: o.danaLine });
    await text(o.org, ivy, 'Ivy to Dana', 'in', 271, { via: o.dana, otherParty: '+15550101109' });
    await text(o.org, ivy, 'Ivy to the office', 'in', 272, { via: o.main, otherParty: '+15550101109' });
    await text(o.org, ivy, 'Dana to Ivy: skipped', 'out', 273, { via: null, otherParty: '+15550101109', status: 'skipped' });

    const jon = await conv('jon', 280);
    await text(o.org, jon, 'Jon from his new number to Dana', 'in', 281, { via: o.dana, otherParty: '+15550101112' });
    await text(o.org, jon, 'Dana to Jon: skipped', 'out', 282, { via: null, otherParty: '+15550101111', status: 'skipped' });

    const kai = await conv('kai', 290);
    await text(o.org, kai, 'Kai\'s other phone to the office', 'in', 291, { via: o.main, otherParty: '+15550101114' });
    await text(o.org, kai, 'Kai\'s other phone to Dana', 'in', 292, { via: o.dana, otherParty: '+15550101114' });
    await text(o.org, kai, 'Dana to Kai: failed', 'out', 293, { via: null, otherParty: '+15550101113', status: 'failed' });

    const eli = await db.phoneNumber.create({
      data: { organization_id: o.org, e164: `+1555022${o.danaLine.slice(-4)}`, status: 'active', sms_enabled: true },
    });
    const lia = await conv('lia', 300, { other_party_e164: '+15550101115', our_number_e164: o.danaLine });
    await text(o.org, lia, 'Lia to Dana', 'in', 301, { via: o.dana, otherParty: '+15550101115' });
    await text(o.org, lia, 'Lia\'s other phone to Eli', 'in', 302, { via: eli.id, otherParty: '+15550101116' });
    await text(o.org, lia, 'Dana to Lia\'s other phone: skipped', 'out', 303, { via: null, otherParty: '+15550101116', status: 'skipped' });
    await text(o.org, lia, 'Dana to Lia\'s third phone: queued', 'out', 304, { via: null, otherParty: '+15550101117', status: 'queued' });

    const max = await conv('max', 310);
    await text(o.org, max, 'Max to Dana', 'in', 311, { via: o.dana, otherParty: '+15550101118' });
    await text(o.org, max, 'Office to Max, no status', 'out', 312, { via: null, otherParty: '+15550101118', status: null });
    return ids;
  }

  /** The unsent-reply scenario after the split, as a person reads it. */
  const unsentReplySplitAsExpected = (o: Org, ids: Record<string, string>) =>
    [
      // ONE conversation on (Ava, Dana's line), holding the failed reply; no main-line conversation.
      { pair: ['+15550101101', o.danaLine], customer: ids.ava, kind: null,
        texts: ['Ava to Dana', 'Dana to Ava: failed'], unread: { reader: 0, other: 1 } },
      { pair: ['+15550101102', o.danaLine], customer: ids.ben, kind: null,
        texts: ['Ben to Dana', 'Ben to Dana again', 'Dana to Ben: skipped'], unread: { reader: 2, other: 2 } },
      // No text has a company number: the main line.
      { pair: ['+15550101103', o.mainLine], customer: ids.cal, kind: null,
        texts: ['Cal to the office', 'Office to Cal: queued'], unread: { reader: 1, other: 1 } },
      // The queued reply joins the pair of the latest text with a company number (Dee's text to Dana).
      { pair: ['+15550101104', o.danaLine], customer: ids.dee, kind: null,
        texts: ['Dana to Dee: queued', 'Dee to Dana'], unread: { reader: 1, other: 0 } },
      { pair: ['+15550101104', o.mainLine], customer: ids.dee, kind: null,
        texts: ['Office to Dee'], unread: { reader: 0, other: 0 } },
      // The latest text with a company number is Eve's text to the main line: the failed reply goes with it.
      { pair: ['+15550101105', o.danaLine], customer: ids.eve, kind: null,
        texts: ['Eve to Dana'], unread: { reader: 1, other: 1 } },
      { pair: ['+15550101105', o.mainLine], customer: ids.eve, kind: null,
        texts: ['Dana to Eve: failed', 'Eve to the office'], unread: { reader: 1, other: 1 } },
      // One conversation, the OLDER one (Fay's), keeps the pair and its customer. Earlier marker on the join: the reader read
      // Fay's text (minute 251) and had no marker on Gus's, so Gus's text is unread; the other person read Gus's text
      // (minute 256) and had no marker on Fay's, so both incoming texts are unread for them.
      { pair: ['+15550101106', o.danaLine], customer: ids.fay, kind: null,
        texts: ['Dana to Fay: skipped', 'Fay to Dana', 'Gus to Dana'], unread: { reader: 1, other: 2 } },
      // The latest text with a company number to the SAME other party decides: Hal's first phone texted Dana's line. Hal's
      // conversation stays with his text to the main line, its latest text that is not an unsent reply.
      { pair: ['+15550101107', o.danaLine], customer: ids.hal, kind: null,
        texts: ['Dana to Hal: queued', 'Hal to Dana'], unread: { reader: 1, other: 1 } },
      { pair: ['+15550101108', o.mainLine], customer: ids.hal, kind: null,
        texts: ['Hal from his other phone to the office'], unread: { reader: 1, other: 1 } },
      // A keyed conversation's own reply stays with its key, though its latest text with a number is on the main line.
      { pair: ['+15550101109', o.danaLine], customer: ids.ivy, kind: null,
        texts: ['Dana to Ivy: skipped', 'Ivy to Dana'], unread: { reader: 1, other: 1 } },
      { pair: ['+15550101109', o.mainLine], customer: ids.ivy, kind: null,
        texts: ['Ivy to the office'], unread: { reader: 1, other: 1 } },
      // Jon's phone has no text with a company number: the reply takes the conversation's latest one, Dana's line. The
      // conversation stays with his new number's text.
      { pair: ['+15550101112', o.danaLine], customer: ids.jon, kind: null,
        texts: ['Jon from his new number to Dana'], unread: { reader: 1, other: 1 } },
      { pair: ['+15550101111', o.danaLine], customer: ids.jon, kind: null,
        texts: ['Dana to Jon: skipped'], unread: { reader: 0, other: 0 } },
      // The conversation's LATEST text with a company number is on Dana's line, not the main line.
      { pair: ['+15550101114', o.danaLine], customer: ids.kai, kind: null,
        texts: ['Kai\'s other phone to Dana'], unread: { reader: 1, other: 1 } },
      { pair: ['+15550101114', o.mainLine], customer: ids.kai, kind: null,
        texts: ['Kai\'s other phone to the office'], unread: { reader: 1, other: 1 } },
      { pair: ['+15550101113', o.danaLine], customer: ids.kai, kind: null,
        texts: ['Dana to Kai: failed'], unread: { reader: 0, other: 0 } },
      { pair: ['+15550101115', o.danaLine], customer: ids.lia, kind: null,
        texts: ['Lia to Dana'], unread: { reader: 1, other: 1 } },
      { pair: ['+15550101116', `+1555022${o.danaLine.slice(-4)}`], customer: ids.lia, kind: null,
        texts: ['Dana to Lia\'s other phone: skipped', 'Lia\'s other phone to Eli'], unread: { reader: 1, other: 1 } },
      { pair: ['+15550101117', `+1555022${o.danaLine.slice(-4)}`], customer: ids.lia, kind: null,
        texts: ['Dana to Lia\'s third phone: queued'], unread: { reader: 0, other: 0 } },
      // A text with no company number and no status is not a reply that did not go out: the main line.
      { pair: ['+15550101118', o.mainLine], customer: ids.max, kind: null,
        texts: ['Office to Max, no status'], unread: { reader: 0, other: 0 } },
      { pair: ['+15550101118', o.danaLine], customer: ids.max, kind: null,
        texts: ['Max to Dana'], unread: { reader: 1, other: 1 } },
    ].sort((a, b) => JSON.stringify(a.texts).localeCompare(JSON.stringify(b.texts)));

  const UNSENT_REPLY_ALERTS = [['Dana to Fay: skipped', 'Fay to Dana', 'Gus to Dana']];

  describe('a reply that did not go out, in a conversation from before pairs', () => {
    let U: Org;
    let uIds: Record<string, string>;

    beforeAll(async () => {
      U = await seedOrg();
      uIds = await seedUnsentReplyScenario(U);
    });

    it('goes to its conversation\'s own pair (the latest text with a company number), never deciding a conversation\'s pair by itself', async () => {
      const { result } = await run(['--org', U.org, '--confirm']);

      expect(result).toMatchObject({ ok: true, confirmed: true });
      expect(await conversationsOf(U)).toEqual(unsentReplySplitAsExpected(U, uIds));
      expect(await alertsOpen(U)).toEqual(UNSENT_REPLY_ALERTS);
      // The conversations from before pairs are keyed in place, each by its latest text that is not an unsent reply: the
      // unsent reply stays in the conversation it was sent from when it shares that pair, and that text always does.
      for (const [body, conv] of [['Dana to Ava: failed', 'avaConv'], ['Dana to Ben: skipped', 'benConv'], ['Office to Cal: queued', 'calConv'],
        ['Dana to Dee: queued', 'deeConv'], ['Dana to Eve: failed', 'eveConv'], ['Dana to Fay: skipped', 'fayConv'],
        ['Hal from his other phone to the office', 'halConv'], ['Dana to Ivy: skipped', 'ivyConv'],
        ['Jon from his new number to Dana', 'jonConv'], ['Kai\'s other phone to Dana', 'kaiConv'], ['Lia to Dana', 'liaConv'],
        ['Office to Max, no status', 'maxConv']] as const) {
        const reply = await db.message.findFirstOrThrow({ where: { organization_id: U.org, body }, select: { thread_id: true } });
        expect({ body, conversation: reply.thread_id }).toEqual({ body, conversation: uIds[conv] });
      }
    });

    it('and a second run changes nothing', async () => {
      const before = await snapshot([U.org]);

      const { printed } = await run(['--org', U.org, '--confirm']);

      expect(printed).toContain('  texts moved: 0');
      expect(await snapshot([U.org])).toEqual(before);
    });

    it('a run stopped at any write, then run again, ends as one clean run does', async () => {
      await stoppedAtEveryWriteEndsAsOneCleanRun(seedUnsentReplyScenario, unsentReplySplitAsExpected, UNSENT_REPLY_ALERTS);
    }, 600_000);
  });

  it('refuses a company that is not an id, before reading anything', async () => {
    const { result, printed } = await run(['--org', 'not-an-id', '--confirm']);
    expect(result).toEqual({ ok: false, error: '--org takes a company id; not one: "not-an-id".' });
    expect(printed).toEqual(['--org takes a company id; not one: "not-an-id".']);
  });
});
