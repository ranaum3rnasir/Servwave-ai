#!/usr/bin/env tsx
/**
 * One-time fill-in of the OTHER party's number on texts stored before texts recorded it (#3014). Run by hand, once per
 * environment, after the migration that adds `messages.other_party_e164`. It is never scheduled: every new text stores
 * its own number (the send handler, the automation recorder and the incoming-text ingest).
 *
 * For each text with no number yet, the first source that names one, in this order:
 *   1. The phone system's stored event for the text (ctm_events, matched by the text's message id, from the company's
 *      phone-system account when the event names one). It is read the way the live ingest reads it (smsOtherPartyNumber),
 *      with the stored text's own direction: the sender of an inbound text, the destination of an outbound one. An event
 *      that names no direction, or the other direction, is skipped.
 *   2. The conversation's customer phone.
 *   3. The conversation's title, when it is a number (a conversation with a number nobody is on file for).
 * A source that names one of the company's own numbers (phone_numbers) is passed over. Texts none of them places stay
 * empty (a staff, vendor or group conversation, a customer with no phone). Only normalized E.164 numbers are written.
 *
 * DRY RUN BY DEFAULT: it prints the counts per source and writes nothing. It writes only with --confirm. Only texts that
 * have NO number yet are written, so a second run changes nothing. Generic: no company is named here; the company is an
 * argument.
 *
 * ALL work for a company runs inside runWithOrg(orgId) (see ctm-backfill.ts for why).
 *
 * Usage:
 *   npm run texts:fill-other-party-numbers -- --org <uuid> [--org <uuid>]     dry run, those companies
 *   npm run texts:fill-other-party-numbers -- --all                           dry run, every company
 *   ... add --confirm to write.
 *
 * Exit code 0 = completed, 1 = refused or failed.
 */
import type { PrismaClient } from '@prisma/client';
import { otherPartyNumber, ownNumbersOf } from '../src/lib/communication/otherPartyNumber';
import { activityDirection, smsOtherPartyNumber, unwrapActivity } from '../src/lib/ctm/ingest';
import { prisma } from '../src/lib/prisma';
import { runUnscoped, runWithOrg } from '../src/lib/tenant-context';

const BATCH = 500;
// Batches walk the ids upward; every real id sorts above the all-zero one.
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The webhook positions a text's events are stored under (ctm-webhook.controller.ts).
const TEXT_EVENT_TYPES = ['inbound_text', 'outbound_text', 'status_change', 'sms_status'];

export interface OtherPartyFillCounts {
  from_stored_event: number;
  from_customer_phone: number;
  from_conversation_title: number;
  left_empty: number;
}

export interface FillInDeps {
  prisma: PrismaClient;
  print: (line: string) => void;
}

export type FillInResult =
  | { ok: true; confirmed: boolean; counts: OtherPartyFillCounts }
  | { ok: false; error: string };

type Source = 'from_stored_event' | 'from_customer_phone' | 'from_conversation_title';

export function parseFillInArgs(argv: string[]): { ok: true; orgIds: string[] | 'all'; confirm: boolean } | { ok: false; error: string } {
  const orgIds: string[] = [];
  const notIds: string[] = [];
  argv.forEach((a, i) => {
    if (a !== '--org') return;
    const id = argv[i + 1] ?? '';
    (UUID.test(id) ? orgIds : notIds).push(id);
  });
  if (notIds.length > 0) {
    return { ok: false, error: `--org takes a company id; not one: ${notIds.map((id) => JSON.stringify(id)).join(', ')}.` };
  }
  const all = argv.includes('--all');
  if (!all && orgIds.length === 0) return { ok: false, error: 'Name the companies with --org <id> (repeatable), or pass --all.' };
  if (all && orgIds.length > 0) return { ok: false, error: 'Pass either --org <id> or --all, not both.' };
  return { ok: true, orgIds: all ? 'all' : orgIds, confirm: argv.includes('--confirm') };
}

/**
 * The number each of these texts' stored events names, by the text's message id. An event is read with the stored text's
 * own direction; an event that names no direction, or the other one, is not this text's record of who it went to or
 * came from, and is skipped (the text then falls through to the conversation).
 */
async function numbersFromStoredEvents(
  db: PrismaClient,
  texts: Map<string, 'in' | 'out'>,
  ownNumbers: Set<string>,
  accountId: string | null,
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (texts.size === 0) return found;
  // An event is stored under its own id (`<sid>:<position>`), which for a status change is NOT the text's message id,
  // so the event is found by the message id inside it. The payload may wrap the activity under `call`. The table has no
  // company column: an event that names a phone-system account must name this company's (a disconnected company has
  // none, and its texts' message ids are unique across companies, so the id alone ties the event to its text).
  const rows = await db.$queryRaw<Array<{ message_id: string; payload: Record<string, unknown> }>>`
    SELECT COALESCE(payload->'call'->>'message_id', payload->>'message_id') AS message_id, payload
    FROM ctm_events
    WHERE event_type = ANY(${TEXT_EVENT_TYPES}::text[])
      AND COALESCE(payload->'call'->>'message_id', payload->>'message_id') = ANY(${[...texts.keys()]}::text[])
      AND (
        ${accountId}::text IS NULL
        OR COALESCE(payload->'call'->>'account_id', payload->>'account_id') IS NULL
        OR COALESCE(payload->'call'->>'account_id', payload->>'account_id') = ${accountId}::text
      )
    ORDER BY processed_at ASC`;
  for (const row of rows) {
    if (found.has(row.message_id)) continue;
    const activity = unwrapActivity(row.payload as Record<string, any>);
    const direction = texts.get(row.message_id)!;
    if (activityDirection(activity) !== direction) continue;
    const number = otherPartyNumber(smsOtherPartyNumber(activity, direction), ownNumbers);
    if (number) found.set(row.message_id, number);
  }
  return found;
}

/** Fill in one company's texts (or count what would be filled, without --confirm). */
export async function fillInOrg(db: PrismaClient, orgId: string, confirm: boolean): Promise<OtherPartyFillCounts> {
  return runWithOrg(orgId, async () => {
    const counts: OtherPartyFillCounts = { from_stored_event: 0, from_customer_phone: 0, from_conversation_title: 0, left_empty: 0 };
    const company = await db.organization.findUnique({ where: { id: orgId }, select: { ctm_account_id: true } });
    const accountId = company?.ctm_account_id ? String(company.ctm_account_id) : null;
    // One of the company's own numbers is never the other party (the writers' own rule): a source that names one is
    // passed over.
    const ownNumbers = await ownNumbersOf(db, orgId);
    let lastId = NIL_UUID;
    for (;;) {
      const batch = await db.message.findMany({
        where: { organization_id: orgId, other_party_e164: null, id: { gt: lastId } },
        select: {
          id: true,
          direction: true,
          ctm_sms_id: true,
          thread: { select: { customer_id: true, title: true, customer: { select: { phone: true } } } },
        },
        orderBy: { id: 'asc' },
        take: BATCH,
      });
      if (batch.length === 0) break;
      lastId = batch[batch.length - 1].id;

      const fromEvents = await numbersFromStoredEvents(
        db,
        new Map(batch.flatMap((t) => (t.ctm_sms_id ? [[t.ctm_sms_id, t.direction === 'out' ? 'out' : 'in'] as const] : []))),
        ownNumbers,
        accountId,
      );
      for (const t of batch) {
        // The sources in order; the first that names a number that is not one of ours wins.
        const sources: Array<[Source, string | null | undefined]> = [
          ['from_stored_event', t.ctm_sms_id ? fromEvents.get(t.ctm_sms_id) : null],
          ['from_customer_phone', t.thread.customer_id ? otherPartyNumber(t.thread.customer?.phone, ownNumbers) : null],
          ['from_conversation_title', otherPartyNumber(t.thread.title, ownNumbers)],
        ];
        const hit = sources.find(([, n]) => n);
        if (!hit) {
          counts.left_empty += 1;
          continue;
        }
        const [source, number] = hit;
        counts[source] += 1;
        if (confirm) {
          // Only a text still without a number: a text that gained one since it was read keeps its own.
          await db.message.updateMany({
            where: { id: t.id, organization_id: orgId, other_party_e164: null },
            data: { other_party_e164: number },
          });
        }
      }
    }
    return counts;
  });
}

/** The script's public entry: parse the arguments, run each company, print the counts. */
export async function runFillIn(argv: string[], deps: FillInDeps): Promise<FillInResult> {
  const args = parseFillInArgs(argv);
  if (!args.ok) {
    deps.print(args.error);
    return args;
  }
  const orgIds =
    args.orgIds === 'all'
      ? (await runUnscoped(() => deps.prisma.organization.findMany({ select: { id: true }, orderBy: { id: 'asc' } }))).map((o) => o.id)
      : args.orgIds;

  deps.print(`Text other-party number fill-in - ${args.orgIds === 'all' ? 'every company' : `${orgIds.length} company(ies)`}`);
  deps.print(args.confirm ? 'Writing (--confirm).' : 'Dry run: nothing is written. Re-run with --confirm to write.');

  const totals: OtherPartyFillCounts = { from_stored_event: 0, from_customer_phone: 0, from_conversation_title: 0, left_empty: 0 };
  for (const orgId of orgIds) {
    const counts = await fillInOrg(deps.prisma, orgId, args.confirm);
    for (const key of Object.keys(totals) as Array<keyof OtherPartyFillCounts>) totals[key] += counts[key];
  }

  const verb = args.confirm ? 'filled' : 'to fill';
  deps.print(`  texts ${verb} from the phone system's stored event: ${totals.from_stored_event}`);
  deps.print(`  texts ${verb} from the conversation's customer phone: ${totals.from_customer_phone}`);
  deps.print(`  texts ${verb} from the conversation's title: ${totals.from_conversation_title}`);
  deps.print(`  texts left empty: ${totals.left_empty}`);
  return { ok: true, confirmed: args.confirm, counts: totals };
}

// Only run when executed directly (not when imported by tests).
if (require.main === module) {
  runFillIn(process.argv.slice(2), { prisma: prisma as unknown as PrismaClient, print: (line) => console.log(line) })
    .then((result) => process.exit(result.ok ? 0 : 1))
    .catch((err) => {
      console.error('Fill-in failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
