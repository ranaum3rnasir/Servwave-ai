import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { tenantWhere } from '../lib/tenant';
import { validationFailure } from '../middleware/validate';
import {
  validateParticipantRefs,
  resolveParticipantDisplay,
  ParticipantInput,
  ParticipantRow,
} from '../lib/calendar-entries/participants';
import {
  notifyCalendarEntryChange,
  notifyCalendarEntryDeleted,
  buildOldParticipantMap,
} from '../lib/calendar-entries/notify';

// ─── Zod Schemas ───────────────────────────────────────
//
// rrule/recurrence_until are RESERVED (spec §2, §8): the columns exist and are written null by
// the migration, but neither schema below accepts them. .strict() means a request that DOES
// send one is a 400, not a silently-dropped field — a reserved column that leaks into the
// accepted-input surface becomes a de-facto contract.

const participantSchema = z.object({
  kind: z.enum(['USER', 'CUSTOMER']),
  user_id: z.string().uuid().optional(),
  customer_id: z.string().uuid().optional(),
}).strict().refine(
  (p) => (p.kind === 'USER' ? (p.user_id != null && p.customer_id == null) : (p.customer_id != null && p.user_id == null)),
  { message: "kind === 'USER' requires user_id (and no customer_id); kind === 'CUSTOMER' requires customer_id (and no user_id)", path: ['kind'] },
);

// notify_customer / notify_message (slice 07, spec §5): the SAME flat-key convention
// job.controller.ts's assign()/visit routes already use for their own notify checkbox
// (notify_customer / notify_recipient_email / notify_cc_emails / notify_message), minus the
// two keys that do not apply here. No notify_recipient_email — the address is the
// participant's own saved email, with no per-send override, unlike the job family. No
// notify_cc_emails — a calendar entry can carry N participants where the job/walkthrough doors
// carry exactly one, and "cc everyone on N separate sends" has no defined meaning the spec
// states; out of scope for this pass (see the implementer's own report).
// notify_message is read ONLY for the SCHEDULED outcome (free text, spec §5) — the MOVED
// sender in lib/email.ts has no `message` parameter at all, so nothing here can ever reach it.
//
// THE KEY NAME IS THE HOUSE CONVENTION, NOT A SCOPE STATEMENT (product-owner change,
// 2026-08-25 — "I actually wanted all participants to be notified"). `notify_customer` now
// governs the participant email channel for BOTH kinds on this route. It keeps the name the
// six other notify doors in job.controller.ts / lead.controller.ts use for the same checkbox,
// rather than diverging one route's wire key from the convention every notify composer in the
// frontend already speaks; the behaviour it controls is documented on
// NotifyChangeArgs.notifyParticipantsEmail.
const notifyFields = {
  notify_customer: z.boolean().optional(),
  notify_message: z.string().max(5000).optional(),
};

export const createCalendarEntrySchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  start: z.string().datetime({ offset: true }),
  end: z.string().datetime({ offset: true }),
  is_all_day: z.boolean().optional(),
  // Zero participants is valid and expected (spec §2) — this stays optional, not min(1).
  participants: z.array(participantSchema).optional(),
  ...notifyFields,
}).strict().refine(
  // Strictly AFTER, not >= (slice 05's zero-length decision): a zero-length entry
  // (start === end) is impossible by construction, not merely discouraged by the frontend's
  // own `minutes > 0` save gate — all-day is exactly where whole-day/zero-length shapes start
  // to matter, and a second client has no frontend gate at all.
  (d) => new Date(d.end).getTime() > new Date(d.start).getTime(),
  { message: 'end must be after start', path: ['end'] },
);

export const updateCalendarEntrySchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  start: z.string().datetime({ offset: true }).optional(),
  end: z.string().datetime({ offset: true }).optional(),
  is_all_day: z.boolean().optional(),
  // Present (incl. []) → replace the participant set wholesale. Absent → leave it untouched.
  participants: z.array(participantSchema).optional(),
  ...notifyFields,
}).strict().refine(
  // Same strict-after rule as create, for whichever pair of fields the refine can actually
  // see (both present in this one request). The single-field case — start pushed past the
  // stored end, or vice versa — is caught below against the stored row, not here.
  (d) => d.start === undefined || d.end === undefined || new Date(d.end).getTime() > new Date(d.start).getTime(),
  { message: 'end must be after start', path: ['end'] },
);

// ─── Response shape ─────────────────────────────────────
//
// Explicit select, NOT a spread of the full row: rrule/recurrence_until exist as columns but
// must never be selected into a response body (spec §2). Shared by every read path so list,
// detail, create and update all answer with the identical shape.

const CALENDAR_ENTRY_SELECT = {
  id: true,
  organization_id: true,
  title: true,
  description: true,
  start: true,
  end: true,
  is_all_day: true,
  created_by: true,
  created_at: true,
  updated_at: true,
  participants: {
    select: {
      id: true,
      kind: true,
      user_id: true,
      customer_id: true,
      notified_at: true,
    },
  },
} as const;

type SelectedEntry = {
  participants: ParticipantRow[];
  [key: string]: unknown;
};

async function withEnrichedParticipants(entry: SelectedEntry, orgId: string) {
  const participants = await resolveParticipantDisplay(orgId, entry.participants);
  return { ...entry, participants };
}

// ─── Helpers ───────────────────────────────────────────

const param = (req: Request, name: string): string => req.params[name] as string;

function toParticipantData(orgId: string, entryId: string, participants: ParticipantInput[]) {
  return participants.map((p) => ({
    organization_id: orgId,
    calendar_entry_id: entryId,
    kind: p.kind,
    user_id: p.kind === 'USER' ? (p.user_id as string) : null,
    customer_id: p.kind === 'CUSTOMER' ? (p.customer_id as string) : null,
  }));
}

// ─── Handlers ──────────────────────────────────────────

/**
 * GET /api/calendar-entries — list within the tenant, optionally windowed by start_after /
 * start_before (ISO instants). The filter is an OVERLAP test, not containment: an entry is
 * included when `start <= start_before AND end >= start_after`, so a multi-day entry (e.g. a
 * Mon–Fri vacation) appears in every window it spans, not just the one containing its own
 * start.
 *
 * `customer_id` (slice 10) narrows to entries holding a CUSTOMER-kind participant with that
 * id — the read path behind the customer detail page's combined Schedule tab. Composed with
 * `tenantWhere(req)` above via a plain object spread, never replacing it, so a same-named
 * customer in another org (a different row, a different id) can never leak through this filter.
 */
export async function list(req: Request, res: Response) {
  try {
    const { start_after, start_before, customer_id } = req.query as Record<string, string | undefined>;

    const where: Record<string, unknown> = { ...tenantWhere(req) };
    if (start_before) where.start = { lte: new Date(start_before) };
    if (start_after) where.end = { gte: new Date(start_after) };
    if (customer_id) where.participants = { some: { kind: 'CUSTOMER', customer_id } };

    const entries = await prisma.calendarEntry.findMany({
      where,
      select: CALENDAR_ENTRY_SELECT,
      orderBy: { start: 'asc' },
    });

    const orgId = req.user!.organization_id;
    const allParticipants = entries.flatMap((e) => e.participants as ParticipantRow[]);
    const enriched = await resolveParticipantDisplay(orgId, allParticipants);
    const byId = new Map(enriched.map((p) => [p.id, p]));

    res.json({
      calendar_entries: entries.map((e) => ({
        ...e,
        participants: (e.participants as ParticipantRow[]).map((p) => byId.get(p.id)),
      })),
    });
  } catch (err) {
    logger.error('List calendar entries error:', err);
    res.status(500).json({ error: 'Failed to list calendar entries' });
  }
}

/**
 * POST /api/calendar-entries — create an entry with an optional, mixed set of participants.
 * The creator is NOT auto-attached as a participant (spec §2) — `created_by` is a plain column
 * and nothing here inserts a row for `req.user!.id`. Both `user_id` and `customer_id` on every
 * participant are verified to belong to the caller's org before anything is written.
 */
export async function create(req: Request, res: Response) {
  try {
    const {
      title, description, start, end, is_all_day, participants,
      notify_customer, notify_message,
    } = req.body as {
      title: string;
      description?: string;
      start: string;
      end: string;
      is_all_day?: boolean;
      participants?: ParticipantInput[];
      notify_customer?: boolean;
      notify_message?: string;
    };

    if (participants?.length) {
      const error = await validateParticipantRefs(req, participants);
      if (error) {
        res.status(400).json({ error });
        return;
      }
    }

    const orgId = req.user!.organization_id;
    const actorId = req.user!.id;

    const created = await prisma.$transaction(async (tx) => {
      const entry = await tx.calendarEntry.create({
        data: {
          organization_id: orgId,
          title,
          description: description ?? '',
          start: new Date(start),
          end: new Date(end),
          is_all_day: is_all_day ?? false,
          created_by: actorId,
        },
      });

      if (participants?.length) {
        await tx.calendarEntryParticipant.createMany({
          data: toParticipantData(orgId, entry.id, participants),
        });
      }

      return tx.calendarEntry.findFirst({ where: { id: entry.id }, select: CALENDAR_ENTRY_SELECT });
    });

    const calendar_entry = await withEnrichedParticipants(created as SelectedEntry, orgId);

    // Best-effort, post-commit (mirrors job.controller.ts's own notifyCustomerOfSchedule
    // ordering: the send is awaited so the caller can be told what happened, but it runs
    // AFTER the write so a mail-provider failure can never roll back a real creation). Every
    // participant here is brand new — the empty oldParticipants map makes classifyOutcome
    // return 'scheduled' for every one of them, never 'moved' (there is no "before" to have
    // moved from).
    const notify = await notifyCalendarEntryChange({
      organizationId: orgId,
      actorId,
      entryId: (created as SelectedEntry).id as string,
      title,
      start: new Date(start),
      isAllDay: is_all_day ?? false,
      timeChanged: true,
      finalParticipants: calendar_entry.participants,
      oldParticipants: new Map(),
      notifyParticipantsEmail: notify_customer === true,
      scheduledMessage: notify_message,
    });

    res.status(201).json({ calendar_entry, ...(notify_customer ? { notify } : {}) });
  } catch (err) {
    logger.error('Create calendar entry error:', err);
    res.status(500).json({ error: 'Failed to create calendar entry' });
  }
}

/** GET /api/calendar-entries/:id — tenant-scoped detail; a cross-org id is a 404, not the row. */
export async function getOne(req: Request, res: Response) {
  try {
    const id = param(req, 'id');

    const entry = await prisma.calendarEntry.findFirst({
      where: { id, ...tenantWhere(req) },
      select: CALENDAR_ENTRY_SELECT,
    });
    if (!entry) {
      res.status(404).json({ error: 'Calendar entry not found' });
      return;
    }

    const calendar_entry = await withEnrichedParticipants(entry as SelectedEntry, req.user!.organization_id);
    res.json({ calendar_entry });
  } catch (err) {
    logger.error('Get calendar entry error:', err);
    res.status(500).json({ error: 'Failed to get calendar entry' });
  }
}

/**
 * PATCH /api/calendar-entries/:id — partial update. `participants`, when present in the body
 * (including `[]`), REPLACES the set wholesale — the same shape the scheduler's crew editing
 * already uses. When the key is absent entirely, the existing participant set is left alone.
 */
export async function update(req: Request, res: Response) {
  try {
    const id = param(req, 'id');

    // Notifications (slice 07) need the PRE-write snapshot — title/description/is_all_day as
    // fallbacks for whichever fields this PATCH doesn't touch, and the participant set as it
    // stood before, so notifyCalendarEntryChange can tell "was this participant already known"
    // per participant (see lib/calendar-entries/notify.ts's module doc).
    const existing = await prisma.calendarEntry.findFirst({
      where: { id, ...tenantWhere(req) },
      select: {
        id: true, start: true, end: true, title: true, description: true, is_all_day: true,
        participants: { select: { kind: true, user_id: true, customer_id: true, notified_at: true } },
      },
    });
    if (!existing) {
      res.status(404).json({ error: 'Calendar entry not found' });
      return;
    }

    const {
      title, description, start, end, is_all_day, participants,
      notify_customer, notify_message,
    } = req.body as {
      title?: string;
      description?: string;
      start?: string;
      end?: string;
      is_all_day?: boolean;
      participants?: ParticipantInput[];
      notify_customer?: boolean;
      notify_message?: string;
    };

    // The zod schema only cross-validates start/end when BOTH are present in the same request
    // (it cannot see the stored row). A single-field PATCH — e.g. only `start`, pushed past the
    // entry's existing `end` — needs the EFFECTIVE range checked here, against whichever of
    // start/end the caller didn't touch. Skipping this lets an inverted row through: it breaks
    // the `GET /` overlap predicate (`start <= start_before AND end >= start_after`) and slice
    // 03 would render it backwards on the board.
    //
    // Only runs when a date is actually part of THIS request (QA finding 1). Before this guard,
    // a row that was already zero-length (reachable pre-slice-05, when the create/update refines
    // still allowed `end >= start`) could never be PATCHed again for ANY reason — a title-only
    // `{ title: 'Fixed typo' }` re-derived the effective range from the stored start/end, found
    // them equal, and 400'd every time, with `calendarEntry.update` never called. Neither field
    // present means neither is being touched, so there is nothing new to validate; the stored
    // row's own shape is not this request's problem to fix. `start`/`end` sent (even unchanged,
    // even re-affirming the same zero-length pair) still runs the check below.
    // The EFFECTIVE range this PATCH results in: whichever of start/end the caller sent, falling
    // back to the stored value for the one they didn't. Computed at function scope because two
    // separate concerns read it — slice 05's validation immediately below, and slice 07's
    // `timeChanged` diff further down, which needs it whether or not a date was sent.
    const nextStart = start !== undefined ? new Date(start) : existing.start;
    const nextEnd = end !== undefined ? new Date(end) : existing.end;

    // Validate ONLY when a date is actually part of this request (slice 05, QA finding 1). A row
    // that was already zero-length — reachable before slice 05 tightened the refines — must still
    // accept a title-only PATCH rather than 400ing forever on a shape this request isn't touching.
    if (start !== undefined || end !== undefined) {
      // <=, not <: same strict-after rule as the zod refine above, for the same reason (slice
      // 05's zero-length decision) — a single-field PATCH landing exactly on the stored other
      // boundary must be rejected too, not just one that crosses past it.
      if (nextEnd.getTime() <= nextStart.getTime()) {
        res.status(400).json(validationFailure([{ field: 'end', message: 'end must be after start' }]));
        return;
      }
    }

    // THE #1550 GUARD (spec §9 risk 3): the ONLY input notifyCalendarEntryChange reads to pick
    // MOVED vs nothing is this diff of the instants — never a status, because CalendarEntry has
    // none. A PATCH that touches only title/description leaves both false and sends nothing to
    // anyone who already knew the entry.
    const timeChanged =
      nextStart.getTime() !== existing.start.getTime() || nextEnd.getTime() !== existing.end.getTime();

    if (participants !== undefined && participants.length) {
      const error = await validateParticipantRefs(req, participants);
      if (error) {
        res.status(400).json({ error });
        return;
      }
    }

    const data: Record<string, unknown> = {};
    if (title !== undefined) data.title = title;
    if (description !== undefined) data.description = description;
    if (start !== undefined) data.start = new Date(start);
    if (end !== undefined) data.end = new Date(end);
    if (is_all_day !== undefined) data.is_all_day = is_all_day;

    const orgId = req.user!.organization_id;

    const updated = await prisma.$transaction(async (tx) => {
      await tx.calendarEntry.update({ where: { id }, data });

      if (participants !== undefined) {
        await tx.calendarEntryParticipant.deleteMany({ where: { calendar_entry_id: id } });
        if (participants.length) {
          await tx.calendarEntryParticipant.createMany({
            data: toParticipantData(orgId, id, participants),
          });
        }
      }

      return tx.calendarEntry.findFirst({ where: { id }, select: CALENDAR_ENTRY_SELECT });
    });

    const calendar_entry = await withEnrichedParticipants(updated as SelectedEntry, orgId);

    // Best-effort, post-commit (see create()'s identical ordering note above).
    const notify = await notifyCalendarEntryChange({
      organizationId: orgId,
      actorId: req.user!.id,
      entryId: id,
      title: title ?? existing.title,
      start: nextStart,
      isAllDay: is_all_day ?? existing.is_all_day,
      timeChanged,
      finalParticipants: calendar_entry.participants,
      oldParticipants: buildOldParticipantMap(existing.participants),
      notifyParticipantsEmail: notify_customer === true,
      scheduledMessage: notify_message,
    });

    res.json({ calendar_entry, ...(notify_customer ? { notify } : {}) });
  } catch (err) {
    logger.error('Update calendar entry error:', err);
    res.status(500).json({ error: 'Failed to update calendar entry' });
  }
}

/**
 * POST /api/calendar-entries/:id/notify-moved — the drag/resize "notify participants of the new
 * time?" toast's confirm action (slice 08, spec §3/§5).
 *
 * Dragging or resizing an entry saves the new start/end through a PLAIN `PATCH` the instant the
 * drop lands — no `notify_customer` key on that call, so the move persists before anyone answers
 * the toast (spec: "dismissing the toast does not roll back"). If the dispatcher then clicks
 * "Notify", THIS is the follow-up call. By the time it runs, `existing.start`/`end` already equal
 * the post-drag values, so re-diffing them against the stored row (the way `update()` does) would
 * trivially read `timeChanged: false` — the move already landed. `timeChanged: true` here is not
 * a second selector on top of `classifyOutcome` (still the ONLY outcome logic, imported unchanged
 * from lib/calendar-entries/notify.ts) — it is a structural fact about this route's one caller:
 * nothing reaches it except the toast that follows an actual time-changing drag, the same trust
 * `draggableAccessor` already puts in a caller it structurally cannot reach any other way.
 *
 * Covers BOTH participant kinds (product-owner change, 2026-08-25 — "I actually wanted all
 * participants to be notified"). It used to filter to customers, on the reasoning that a
 * teammate had already been told; that was true of the IN-APP notice only, which fires
 * unconditionally on the time-changing PATCH — the teammate got no email, because that PATCH
 * carries no notify key at all. So this route now emails everyone and passes
 * `suppressInAppNotice: true`, which is what keeps the old reasoning honest: the in-app notice
 * still fires exactly once, on the PATCH, and never a second time from here.
 */
export async function notifyMoved(req: Request, res: Response) {
  try {
    const id = param(req, 'id');

    const existing = await prisma.calendarEntry.findFirst({
      where: { id, ...tenantWhere(req) },
      select: CALENDAR_ENTRY_SELECT,
    });
    if (!existing) {
      res.status(404).json({ error: 'Calendar entry not found' });
      return;
    }

    const orgId = req.user!.organization_id;
    const calendar_entry = await withEnrichedParticipants(existing as SelectedEntry, orgId);

    // IDEMPOTENCY GUARD (post-QA finding — this route hardcodes timeChanged: true because it is
    // called AFTER the move already persisted, so there is no DB diff left to derive it from; that
    // trust needs its own backstop, or a double-click on the toast, a retry, or a curl replay
    // sends the MOVED email again for a move the customer already heard about). A participant
    // whose `notified_at` is AT OR AFTER the entry's own `updated_at` has already been told about
    // the CURRENT state — skip them. Equal timestamps count as "already current" (>=, not >): a
    // notify that raced updated_at to the same instant is not stale enough to justify a resend.
    // A NULL `notified_at` (never told about this entry at all) is exempt from this filter
    // entirely — that participant is exactly the branch `classifyOutcome` resolves to
    // 'scheduled', not 'moved', and skipping it here would silently drop spec §1's own primary
    // case (a customer who has never heard about the entry). This makes a second call against an
    // unchanged entry a true no-op: the first call's successful send stamps `notified_at` to a
    // moment after `updated_at` (nothing else touches `updated_at` in between), so the very
    // participant it just told is the one the next call skips.
    // Both kinds are subject to it: `notified_at` is stamped for any participant an email
    // actually reached (see lib/calendar-entries/notify.ts), teammates included.
    const entryUpdatedAt = existing.updated_at as Date;
    const eligibleParticipants = calendar_entry.participants.filter(
      (p) => p.notified_at === null || p.notified_at < entryUpdatedAt,
    );

    const notify = await notifyCalendarEntryChange({
      organizationId: orgId,
      actorId: req.user!.id,
      entryId: id,
      title: existing.title as string,
      start: existing.start as Date,
      isAllDay: existing.is_all_day as boolean,
      timeChanged: true,
      finalParticipants: eligibleParticipants,
      oldParticipants: buildOldParticipantMap(existing.participants as ParticipantRow[]),
      notifyParticipantsEmail: true,
      scheduledMessage: undefined,
      suppressInAppNotice: true,
    });

    res.json({ notify });
  } catch (err) {
    logger.error('Notify calendar entry moved error:', err);
    res.status(500).json({ error: 'Failed to notify participants' });
  }
}

/**
 * DELETE /api/calendar-entries/:id — hard delete (spec §7), no archived_at. Participant rows
 * cascade via calendar_entry_participants' FK (ON DELETE CASCADE, migration
 * 20260824190000_calendar_entries_crud) — nothing here deletes them by hand.
 */
export async function remove(req: Request, res: Response) {
  try {
    const id = param(req, 'id');

    // `?notify=false` is the only way to opt out — spec §5's delete prompt is pre-ticked when
    // the entry has participants, so silence (the param omitted entirely, same as every other
    // caller that never renders the prompt at all) means "yes, send the cancellation email".
    // This governs the EMAIL channel for both kinds; user participants always get the in-app
    // notice regardless (see lib/calendar-entries/notify.ts's module doc).
    const notifyParticipantsEmail = req.query.notify !== 'false';

    // Snapshot BEFORE the delete — participant rows cascade with the entry, so this is the last
    // chance to read who was on it.
    const existing = await prisma.calendarEntry.findFirst({
      where: { id, ...tenantWhere(req) },
      select: {
        id: true, title: true, start: true, is_all_day: true,
        participants: { select: { id: true, kind: true, user_id: true, customer_id: true, notified_at: true } },
      },
    });
    if (!existing) {
      res.status(404).json({ error: 'Calendar entry not found' });
      return;
    }

    await prisma.calendarEntry.delete({ where: { id } });

    // Best-effort, post-commit and NOT awaited into the response body — the row is already gone
    // and a 204 carries no body, but it IS awaited before responding (mirrors create/update's
    // ordering) so a slow send cannot race a client that immediately re-fetches the (now-empty)
    // customer Schedule tab.
    const orgId = req.user!.organization_id;
    const enrichedParticipants = await resolveParticipantDisplay(orgId, existing.participants as ParticipantRow[]);
    await notifyCalendarEntryDeleted({
      organizationId: orgId,
      actorId: req.user!.id,
      entryId: id,
      title: existing.title,
      start: existing.start,
      isAllDay: existing.is_all_day,
      participants: enrichedParticipants,
      notifyParticipantsEmail,
    });

    res.status(204).send();
  } catch (err) {
    logger.error('Delete calendar entry error:', err);
    res.status(500).json({ error: 'Failed to delete calendar entry' });
  }
}
