#!/usr/bin/env tsx
/**
 * One-time split of existing text conversations by their pair of numbers (#3019, parent #3013, Q38). Run by hand, once
 * per environment, after the migration that adds message_threads.other_party_e164 / our_number_e164 and after the #3014
 * fill-in of messages.other_party_e164. It is never scheduled: every new text finds or creates the conversation for its
 * pair (lib/ctm/smsThread.ts). Until it runs, a conversation from before pairs keeps taking the texts of the pairs it
 * already holds (before the #3014 fill-in, its customer's next pair), never another pair's (findConversationFromBeforePairs).
 *
 * Which conversations: a customer's and an unknown number's (channel sms, no vendor, no member of staff, kind customer or
 * none). Staff, vendor and group conversations are left as they are.
 *
 * Each text's pair is its other party's number (messages.other_party_e164) and the company number it went through
 * (messages.phone_number_id), the main line when it has none (the company's default number, else its oldest active one).
 * A reply that was skipped, failed or is still queued has no company number stored (the send route stores it only once a
 * text goes out), so it never decides a pair by itself (Ran's rulings, 2026-11-06): it goes to its conversation's own pair.
 * Inside a keyed conversation, a text with no company number and the conversation's own other party is the conversation's
 * own (its key). Elsewhere such a reply takes the company number of the conversation's latest text with the same other
 * party that has one; when that other party has none, the company number of the conversation's latest text of any other
 * party that has one; the main line only when no text in the conversation has a company number.
 *
 * Each conversation has its own pair: a keyed one its key; one not keyed yet, the pair of its latest placed text that is
 * not such a reply (the latest placed text when every one is). The
 * conversations are worked OLDEST FIRST, keyed or not, so each pair's conversation is the oldest one that held its texts
 * and keeps that conversation's customer. For each conversation:
 *   - it keeps the texts of its own pair; one not keyed yet is keyed by that pair;
 *   - the texts of each other pair move to that pair's conversation, made for it (a copy of the conversation's customer,
 *     lead, title and lane) when there is none yet;
 *   - a text with no other party's number stays with the conversation's own texts;
 *   - when its own pair already has a conversation no newer than it (keyed earlier by live traffic or a run, or made for
 *     the pair from an older conversation's texts), its texts move there too, and the emptied conversation is removed;
 *     its alerts then open the conversation its texts went to. A keyed conversation newer than one holding its pair's
 *     texts so joins the older one.
 * A customer's conversation and one filed on nobody are never joined (a person who reaches no customer on the number keeps
 * the one filed on nobody, re-audit NV-vp3-1).
 *
 * Safe to stop at any point and run again: each conversation's work (keying it, moving its texts out, removing it when
 * emptied) commits in ONE transaction, and what is left to do is worked out from the data on every run, never from a
 * mark. A keyed conversation that holds another pair's texts (a text that landed in it while a run was going) has them
 * moved by the next run.
 *
 * Every text is kept. Read markers follow their texts: a conversation made for a pair carries each person's marker as it
 * was; when texts join a conversation that already has texts, each person keeps the earliest marker that leaves every
 * text they had not read still unread (no text turns read). The unread count is worked out from those markers, so it
 * follows the texts too. A conversation's place in the inbox (its last activity) is kept.
 *
 * DRY RUN BY DEFAULT: it prints the split counts and writes nothing. It writes only with --confirm. A second run changes
 * nothing. Generic: no company is named here; the companies are an argument (--org, or --all for every company).
 *
 * ALL work for a company runs inside runWithOrg(orgId) (see ctm-backfill.ts for why).
 *
 * Usage:
 *   npm run texts:split-conversations-by-pair -- --org <uuid> [--org <uuid>]    dry run, those companies
 *   npm run texts:split-conversations-by-pair -- --all                          dry run, every company
 *   ... add --confirm to write.
 *
 * Exit code 0 = completed, 1 = refused or failed.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../src/lib/prisma';
import { mainLineE164, UNSENT_REPLY_STATUSES } from '../src/lib/ctm/smsThread';
import { runUnscoped, runWithOrg } from '../src/lib/tenant-context';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The conversations a pair keys (the same set lib/ctm/smsThread.ts keys). */
const PAIR_KEYED_THREAD: Prisma.MessageThreadWhereInput = {
  channel: 'sms',
  vendor_id: null,
  user_id: null,
  OR: [{ kind: null }, { kind: 'customer' }],
};

export interface PairSplitCounts {
  conversations_examined: number;
  conversations_keyed_in_place: number;
  conversations_made_for_a_pair: number;
  conversations_joined_and_removed: number;
  texts_moved: number;
  read_markers_copied: number;
  read_markers_joined: number;
  conversations_left_as_they_are: number;
}

const zeroCounts = (): PairSplitCounts => ({
  conversations_examined: 0,
  conversations_keyed_in_place: 0,
  conversations_made_for_a_pair: 0,
  conversations_joined_and_removed: 0,
  texts_moved: 0,
  read_markers_copied: 0,
  read_markers_joined: 0,
  conversations_left_as_they_are: 0,
});

export interface PairSplitDeps {
  prisma: PrismaClient;
  print: (line: string) => void;
}

export type PairSplitResult =
  | { ok: true; confirmed: boolean; counts: PairSplitCounts }
  | { ok: false; error: string };

export function parsePairSplitArgs(argv: string[]): { ok: true; orgIds: string[] | 'all'; confirm: boolean } | { ok: false; error: string } {
  const known = new Set(['--org', '--all', '--confirm']);
  const orgIds: string[] = [];
  const notIds: string[] = [];
  const unknown: string[] = [];
  argv.forEach((a, i) => {
    if (a === '--org') {
      const id = argv[i + 1] ?? '';
      (UUID.test(id) ? orgIds : notIds).push(id);
    } else if (!known.has(a) && argv[i - 1] !== '--org') {
      unknown.push(a);
    }
  });
  if (notIds.length > 0) {
    return { ok: false, error: `--org takes a company id; not one: ${notIds.map((id) => JSON.stringify(id)).join(', ')}.` };
  }
  if (unknown.length > 0) return { ok: false, error: `Unknown argument(s): ${unknown.join(' ')}. Use --org <id> or --all, and --confirm.` };
  const all = argv.includes('--all');
  if (!all && orgIds.length === 0) return { ok: false, error: 'Name the companies with --org <id> (repeatable), or pass --all.' };
  if (all && orgIds.length > 0) return { ok: false, error: 'Pass either --org <id> or --all, not both.' };
  return { ok: true, orgIds: all ? 'all' : orgIds, confirm: argv.includes('--confirm') };
}

interface ThreadRow {
  id: string;
  customer_id: string | null;
  lead_id: string | null;
  title: string | null;
  subtitle: string | null;
  campaign_type: string;
  kind: string | null;
  archived: boolean | null;
  other_party_e164: string | null;
  our_number_e164: string | null;
  created_at: Date;
  updated_at: Date;
}

interface TextRow {
  id: string;
  ts: Date;
  direction: string;
  status: string | null;
  other_party_e164: string | null;
  phone_number_id: string | null;
}

/** A reply that did not go out (skipped, failed or still queued), so the send route stored no company number on it. */
const isUnsentReply = (m: TextRow) =>
  m.direction === 'out' && m.phone_number_id == null && (UNSENT_REPLY_STATUSES as readonly string[]).includes(m.status ?? '');

interface Pair {
  otherPartyE164: string;
  ourNumberE164: string | null;
}

/** A conversation's home key: the pair, and whether it is filed on a customer (the two are never joined). */
const homeKey = (filed: boolean, p: Pair) => `${filed ? 'customer' : 'nobody'}|${p.otherPartyE164}|${p.ourNumberE164 ?? ''}`;

/** A home: a conversation that holds a pair's texts, existing or made by this run. */
type Home = { kind: 'existing'; id: string; createdAt: Date } | { kind: 'new'; pair: Pair; template: ThreadRow; id?: string };

/** One planned move: these texts of `from` go to `to`. */
interface Move {
  from: ThreadRow;
  to: Home;
  texts: TextRow[];
}

/**
 * One conversation's work, committed together: keyed in place by its own pair (when that pair has no conversation yet),
 * its other pairs' texts moved out, and removed when its own pair's texts joined another conversation.
 */
interface Unit {
  thread: ThreadRow;
  keyAs?: Pair;
  moves: Move[];
  removeTo?: Home;
}

/** Split one company's conversations (or count what would be split, without --confirm). */
export async function splitOrg(db: PrismaClient, orgId: string, confirm: boolean): Promise<PairSplitCounts> {
  return runWithOrg(orgId, async () => {
    const counts = zeroCounts();
    const mainLine = await mainLineE164(db, orgId);
    const numberById = new Map(
      (await db.phoneNumber.findMany({ where: { organization_id: orgId }, select: { id: true, e164: true } })).map((n) => [n.id, n.e164]),
    );
    const pairOf = (t: TextRow): Pair | null =>
      t.other_party_e164
        ? { otherPartyE164: t.other_party_e164, ourNumberE164: (t.phone_number_id ? numberById.get(t.phone_number_id) : null) ?? mainLine }
        : null;

    const threads: ThreadRow[] = await db.messageThread.findMany({
      where: { organization_id: orgId, ...PAIR_KEYED_THREAD },
      select: {
        id: true, customer_id: true, lead_id: true, title: true, subtitle: true, campaign_type: true, kind: true, archived: true,
        other_party_e164: true, our_number_e164: true, created_at: true, updated_at: true,
      },
      // The order the live find-or-create picks a pair's conversation in (findPairConversation): the first is the home.
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    });
    counts.conversations_examined = threads.length;

    const homes = new Map<string, Home>();
    const textsOf = async (threadId: string): Promise<TextRow[]> =>
      db.message.findMany({
        where: { organization_id: orgId, thread_id: threadId },
        select: { id: true, ts: true, direction: true, status: true, other_party_e164: true, phone_number_id: true },
        orderBy: [{ ts: 'asc' }, { id: 'asc' }],
      });
    const keyOf = (t: ThreadRow): Pair | null =>
      t.other_party_e164 != null ? { otherPartyE164: t.other_party_e164, ourNumberE164: t.our_number_e164 } : null;
    // The pair of each of a conversation's texts (`texts` oldest first). The send route stores the company number only once
    // a text goes out, so a reply that was skipped, failed or is still queued has none, and it left (or would leave) from
    // the conversation's own pair, not from today's main line. In a keyed conversation, a text with no company number and
    // the conversation's own other party is the conversation's own (its key). Elsewhere such a reply takes the company
    // number of the conversation's latest text with the same other party that has one; when that other party has none, the
    // company number of the conversation's latest text that has one, whatever its other party; the main line only when no
    // text in the conversation has a company number (smsThread.ts findConversationFromBeforePairs reads it the same way).
    const pairsIn = (t: ThreadRow, texts: TextRow[]): ((m: TextRow) => Pair | null) => {
      const key = keyOf(t);
      const numberOf = (m: TextRow) => numberById.get(m.phone_number_id!) ?? mainLine;
      const latestNumber = new Map<string, string | null>();
      let latestOfAny: string | null | undefined;
      for (const m of texts) {
        if (m.phone_number_id == null) continue;
        latestOfAny = numberOf(m);
        if (m.other_party_e164) latestNumber.set(m.other_party_e164, numberOf(m));
      }
      return (m) => {
        if (m.other_party_e164 && m.phone_number_id == null) {
          if (key && m.other_party_e164 === key.otherPartyE164) return key;
          if (isUnsentReply(m)) {
            const ours = latestNumber.has(m.other_party_e164) ? latestNumber.get(m.other_party_e164) : latestOfAny;
            if (ours !== undefined) return { ...pairOf(m)!, ourNumberE164: ours };
          }
        }
        return pairOf(m);
      };
    };

    // A conversation already keyed holds its pair (the oldest one per pair; a later one with the same pair joins it) -
    // unless an OLDER conversation holds texts of that pair: then the older one gives the pair its conversation (itself
    // when the pair is its own, else a conversation made for the pair as a copy of it), and the newer one joins it.
    // Every joined or made conversation so keeps the older conversation's customer. A conversation made for a pair takes
    // its template's created date, so on a later run it is not newer than its template and keeps its texts.
    for (const t of threads) {
      const key = keyOf(t);
      if (key && !homes.has(homeKey(t.customer_id != null, key))) {
        homes.set(homeKey(t.customer_id != null, key), { kind: 'existing', id: t.id, createdAt: t.created_at });
      }
    }
    const homeFor = (t: ThreadRow, key: string, pair: Pair, own: boolean): Home => {
      const home = homes.get(key);
      if (home && !(home.kind === 'existing' && home.createdAt > t.created_at)) return home;
      const taken: Home = own ? { kind: 'existing', id: t.id, createdAt: t.created_at } : { kind: 'new', pair, template: t };
      homes.set(key, taken);
      return taken;
    };

    // One unit per conversation, worked out from its texts as they are now, OLDEST FIRST, keyed or not, so a pair's
    // conversation is keyed (or made) before any newer conversation's texts join it.
    const units: Unit[] = [];
    for (const t of threads) {
      const texts = await textsOf(t.id);
      const pairIn = pairsIn(t, texts);
      const placed = texts.filter((m) => pairIn(m) != null);
      // A reply that did not go out never decides the pair of a conversation not keyed yet: its latest other text does.
      const deciding = placed.filter((m) => !isUnsentReply(m));
      const decider = deciding[deciding.length - 1] ?? placed[placed.length - 1];
      const ownPair = keyOf(t) ?? (decider ? pairIn(decider)! : null);
      if (ownPair == null) {
        counts.conversations_left_as_they_are += 1;
        continue;
      }
      const filed = t.customer_id != null;
      const ownKey = homeKey(filed, ownPair);
      const byKey = new Map<string, { pair: Pair; texts: TextRow[] }>();
      for (const m of texts) {
        const p = pairIn(m);
        const key = p ? homeKey(filed, p) : ownKey;
        const group = byKey.get(key) ?? { pair: p ?? ownPair, texts: [] };
        group.texts.push(m);
        byKey.set(key, group);
      }
      const unit: Unit = { thread: t, moves: [] };
      const ownHome = homeFor(t, ownKey, ownPair, true);
      const isHome = ownHome.kind === 'existing' && ownHome.id === t.id;
      // Its own pair's conversation, not keyed yet: keyed in place by that pair.
      if (isHome && keyOf(t) == null) unit.keyAs = ownPair;
      for (const [key, group] of byKey) {
        if (key === ownKey && isHome) continue;
        unit.moves.push({ from: t, to: homeFor(t, key, group.pair, false), texts: group.texts });
      }
      if (!isHome) unit.removeTo = ownHome;
      if (unit.keyAs || unit.moves.length > 0 || unit.removeTo) units.push(unit);
    }
    const moves = units.flatMap((u) => u.moves);

    counts.conversations_keyed_in_place = units.filter((u) => u.keyAs).length;
    counts.conversations_made_for_a_pair = [...homes.values()].filter((h) => h.kind === 'new').length;
    counts.conversations_joined_and_removed = units.filter((u) => u.removeTo).length;
    counts.texts_moved = moves.reduce((n, m) => n + m.texts.length, 0);

    // Read markers: a move into a conversation made for it copies them; a move into one with texts joins them.
    const markersOf = async (threadId: string) =>
      db.messageThreadReadState.findMany({ where: { organization_id: orgId, thread_id: threadId }, select: { user_id: true, read_at: true } });
    const firstToNew = new Set<Move>();
    const seenNew = new Set<Home>();
    for (const m of moves) {
      if (m.to.kind === 'new' && !seenNew.has(m.to)) {
        seenNew.add(m.to);
        firstToNew.add(m);
      }
    }
    for (const m of moves) {
      const n = (await markersOf(m.from.id)).length;
      if (firstToNew.has(m)) counts.read_markers_copied += n;
      else counts.read_markers_joined += n;
    }

    if (!confirm) return counts;

    // Writes: ONE transaction per conversation (keying it, moving its texts out, removing it when emptied), so a run that
    // stops leaves every conversation either done or as it was, and the next run finishes the job. A move takes only the
    // texts read above: a text that lands in the conversation since stays there until the next run moves it.
    for (const unit of units) {
      await db.$transaction(async (tx) => {
        if (unit.keyAs) {
          await tx.messageThread.updateMany({
            where: { id: unit.thread.id, organization_id: orgId, other_party_e164: null },
            // Its place in the inbox (last activity) is kept.
            data: { other_party_e164: unit.keyAs.otherPartyE164, our_number_e164: unit.keyAs.ourNumberE164, updated_at: unit.thread.updated_at },
          });
        }
        for (const m of unit.moves) await moveTexts(tx, orgId, m, firstToNew.has(m));
        if (unit.removeTo) {
          const targetId = await homeIdFor(tx, orgId, unit.removeTo);
          // Its alerts open the conversation its texts went to.
          await tx.notification.updateMany({
            where: { organization_id: orgId, object_type: 'MESSAGE_THREAD', object_id: unit.thread.id },
            data: { object_id: targetId },
          });
          // Only when nothing landed in it since it was read (its read markers go with it).
          await tx.messageThread.deleteMany({ where: { id: unit.thread.id, organization_id: orgId, messages: { none: {} } } });
        }
      });
    }
    return counts;
  });
}

/** Moves these texts of `m.from` into its home, with their read markers (copied into a conversation made for them, else joined). */
async function moveTexts(tx: Prisma.TransactionClient, orgId: string, m: Move, fresh: boolean): Promise<void> {
  const targetId = await homeIdFor(tx, orgId, m.to);
  const sourceMarkers = await tx.messageThreadReadState.findMany({
    where: { organization_id: orgId, thread_id: m.from.id },
    select: { user_id: true, read_at: true },
  });
  if (fresh) {
    for (const r of sourceMarkers) {
      await tx.messageThreadReadState.create({
        data: { thread_id: targetId, user_id: r.user_id, read_at: r.read_at, organization_id: orgId },
      });
    }
  } else {
    await joinMarkers(tx, orgId, targetId, sourceMarkers, m.texts);
  }
  const ids = m.texts.map((t) => t.id);
  await tx.message.updateMany({ where: { organization_id: orgId, thread_id: m.from.id, id: { in: ids } }, data: { thread_id: targetId } });
  // Its place in the inbox (last activity): a conversation made for the pair takes its latest text's time; one that
  // already held texts keeps its own, or takes the later one of the texts that joined it.
  const latestMoved = m.texts.reduce((a, t) => (t.ts > a ? t.ts : a), new Date(0));
  const target = await tx.messageThread.findFirstOrThrow({ where: { id: targetId, organization_id: orgId }, select: { updated_at: true } });
  const lastActivity = fresh ? latestMoved : new Date(Math.max(target.updated_at.getTime(), latestMoved.getTime()));
  await tx.messageThread.updateMany({ where: { id: targetId, organization_id: orgId }, data: { updated_at: lastActivity } });
}

/** The id of a home, making the conversation the first time a new one is asked for. */
async function homeIdFor(tx: Prisma.TransactionClient, orgId: string, home: Home): Promise<string> {
  if (home.kind === 'existing') return home.id;
  if (home.id) return home.id;
  const t = home.template;
  const made = await tx.messageThread.create({
    data: {
      organization_id: orgId,
      channel: 'sms',
      campaign_type: t.campaign_type,
      kind: t.kind,
      customer_id: t.customer_id,
      lead_id: t.lead_id,
      title: t.title,
      subtitle: t.subtitle,
      archived: t.archived,
      other_party_e164: home.pair.otherPartyE164,
      our_number_e164: home.pair.ourNumberE164,
      created_at: t.created_at,
      updated_at: t.updated_at,
    },
    select: { id: true },
  });
  home.id = made.id;
  return made.id;
}

/**
 * Joins the read markers of texts that move into a conversation that already holds texts. A text is unread for a person
 * when it is incoming and newer than their marker (no marker: every incoming text). Each person keeps the latest marker
 * that leaves every text they had not read unread, in both halves: the earlier of the two markers, where a half they hold
 * no marker on counts as "just before its first incoming text". A person with no marker on either half keeps none.
 */
async function joinMarkers(
  tx: Prisma.TransactionClient,
  orgId: string,
  targetId: string,
  sourceMarkers: { user_id: string; read_at: Date }[],
  moving: TextRow[],
): Promise<void> {
  const targetMarkers = await tx.messageThreadReadState.findMany({
    where: { organization_id: orgId, thread_id: targetId },
    select: { user_id: true, read_at: true },
  });
  const firstIncoming = (texts: { direction: string; ts: Date }[]) =>
    texts.filter((t) => t.direction !== 'out').reduce<Date | null>((a, t) => (a == null || t.ts < a ? t.ts : a), null);
  const targetTexts = await tx.message.findMany({
    where: { organization_id: orgId, thread_id: targetId, direction: { not: 'out' } },
    select: { direction: true, ts: true },
    orderBy: { ts: 'asc' },
    take: 1,
  });
  const bound = (marker: Date | undefined, first: Date | null): number =>
    marker ? marker.getTime() : first ? first.getTime() - 1 : Number.POSITIVE_INFINITY;
  const people = new Set([...sourceMarkers, ...targetMarkers].map((r) => r.user_id));
  for (const userId of people) {
    const mine = targetMarkers.find((r) => r.user_id === userId)?.read_at;
    const theirs = sourceMarkers.find((r) => r.user_id === userId)?.read_at;
    let at = Math.min(bound(mine, firstIncoming(targetTexts)), bound(theirs, firstIncoming(moving)));
    // No incoming text on either side: nothing can be unread, so the marker they held stands.
    if (!Number.isFinite(at)) at = Math.min(...[mine, theirs].filter((d): d is Date => d != null).map((d) => d.getTime()));
    await tx.messageThreadReadState.upsert({
      where: { thread_id_user_id: { thread_id: targetId, user_id: userId } },
      create: { thread_id: targetId, user_id: userId, read_at: new Date(at), organization_id: orgId },
      update: { read_at: new Date(at) },
    });
  }
}

/** The script's public entry: parse the arguments, run each company, print the split counts. */
export async function runPairSplit(argv: string[], deps: PairSplitDeps): Promise<PairSplitResult> {
  const args = parsePairSplitArgs(argv);
  if (!args.ok) {
    deps.print(args.error);
    return args;
  }
  const orgIds =
    args.orgIds === 'all'
      ? (await runUnscoped(() => deps.prisma.organization.findMany({ select: { id: true }, orderBy: { id: 'asc' } }))).map((o) => o.id)
      : args.orgIds;

  deps.print(`Text conversations split by pair of numbers - ${args.orgIds === 'all' ? 'every company' : `${orgIds.length} company(ies)`}`);
  deps.print(args.confirm ? 'Writing (--confirm).' : 'Dry run: nothing is written. Re-run with --confirm to write.');

  const totals = zeroCounts();
  for (const orgId of orgIds) {
    const counts = await splitOrg(deps.prisma, orgId, args.confirm);
    for (const key of Object.keys(totals) as Array<keyof PairSplitCounts>) totals[key] += counts[key];
  }

  const will = args.confirm ? '' : ' (to be)';
  deps.print(`  conversations examined: ${totals.conversations_examined}`);
  deps.print(`  conversations keyed by their own pair${will}: ${totals.conversations_keyed_in_place}`);
  deps.print(`  conversations made for a pair${will}: ${totals.conversations_made_for_a_pair}`);
  deps.print(`  conversations joined into their pair's and removed${will}: ${totals.conversations_joined_and_removed}`);
  deps.print(`  texts moved${will}: ${totals.texts_moved}`);
  deps.print(`  read markers copied${will}: ${totals.read_markers_copied}`);
  deps.print(`  read markers joined${will}: ${totals.read_markers_joined}`);
  deps.print(`  conversations left as they are (no text with a number): ${totals.conversations_left_as_they_are}`);
  return { ok: true, confirmed: args.confirm, counts: totals };
}

// Only run when executed directly (not when imported by tests).
if (require.main === module) {
  runPairSplit(process.argv.slice(2), { prisma: prisma as unknown as PrismaClient, print: (line) => console.log(line) })
    .then((result) => process.exit(result.ok ? 0 : 1))
    .catch((err) => {
      console.error('Split failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
