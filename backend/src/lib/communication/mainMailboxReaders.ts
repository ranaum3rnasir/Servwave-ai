import type { Request } from 'express';
import { prisma } from '../prisma';
import { tenantWhere } from '../tenant';

/**
 * The people who read the company's main mailbox (Roles & Permissions PRD 10, S10.8): the ones a holder of Company
 * settings links on the Sender Address page. This module owns the list; WHO READS the main mailbox, which also counts
 * people on Communication scope All and, while nobody active is linked, the Admins, is
 * decided in M11 (`communicationScope.ts`), from the same table.
 *
 * A link says who handles one mailbox, as a company number's links do; it is not a switch. A person who is not active
 * drops off every read here and in M11 while they are inactive: their link row stays, so nothing needs to run when
 * someone is deactivated, whichever path deactivates them.
 */

export const READERS_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

export interface ReaderPageQuery {
  search?: string;
  offset?: number;
  limit?: number;
}

export interface PersonPage {
  items: { id: string; name: string }[];
  total: number;
  offset: number;
  limit: number;
}

const pageOf = (query: ReaderPageQuery) => ({
  limit: Math.min(Math.max(Math.trunc(query.limit ?? READERS_PAGE_SIZE) || READERS_PAGE_SIZE, 1), MAX_PAGE_SIZE),
  offset: Math.max(Math.trunc(query.offset ?? 0) || 0, 0),
});

const fullName = (u: { first_name: string; last_name: string }) => `${u.first_name} ${u.last_name}`.trim();

/** Every word of the search must be part of the person's first or last name. */
function nameMatches(search: string | undefined) {
  const words = (search ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 5);
  return words.length === 0
    ? {}
    : {
        AND: words.map((w) => ({
          OR: [
            { first_name: { contains: w, mode: 'insensitive' as const } },
            { last_name: { contains: w, mode: 'insensitive' as const } },
          ],
        })),
      };
}

const BY_NAME = [{ first_name: 'asc' as const }, { last_name: 'asc' as const }, { id: 'asc' as const }];

/** The company's main mailbox, or null for a company that has none yet. */
export async function mainMailboxOf(req: Request): Promise<{ id: string } | null> {
  return prisma.mailbox.findFirst({ where: { ...tenantWhere(req), kind: 'main' }, select: { id: true } });
}

/**
 * The ids of the active people linked to the company's main mailbox: the lookup an alert uses, which has no request (a customer's
 * reply that no one on its record can take goes to them). A person who is not active is left out; their link stays.
 */
export async function linkedReaderIds(organizationId: string): Promise<string[]> {
  const rows = await prisma.mailboxReader.findMany({
    where: { organization_id: organizationId, mailbox: { kind: 'main' }, user: { is_active: true } },
    select: { user_id: true },
  });
  return rows.map((row) => row.user_id);
}

/** The active people linked to the main mailbox, by name. */
export async function linkedReaders(req: Request, query: ReaderPageQuery): Promise<PersonPage> {
  const { limit, offset } = pageOf(query);
  const main = await mainMailboxOf(req);
  if (!main) return { items: [], total: 0, offset, limit };
  const where = {
    ...tenantWhere(req), is_active: true, ...nameMatches(query.search), mailbox_reads: { some: { mailbox_id: main.id } },
  };
  const [total, rows] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({ where, select: { id: true, first_name: true, last_name: true }, orderBy: BY_NAME, skip: offset, take: limit }),
  ]);
  return { items: rows.map((u) => ({ id: u.id, name: fullName(u) })), total, offset, limit };
}

/** The active people who are not linked yet: the picker's list, searched by name and paged. */
export async function readerCandidates(req: Request, query: ReaderPageQuery): Promise<PersonPage> {
  const { limit, offset } = pageOf(query);
  const main = await mainMailboxOf(req);
  const where = {
    ...tenantWhere(req), is_active: true, ...nameMatches(query.search),
    ...(main ? { mailbox_reads: { none: { mailbox_id: main.id } } } : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({ where, select: { id: true, first_name: true, last_name: true }, orderBy: BY_NAME, skip: offset, take: limit }),
  ]);
  return { items: rows.map((u) => ({ id: u.id, name: fullName(u) })), total, offset, limit };
}

export type LinkResult =
  | { ok: true; mailboxId: string; changed: boolean }
  | { ok: false; reason: 'no_main_mailbox' | 'not_found' | 'inactive' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Link an active person of the company to the main mailbox. Linking someone already linked changes nothing. */
export async function linkReader(req: Request, userId: string): Promise<LinkResult> {
  const main = await mainMailboxOf(req);
  if (!main) return { ok: false, reason: 'no_main_mailbox' };
  if (!UUID.test(userId)) return { ok: false, reason: 'not_found' };
  const person = await prisma.user.findFirst({ where: { ...tenantWhere(req), id: userId }, select: { is_active: true } });
  if (!person) return { ok: false, reason: 'not_found' };
  if (!person.is_active) return { ok: false, reason: 'inactive' };
  const made = await prisma.mailboxReader.createMany({
    data: [{ organization_id: req.user!.organization_id, mailbox_id: main.id, user_id: userId, linked_by_user_id: req.user!.id }],
    skipDuplicates: true,
  });
  return { ok: true, mailboxId: main.id, changed: made.count > 0 };
}

/** Unlink a person. Someone who is not linked (or not of this company) is not an error and changes nothing. */
export async function unlinkReader(req: Request, userId: string): Promise<{ mailboxId: string | null; changed: boolean }> {
  const main = await mainMailboxOf(req);
  if (!main || !UUID.test(userId)) return { mailboxId: main?.id ?? null, changed: false };
  const gone = await prisma.mailboxReader.deleteMany({
    where: { ...tenantWhere(req), mailbox_id: main.id, user_id: userId },
  });
  return { mailboxId: main.id, changed: gone.count > 0 };
}
