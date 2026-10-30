import type { Request } from 'express';
import { prisma } from '../prisma';
import { tenantWhere } from '../tenant';
import { emailFeatureOn } from './emailFeature';
import {
  emailSectionForReq, mailboxSelectionFor, selectionNarrowing,
  type CommunicationScopeValue, type MailboxSelection,
} from './communicationScope';
import { needsReviewCountsForReq, needsReviewVisibilityForReq } from './needsReview';

/**
 * The Email page's mailbox list and its unread counts (Roles & Permissions PRD 10, S10.7).
 *
 * The list is the rail's top: "My mailbox", each mailbox handed to the person, and, under Communication scope All, the
 * main mailbox, "All mailboxes" and a paged, searchable list of every person's mailbox. Every number on it comes from the
 * same filter as the Email list and the Email menu badge (`emailSectionForReq`, M11's one mailbox rule), so a count never
 * promises a conversation the list will not show.
 *
 * The cost does not grow with the number of mailboxes in the company, nor with the mail in them, for the hosted database's
 * one connection: under "Linked to me" a count for the section, one for "My mailbox" and one per mailbox the
 * person holds (before: every unread row of the section, loaded and folded in memory), under All one grouped count for every
 * mailbox, one total, one "My mailbox" count and the page of people. Nothing is asked per mailbox of the company.
 */

type Where = Record<string, unknown>;

/** What "unread email" means for one person: an inbox message they have no read mark on. Read state is per person. */
export function unreadInboxWhere(userId: string): Where {
  return { folder: 'inbox', email_read_states: { none: { user_id: userId } } };
}

export const PEOPLE_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

export interface MailboxListQuery {
  /** The mailbox the page is showing: "mine", "all" or a mailbox id. Anything the person may not open reads "mine". */
  selected?: unknown;
  /** Narrows the people under All by name. */
  search?: string;
  offset?: number;
  limit?: number;
}

export interface MailboxListAnswer {
  scope: CommunicationScopeValue;
  /** The selection the page should show: "mine", "all" or a mailbox id. */
  selected: string;
  /** What to call the picked mailbox when it is one person's or the main one ("Jane Smith's mailbox"); null otherwise. */
  selected_label: string | null;
  /** The unread count of the selection ("My mailbox", every mailbox or the picked one), whatever page of people it sits on. */
  selected_unread: number;
  /** Everything the person's scope lists, unread: the number on the Email menu. */
  total_unread: number;
  mine: { id: string | null; unread: number };
  held: { id: string; name: string; unread: number }[];
  main: { id: string; unread: number } | null;
  /**
   * The Needs review folder's counts (S10.18), from the same filter as its list: the held messages in the selection, and in every
   * mailbox the person can see. Held mail is never unread mail: it is in no unread count above.
   */
  needs_review: { selected: number; total: number };
  people: { items: { id: string; name: string; unread: number; active: boolean }[]; total: number; offset: number; limit: number } | null;
}

const selectionValue = (s: MailboxSelection): string => (s.kind === 'mailbox' ? s.id : s.kind);

const FORMER_PERSON = 'Former team member';

/** "Jane Smith's mailbox", or "Main mailbox": the name the Email page gives the mailbox it is showing. */
async function labelOf(req: Request, selection: MailboxSelection): Promise<string | null> {
  if (selection.kind !== 'mailbox') return null;
  const box = await prisma.mailbox.findFirst({
    where: { id: selection.id, ...tenantWhere(req) },
    select: { kind: true, user: { select: { first_name: true, last_name: true } } },
  });
  if (!box) return null;
  if (box.kind === 'main') return 'Main mailbox';
  return `${box.user ? `${box.user.first_name} ${box.user.last_name}`.trim() : FORMER_PERSON}'s mailbox`;
}

/** The unread inbox messages of every mailbox of the company, in one grouped read (the All view: nothing narrows it). */
async function unreadByMailboxAcrossTheCompany(req: Request): Promise<Map<string, number>> {
  const rows = await prisma.$queryRaw<{ mailbox_id: string | null; n: number }[]>`
    SELECT t.mailbox_id AS mailbox_id, COUNT(*)::int AS n
    FROM emails e
    JOIN email_threads t ON t.id = e.thread_id
    WHERE e.organization_id = ${req.user!.organization_id}::uuid
      AND e.folder = 'inbox'
      AND NOT EXISTS (SELECT 1 FROM email_read_states r WHERE r.email_id = e.id AND r.user_id = ${req.user!.id}::uuid)
    GROUP BY t.mailbox_id`;
  return new Map(rows.filter((r) => r.mailbox_id).map((r) => [r.mailbox_id as string, r.n]));
}

/** Every word of the search must be part of the person's first or last name. */
function nameMatches(search: string): Where {
  const words = search.trim().split(/\s+/).filter(Boolean).slice(0, 5);
  if (words.length === 0) return {};
  return {
    user: {
      AND: words.map((w) => ({
        OR: [
          { first_name: { contains: w, mode: 'insensitive' } },
          { last_name: { contains: w, mode: 'insensitive' } },
        ],
      })),
    },
  };
}

/** The list while the company's Email plan feature is off (PRD 10, S10.6): nothing to pick, nothing counted, nothing read. */
const HIDDEN_MAILBOX_LIST: MailboxListAnswer = {
  scope: 'linked_to_me', selected: 'mine', selected_label: null, selected_unread: 0, total_unread: 0,
  mine: { id: null, unread: 0 }, held: [], main: null, needs_review: { selected: 0, total: 0 }, people: null,
};

export async function mailboxListForReq(req: Request, query: MailboxListQuery): Promise<MailboxListAnswer> {
  if (!emailFeatureOn(req)) return HIDDEN_MAILBOX_LIST;
  const user = req.user!;
  const section = await emailSectionForReq(req);
  const { selection } = await mailboxSelectionFor(req, section, query.selected);
  const mineWhere = selectionNarrowing(section, { kind: 'mine' });
  const unread = unreadInboxWhere(user.id);
  const mine = { id: section.mailboxes.own, unread: 0 };
  const nameOf = (id: string, ownerName: string | null) => ({ id, name: ownerName ?? FORMER_PERSON });

  let totalUnread: number;
  let perMailbox: Map<string, number>;
  let people: MailboxListAnswer['people'] = null;
  let main: MailboxListAnswer['main'] = null;

  if (section.scope === 'all') {
    const limit = Math.min(Math.max(Math.trunc(query.limit ?? PEOPLE_PAGE_SIZE) || PEOPLE_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const offset = Math.max(Math.trunc(query.offset ?? 0) || 0, 0);
    const mailboxFilter = { ...tenantWhere(req), kind: 'user', status: { not: 'merged' }, ...nameMatches(query.search ?? '') };
    const [counts, total, mineUnread, mainBox, total_people, page] = await Promise.all([
      unreadByMailboxAcrossTheCompany(req),
      prisma.email.count({ where: { ...tenantWhere(req), ...unread } }),
      prisma.email.count({ where: { ...tenantWhere(req), AND: [mineWhere], ...unread } }),
      prisma.mailbox.findFirst({ where: { ...tenantWhere(req), kind: 'main' }, select: { id: true } }),
      prisma.mailbox.count({ where: mailboxFilter }),
      prisma.mailbox.findMany({
        where: mailboxFilter,
        select: { id: true, status: true, user: { select: { first_name: true, last_name: true, is_active: true } } },
        orderBy: [{ user: { first_name: 'asc' } }, { user: { last_name: 'asc' } }, { id: 'asc' }],
        skip: offset,
        take: limit,
      }),
    ]);
    totalUnread = total;
    perMailbox = counts;
    mine.unread = mineUnread;
    main = mainBox ? { id: mainBox.id, unread: counts.get(mainBox.id) ?? 0 } : null;
    people = {
      items: page.map((m) => ({
        ...nameOf(m.id, m.user ? `${m.user.first_name} ${m.user.last_name}`.trim() : null),
        unread: counts.get(m.id) ?? 0,
        active: m.user?.is_active ?? false,
      })),
      total: total_people,
      offset,
      limit,
    };
  } else {
    // Under "Linked to me": a count for the section, for "My mailbox" and for each mailbox held (a handful),
    // never the unread rows themselves, so the reads follow the mailboxes the person holds, not the mail in them.
    const inSection = { ...tenantWhere(req), AND: [section.where], ...unread };
    // The main mailbox is one more mailbox to count for a person who reads it (a link, or Manage roles and permissions while
    // nobody is linked), and none for a person who does not.
    const mainBox = section.mailboxes.main;
    const boxes = mainBox ? [...section.mailboxes.held, mainBox] : section.mailboxes.held;
    const [total, mineUnread, ...boxUnread] = await Promise.all([
      prisma.email.count({ where: inSection }),
      prisma.email.count({ where: { ...tenantWhere(req), AND: [section.where, mineWhere], ...unread } }),
      ...boxes.map((id) => prisma.email.count({ where: { ...inSection, AND: [section.where, selectionNarrowing(section, { kind: 'mailbox', id })] } })),
    ]);
    totalUnread = total;
    perMailbox = new Map(boxes.map((id, n) => [id, boxUnread[n]!]));
    mine.unread = mineUnread;
    main = mainBox ? { id: mainBox, unread: perMailbox.get(mainBox) ?? 0 } : null;
  }

  const review = await needsReviewCountsForReq(req, selection, await needsReviewVisibilityForReq(req, section));

  return {
    scope: section.scope,
    selected: selectionValue(selection),
    selected_label: await labelOf(req, selection),
    selected_unread: selection.kind === 'mine' ? mine.unread : selection.kind === 'all' ? totalUnread : perMailbox.get(selection.id) ?? 0,
    total_unread: totalUnread,
    mine,
    held: section.mailboxes.handedOver.map((m) => ({ ...nameOf(m.id, m.ownerName), unread: perMailbox.get(m.id) ?? 0 })),
    main,
    needs_review: { selected: review.selected, total: review.total },
    people,
  };
}
