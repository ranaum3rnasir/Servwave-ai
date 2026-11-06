/**
 * Spider's recipient sets (#3107): the list of people an alert told is stored ONCE, not inside every alert-log row.
 *
 * An alert-log row used to carry its own copy of the list (`spider_alerts.recipients`, about 8 KB for 60 people), so a
 * starting summary for 5,000 leads wrote tens of megabytes in one statement. Now the list is a row of
 * `spider_recipient_sets`, found by a hash of the list and reused while the list is unchanged, and an alert row points at
 * it with `recipient_set_id`. History reads the list through that link (history.ts); a row written before this keeps its
 * own copy in `recipients` and is read from there, exactly as it was.
 *
 * - The list is the History tab's: `[{ id, name, email, role, type }]` per person, never a phone number. It is stored as
 *   the alert row held it, so what History shows for a person (their name and role at the time, how they were chosen)
 *   does not change when the person does (rule S3).
 * - The order is not meaningful: Spider's recipient rule hands the people over in user id order (recipients.ts), and the
 *   list is stored in that order, so the hash is of the list sorted by user id. The same people always make the same set.
 * - A person renamed, given another role or chosen another way (the lead's owner instead of an Admin) is a different
 *   list, so a different set: the older alerts keep the list they told.
 * - Writing: a hash already stored is found by one read; the new ones go in with one INSERT ... ON CONFLICT DO NOTHING;
 *   a list a parallel run stored in between is found again by a second read. So two runs with the same list write ONE
 *   set, and a set is never written twice.
 *
 * Logs carry ids only.
 */
import { createHash, randomUUID } from 'crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { SpiderRecipient } from './recipients';
import { inChunks } from './pages';

type Db = PrismaClient | Prisma.TransactionClient;

/** One person of a stored list, as History shows them. */
export interface StoredRecipient {
  id: string;
  name: string;
  email: string;
  role: string;
  /** How the person was chosen: owner / user / admin. */
  type: string;
}

/** The list an alert row stores, in user id order. A person without a name is listed by their email. */
export function storedRecipientsOf(recipients: readonly SpiderRecipient[]): StoredRecipient[] {
  return recipients
    .map((r) => ({
      id: r.id,
      name: `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || r.email,
      email: r.email,
      role: r.role,
      type: r.chosen_as,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** A stable hash of a stored list: the same people, named and chosen the same way, always give the same hash. */
export function recipientSetHash(list: readonly StoredRecipient[]): string {
  const canonical = [...list]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((p) => [p.id, p.name, p.email, p.role, p.type]);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * The set id of each of these lists of one company, in the lists' order: stored sets are found by hash and new ones are
 * written (see the header). The lists are this company's alone: every read and write is scoped to `orgId`.
 */
export async function recipientSetIds(db: Db, orgId: string, lists: readonly (readonly SpiderRecipient[])[]): Promise<string[]> {
  const hashes: string[] = [];
  const toStore = new Map<string, StoredRecipient[]>();
  for (const recipients of lists) {
    const list = storedRecipientsOf(recipients);
    const hash = recipientSetHash(list);
    hashes.push(hash);
    if (!toStore.has(hash)) toStore.set(hash, list);
  }

  const idOf = new Map<string, string>();
  const find = async (wanted: string[]) => {
    for (const chunk of inChunks(wanted)) {
      const rows = await db.spiderRecipientSet.findMany({
        where: { organization_id: orgId, hash: { in: chunk } },
        select: { id: true, hash: true },
      });
      for (const r of rows) idOf.set(r.hash, r.id);
    }
  };

  await find([...toStore.keys()]);
  const missing = [...toStore.keys()].filter((h) => !idOf.has(h));
  if (missing.length > 0) {
    const written = await db.spiderRecipientSet.createManyAndReturn({
      data: missing.map((hash) => ({
        id: randomUUID(),
        organization_id: orgId,
        hash,
        recipients: toStore.get(hash)! as unknown as Prisma.InputJsonValue,
      })),
      skipDuplicates: true,
      select: { id: true, hash: true },
    });
    for (const r of written) idOf.set(r.hash, r.id);
    // A list a parallel run stored between our read and our write is skipped by the unique key: read it.
    await find(missing.filter((h) => !idOf.has(h)));
  }
  return hashes.map((h) => {
    const id = idOf.get(h);
    if (!id) throw new Error(`recipient set ${h.slice(0, 12)} for org ${orgId} was neither found nor written`);
    return id;
  });
}
