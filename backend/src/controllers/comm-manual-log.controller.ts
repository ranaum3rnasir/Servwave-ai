/**
 * Manual Communication Log — write side
 * (spec: md_files/specs/communication/2026-08-27-manual-communication-log.md, slice 1).
 *
 * Records a communication a human ASSERTS took place. It is not a call the platform placed, it
 * lives in its own table, and nothing in the Communication module reads that table — so the
 * entry can never reach the Calls view, Performance, agent metrics or a call report.
 *
 * Captures what an entry cannot exist without - direction, when it happened, free-text notes -
 * plus WHO HAD THE CONVERSATION, which is chosen (slice 2) because the feature's primary use
 * case is an admin typing up conversations colleagues had, and HOW LONG THE CALL WAS (slice 3):
 * an optional duration, which stays optional so that an entry logged before it existed is still
 * a complete entry. The companion `outcome` was retired with its capture UI: the API REFUSES a
 * body naming it (the schema is `.strict()`, so the KEY is unknown), and its column and the
 * `ManualCommOutcome` enum have been dropped.
 *
 * WHICH CHANNEL (slice 6): call, text or email - the three a conversation with a customer
 * actually happens over when it does not pass through ServWave. The optional fields FOLLOW the
 * channel and are refused on the wrong one, because the timeline builds its title out of them:
 * a duration on an email would render as "Outbound email · 12m". Update and delete land in
 * slice 8.
 *
 * AND WHAT IT WAKES (slice 9): one activity-timeline event on the anchor, and nothing else. No
 * automation is dispatched and no notification is raised, here or on any path this file grows.
 * See the block above the `timelineEvent.create` below for why that silence is load-bearing.
 */
import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { tenantWhere } from '../lib/tenant';
import { validationFailure } from '../middleware/validate';
import { getRequestOrgTimezone } from '../lib/timezone';
import { orgWallClockToInstant, orgWallClockOf } from '../lib/orgDayRange';
import {
  recordLeadOutboundContact,
  type LeadContactChannel,
} from '../services/lead-contact.service';

/**
 * `occurred_at` is a ZONELESS wall clock ('YYYY-MM-DDTHH:MM'), NOT an instant, and the schema
 * refuses an instant rather than tolerating one.
 *
 * A client that sends '...Z' or '...+05:00' has already decided which zone the user's "yesterday,
 * 4pm" belongs to, and the only zone a browser can decide with is its own. That is precisely the
 * bug this feature must not ship: a rep in another timezone logging yesterday afternoon has to
 * land on the ORGANISATION's yesterday. Refusing the zoned shape makes composing it against the
 * org clock the only thing the API can do — see `orgWallClockToInstant`.
 */
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

/** A day. See `duration_minutes` on the schema for why there is a ceiling at all. */
const MAX_DURATION_MINUTES = 1440;

/**
 * HOW FAR AHEAD OF NOW AN `occurred_at` MAY STILL LAND — two minutes, and not zero.
 *
 * The rule itself is that an entry records a conversation that ALREADY HAPPENED, so the honest
 * bound is `now`. The grace exists because two clocks and one picker stand between the user and
 * that bound, and none of them is exact:
 *
 *   THE PICKER IS MINUTE-GRANULAR. A user answering "just now" types the current minute, and the
 *   value they typed names the START of it — 14:32 for a request sent at 14:32:40. That one is
 *   already in the past, so it needs no grace; but the same user rounding UP to the minute that
 *   is about to begin is answering the question correctly and would be refused by a strict check.
 *
 *   THE TWO CLOCKS ARE NOT THE SAME CLOCK. The comparison happens on the SERVER's clock while the
 *   value was composed against the USER's. NTP-synced machines agree to within seconds, but a
 *   desktop that has not synced drifts by minutes, and a strict bound would turn that drift into
 *   an unexplainable refusal of a time the user can see on their own taskbar.
 *
 * Two minutes covers both and is an order of magnitude below the mistake this guard exists for —
 * the QA report that produced it was thirteen minutes ahead, from DateTimePicker defaulting an
 * unset time to 09:00. A window wide enough to absorb clock skew is not wide enough to absorb a
 * date picked with the wrong time on it.
 */
const FUTURE_TOLERANCE_MS = 2 * 60 * 1000;

/**
 * The three supported channels (slice 6). Lower-case on the wire and upper-case in the database,
 * the same split as `direction`, and `sms` rather than `text` because that is the
 * word the shared CommItem contract already speaks for the channel.
 *
 * There are exactly three, and widening the set is not a matter of adding a key here: in-person
 * conversations, voicemail-left, letters and walk-ins have no slot in CommItem's `channel` union
 * and would have to be threaded through every mapper and filter in the aggregator. Explicitly out
 * of scope, per the spec.
 */
const CHANNEL = { call: 'CALL', sms: 'SMS', email: 'EMAIL' } as const;

/**
 * The same three channels in the LEAD-CONTACT vocabulary (slice 7).
 *
 * `sms` here, `text` there, and the map exists rather than a cast because the two vocabularies
 * are genuinely different and have drifted apart before: the comm contract says `sms` because
 * that is the word `CommItem.channel` speaks, and `lead-contact.service` says `text` because
 * that is the word the response-time rule is written in. A cast would compile and then name the
 * wrong channel in the one place this value is read — the error log that tells an operator which
 * channel failed to stamp.
 */
const CONTACT_CHANNEL: Record<keyof typeof CHANNEL, LeadContactChannel> = {
  call: 'call',
  sms: 'text',
  email: 'email',
};

/** A subject line is a header, not a body — the notes carry what was said. */
const MAX_SUBJECT_LENGTH = 500;

/** The shape of an entry id in the path (slice 8). See `loadModifiableEntry` for why it is checked. */
const ENTRY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * THE FIELDS AN ENTRY IS MADE OF, shared by create (slice 1-6) and update (slice 8).
 *
 * Shared rather than restated because the two endpoints do not describe two different records:
 * an edit produces a row indistinguishable from one created that way in the first place. Two
 * copies of `duration_minutes`' ceiling, or of the notes length, would be two rules that drift.
 * The update schema below overrides exactly the two keys where the two endpoints genuinely
 * disagree, and says why at each of them.
 */
const ENTRY_SHAPE = {
  lead_id: z.string().uuid().optional(),
  job_id: z.string().uuid().optional(),
  /**
   * THE THIRD ANCHOR (#2021). A conversation about the CUSTOMER and about no one lead or job -
   * "I rang Linda to check she was happy with the work" - plus the only anchor available at all
   * to a customer holding neither a lead nor a job.
   *
   * It is not a denormalised copy of the anchor's customer: a lead- or job-anchored entry leaves
   * this NULL and still resolves its counterparty through the anchor it does name.
   */
  customer_id: z.string().uuid().optional(),
  /**
   * WHAT KIND of conversation this was. Optional, defaulting to a call: the column's own
   * default is CALL, slices 1-5 shipped an API that pinned it, and every entry already in the
   * database is one. A client that says nothing means the same thing it always meant.
   */
  channel: z.enum(['call', 'sms', 'email']).optional(),
  direction: z.enum(['in', 'out']),
  occurred_at: z.string().regex(WALL_CLOCK, 'must be a zoneless wall clock, e.g. 2026-08-26T16:00'),
  notes: z.string().trim().min(1).max(10_000),
  /**
   * Who HAD the conversation. Optional here (create), defaulting to the caller — the feature's
   * primary use case is an onboarding admin typing up conversations COLLEAGUES had, and
   * recording the typist as the performer would credit the wrong person on every one of those
   * entries. REQUIRED on update; see the update schema for why the same default is wrong there.
   *
   * There is deliberately no `logged_by` field here. `.strict()` therefore REFUSES a body that
   * names one, rather than silently ignoring it: the logger is what tells an eyewitness record
   * from a second-hand one, so a caller able to name it could disown their own entry.
   */
  performed_by: z.string().uuid().optional(),
  /**
   * ROUGHLY how long it lasted, in whole minutes. Optional, and meaningful ONLY for a call -
   * refused outright on the other two channels (see ENTRY_RULES below).
   *
   * `z.number()` WITHOUT coercion, on purpose: a duration that is not a number is a client
   * defect, and coercing '' or 'abc' to NaN (or, worse, '12' to 12) would let a broken form
   * write a value nobody typed. Whole minutes only, because the column is an Int - a
   * fractional value would otherwise be truncated somewhere downstream rather than refused
   * here. Zero is allowed: a thirty-second confirmation rounds to it, and that is a real
   * answer to "how long?" rather than a missing one (a missing one omits the field).
   *
   * The ceiling exists so an absurd value is a 400 and not a 500: the column is a 4-byte
   * integer, and a day is already far longer than any conversation this records.
   */
  duration_minutes: z
    .number({ invalid_type_error: 'must be a number of minutes' })
    .int('must be a whole number of minutes')
    .min(0, 'must not be negative')
    .max(MAX_DURATION_MINUTES, `must be at most ${MAX_DURATION_MINUTES} minutes`)
    .optional(),
  /**
   * The subject line of a logged email (slice 6, user story 15) - what makes one identifiable
   * among several. OPTIONAL, and an email without one is a complete entry: somebody typing up
   * months of history will not remember every subject line, and an entry that says nothing
   * about the header is a different statement from one whose header was empty.
   */
  subject: z.string().trim().min(1).max(MAX_SUBJECT_LENGTH).optional(),
};

/**
 * THE CROSS-FIELD RULES, stated ONCE and applied by both endpoints.
 *
 * Each is a predicate paired with the message a caller reads, so that neither half can drift
 * between create and update. That drift is not hypothetical: the slice 6 review found that the
 * timeline mapper's `duration` and `meta` readings are NOT channel-pinned, and that the create
 * endpoint's refusal was therefore the whole of the enforcement — no DB CHECK stands behind it.
 * An update endpoint that let the same pairing through would have made a row rendering
 * "Outbound email · 12m" reachable for the first time. (The mapper is now pinned too — see
 * lib/job-communications.ts mapManual — because one guard for a rule this load-bearing is one
 * too few.)
 */
const ENTRY_RULES = {
  // Exactly one anchor - and on UPDATE this is also how an entry moves between a lead and a job,
  // since the shared timeline row's attach/move/detach menu is deliberately not extended to
  // manual entries. An entry naming both would be double-counted on two timelines; one naming
  // neither could never be read back at all. The DB carries the same invariant as
  // `manual_communication_logs_exactly_one_anchor`.
  exactlyOneAnchor: {
    // A COUNT, NOT AN EXCLUSIVE-OR (#2021). The two-anchor rule was `(lead != null) !== (job !=
    // null)`, which is correct for two and SILENTLY WRONG for three: with a lead, a job and a
    // customer all supplied, XOR of the first two is false, the third flips nothing, and a
    // suite testing singles and pairs passes while the endpoint admits a row the database's own
    // `manual_communication_logs_exactly_one_anchor` CHECK (now num_nonnulls of three) refuses.
    // The all-three case is the one that discriminates, and it is tested at both layers.
    check: (d: { lead_id?: string; job_id?: string; customer_id?: string }) =>
      [d.lead_id, d.job_id, d.customer_id].filter((id) => id != null).length === 1,
    opts: {
      message: 'exactly one of lead_id, job_id or customer_id is required',
      path: ['lead_id'],
    },
  },
  // THE OPTIONAL FIELDS FOLLOW THE CHANNEL (slice 6). These are not merely unused on the wrong
  // channel - the timeline builds its title out of them, so a duration on an email renders as
  // "Outbound email · 12m". (There was a companion rule for `outcome`; it went with that field,
  // whose column and enum have since been dropped.)
  // Refusing them here is what stops a broken client writing a row that reads as a lie; the
  // alternative, silently dropping them in the mapper, would store the value and hide it.
  durationBelongsToACall: {
    check: (d: { channel?: string; duration_minutes?: number }) =>
      (d.channel ?? 'call') === 'call' || d.duration_minutes === undefined,
    opts: { message: 'a duration belongs to a call', path: ['duration_minutes'] },
  },
  subjectBelongsToAnEmail: {
    check: (d: { channel?: string; subject?: string }) =>
      d.channel === 'email' || d.subject === undefined,
    opts: { message: 'a subject belongs to an email', path: ['subject'] },
  },
};

export const createManualCommunicationLogSchema = z
  .object(ENTRY_SHAPE)
  .strict()
  .refine(ENTRY_RULES.exactlyOneAnchor.check, ENTRY_RULES.exactlyOneAnchor.opts)
  .refine(ENTRY_RULES.durationBelongsToACall.check, ENTRY_RULES.durationBelongsToACall.opts)
  .refine(ENTRY_RULES.subjectBelongsToAnEmail.check, ENTRY_RULES.subjectBelongsToAnEmail.opts);

type CreateBody = z.infer<typeof createManualCommunicationLogSchema>;

/**
 * PUT /api/communication/manual-log/:id — the whole editable record, replaced.
 *
 * PUT AND NOT PATCH, deliberately, though PATCH is this codebase's commoner verb. The body
 * describes the entry as it should now read, in full: what the drawer shows when it reopens is
 * what gets stored, and an optional field the user cleared is stored as NULL rather than quietly
 * retained. A partial patch would have to validate the MERGE of the stored row and the body, and
 * the rule most likely to be got wrong there is exactly the one with no database CHECK behind it
 * — "changed the channel to email, left yesterday's duration alone".
 *
 * Two keys differ from create, and only two:
 *
 *   `channel` is REQUIRED. Defaulting an absent channel to CALL is right on create (every entry
 *   logged before the picker existed is one) and wrong here: it would silently turn a logged
 *   email into a logged call, which is a statement that a phone conversation happened.
 *
 *   `performed_by` is REQUIRED. Defaulting it to the caller is right on create (a rep logging
 *   their own call) and wrong here: an admin correcting a colleague's typo would silently
 *   re-credit the conversation to themselves — the precise failure the performer field exists to
 *   prevent.
 *
 * `logged_by` is absent from ENTRY_SHAPE, so `.strict()` refuses a body naming it. That is the
 * rule the slice turns on: the logger is set at creation and is never changed by an edit.
 */
export const updateManualCommunicationLogSchema = z
  .object({
    ...ENTRY_SHAPE,
    channel: z.enum(['call', 'sms', 'email']),
    performed_by: z.string().uuid(),
  })
  .strict()
  .refine(ENTRY_RULES.exactlyOneAnchor.check, ENTRY_RULES.exactlyOneAnchor.opts)
  .refine(ENTRY_RULES.durationBelongsToACall.check, ENTRY_RULES.durationBelongsToACall.opts)
  .refine(ENTRY_RULES.subjectBelongsToAnEmail.check, ENTRY_RULES.subjectBelongsToAnEmail.opts);

type UpdateBody = z.infer<typeof updateManualCommunicationLogSchema>;

const DIRECTION = { in: 'IN', out: 'OUT' } as const;

/**
 * The activity-feed wording (slice 9), keyed off the STORED column rather than the request body.
 *
 * Reading the row back is what stops the feed and the entry disagreeing: they are then two
 * renderings of one value instead of two independent derivations of the same intent.
 *
 * `text` here, and `sms` on the wire and in the column, for the reason CONTACT_CHANNEL above
 * gives: this is prose a person reads, and nobody says "I sent them an SMS logged".
 */
const CHANNEL_NOUN = { CALL: 'call', SMS: 'text', EMAIL: 'email' } as const;
const DIRECTION_WORD = { OUT: 'Outbound', IN: 'Inbound' } as const;

/**
 * The wire shape. camelCase, matching the CommItem contract the timelines already speak.
 *
 * `timeZone` is the ORGANISATION's, and it is required rather than optional: `occurredAtLocal`
 * below is the value an edit form reopens on, and a caller that could omit the zone would get one
 * composed against nothing.
 */
function toResponse(row: {
  id: string;
  channel: string;
  direction: string;
  occurred_at: Date;
  notes: string;
  duration_minutes: number | null;
  subject: string | null;
  lead_id: string | null;
  job_id: string | null;
  customer_id: string | null;
  performed_by: string;
  logged_by: string;
}, timeZone: string) {
  return {
    id: row.id,
    channel: row.channel.toLowerCase(),
    direction: row.direction.toLowerCase(),
    occurredAt: row.occurred_at.toISOString(),
    /**
     * THE SAME INSTANT AS THE ORG'S OWN WALL CLOCK, 'YYYY-MM-DDTHH:MM' — what the capture form
     * reopens on when the entry is edited (slice 8).
     *
     * Composed here and not on the client, for the reason the whole feature composes on this
     * side: only the organisation's zone is the right one, and the browser's is the one a client
     * would reach for. The frontend cannot even do it safely knowing the zone — its
     * `useScheduleTimezone()` answers with a GUESS while the organisation query is in flight, and
     * a picker seeded off a guess and saved unchanged is a silent shift of an entry's date.
     *
     * Exactly the value `occurred_at` was composed FROM on the way in (orgWallClockToInstant is
     * the inverse), so reopening an entry and saving it untouched is a no-op rather than a move.
     */
    occurredAtLocal: orgWallClockOf(row.occurred_at, timeZone),
    notes: row.notes,
    durationMinutes: row.duration_minutes,
    subject: row.subject,
    leadId: row.lead_id,
    jobId: row.job_id,
    customerId: row.customer_id,
    performedBy: row.performed_by,
    loggedBy: row.logged_by,
    // The same row read back through the timeline carries this - it is what the "Logged" chip
    // renders from - so the create response carries it too. One wire shape for one row, rather
    // than two representations that disagree about whether the entry is hand-entered.
    manuallyLogged: true,
  };
}

/**
 * WHEN IT HAPPENED, as an instant — or null, having already sent the 400.
 *
 * Shared by create and update because the rule is the same on both and the update path is the
 * one that would otherwise be forgotten: an edit can set `occurred_at` to anything a creation
 * could, so a guard on create alone is a guard a client can walk around by posting a valid time
 * and immediately correcting it.
 *
 * TWO REFUSALS, ONE PLACE:
 *
 *   NOT A WALL CLOCK. `orgWallClockToInstant` answers null for anything carrying a zone, which is
 *   how the feature refuses a client that has already decided whose "yesterday, 4pm" this is.
 *
 *   IN THE FUTURE. The entry asserts a conversation that already took place, so a timestamp that
 *   has not arrived is a contradiction rather than a cosmetic oddity. It sorts to the top of a
 *   newest-first Communication tab and reads as the most recent contact before it has occurred,
 *   and — outbound, on a lead — `recordLeadOutboundContact` stamps `contacted_at` with this very
 *   value, first-write-wins and therefore permanently.
 *
 * THE COMPARISON IS BETWEEN INSTANTS, AFTER CONVERSION, AND THAT IS THE WHOLE OF THE CARE HERE.
 * `occurred_at` is a ZONELESS wall clock; comparing it as a string, or against the server's own
 * wall clock, would ask whether it is future in UTC — the server's zone in production — rather
 * than on the ORGANISATION's clock. Those two answers differ by up to a day, in both directions:
 * 09:00 in Pacific/Auckland is comfortably in UTC's past while still being the org's tomorrow,
 * and a New York evening is already the next UTC day while still being the org's today. Both
 * halves are pinned in comm-manual-log.test.ts, because a naive fix passes one of them.
 */
function resolveOccurredAtOr400(res: Response, wallClock: string, timeZone: string): Date | null {
  const occurredAt = orgWallClockToInstant(wallClock, timeZone);
  if (!occurredAt) {
    res.status(400).json(
      validationFailure([{ field: 'occurred_at', message: 'must be a zoneless wall clock, e.g. 2026-08-26T16:00' }]),
    );
    return null;
  }
  if (occurredAt.getTime() > Date.now() + FUTURE_TOLERANCE_MS) {
    res.status(400).json(
      validationFailure([
        { field: 'occurred_at', message: 'must not be in the future - this records a conversation that already happened' },
      ]),
    );
    return null;
  }
  return occurredAt;
}

/**
 * Resolve the anchor the body names, TENANT-SCOPED. Answers false having already sent the 404.
 *
 * Shared by create and update because it is the same rule on both, and it is the one rule in this
 * file with a security consequence: an identifier belonging to another organisation is a 404 and
 * not a 403, so the caller learns nothing about whether the row exists elsewhere. Update reaches
 * it with a lead or job the entry did not previously name — which is how an entry is moved
 * between the two — so a second copy of this lookup would be a second chance to forget the
 * tenant filter.
 */
async function resolveAnchorOr404(
  req: Request,
  res: Response,
  body: { lead_id?: string; job_id?: string; customer_id?: string },
): Promise<boolean> {
  if (body.lead_id) {
    const lead = await prisma.lead.findFirst({
      where: { id: body.lead_id, ...tenantWhere(req) },
      select: { id: true },
    });
    if (!lead) {
      res.status(404).json({ error: 'Lead not found' });
      return false;
    }
    return true;
  }
  // The CUSTOMER branch (#2021), resolved under the same tenancy clause as the two above and
  // answering the same 404 for another organisation's id. It grants no visibility of its own: a
  // row-restricted user reaches exactly the customers they could already reach, because the id
  // has to be one they were shown in the first place.
  if (body.customer_id) {
    const customer = await prisma.customer.findFirst({
      where: { id: body.customer_id, ...tenantWhere(req) },
      select: { id: true },
    });
    if (!customer) {
      res.status(404).json({ error: 'Customer not found' });
      return false;
    }
    return true;
  }
  const job = await prisma.job.findFirst({
    where: { id: body.job_id!, ...tenantWhere(req) },
    select: { id: true },
  });
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return false;
  }
  return true;
}

/**
 * Resolve the named performer, TENANT-SCOPED, exactly as the anchor above is. A stranger's id is
 * a 404 rather than a 403 for the same reason: the caller learns nothing about whether that user
 * exists elsewhere. Answers false having already sent the 404.
 *
 * The CALLER's own id is not re-resolved. `authenticate` already loaded that row and took
 * `req.user.organization_id` from it, so the caller-as-performer case is verified by construction
 * and a second lookup could only ever confirm what the request is already standing on.
 */
async function resolvePerformerOr404(
  req: Request,
  res: Response,
  performedBy: string,
): Promise<boolean> {
  if (performedBy === req.user!.id) return true;
  const performer = await prisma.user.findFirst({
    where: { id: performedBy, ...tenantWhere(req) },
    select: { id: true },
  });
  if (!performer) {
    res.status(404).json({ error: 'Performer not found' });
    return false;
  }
  return true;
}

/**
 * GET /api/communication/manual-log/performers — who the drawer may credit a conversation to.
 *
 * WHY THIS EXISTS AT ALL, rather than the picker reading `GET /api/users`. That route is gated on
 * `read User`, which appears in DEFAULT_GRANTS exactly twice — DISPATCHER and TECHNICIAN. There is
 * no SALES row, and SHARED_BASELINE carries only `create Communication`. So the moment an
 * organisation granted `log_past` to SALES, the picker 403'd and came back EMPTY: that user could
 * not credit anyone, including themselves, and the capability they had just been given did not
 * work. A self-fallback label would have repaired the trigger text and left the list empty.
 *
 * WHY NOT BUNDLE `read User` WITH `log_past` INSTEAD. Two reasons, both structural. It widens who
 * can enumerate staff — `GET /api/users` returns every colleague's email, phone, login state,
 * avatar, department and role — as a side effect of a COMMUNICATION capability, which is a bigger
 * blast radius than the feature asked for. And `User` is itself a roleViewModel MODULES subject,
 * so a sensitive bundle emitting `read User` would emit it a SECOND time alongside the matrix
 * cell: an admin unticking Users → View would then see nothing happen, because the communication
 * bundle would keep re-emitting the row they had just cleared. A control that silently does
 * nothing is worse than a missing one.
 *
 * So: the same guard as the write it feeds, the same tenant scope, and a select narrow enough
 * that this is not a staff directory by another name — id and display name, nothing else. The
 * set is the organisation's ACTIVE users - the same set the assignee picker's own roster (now
 * `GET /api/users/assignable`, split out for the same reason as this one) draws from for a holder,
 * and exactly what `resolvePerformerOr404` will accept back.
 */
export async function listManualLogPerformers(req: Request, res: Response) {
  try {
    const users = await prisma.user.findMany({
      where: { ...tenantWhere(req), is_active: true },
      select: { id: true, first_name: true, last_name: true },
      orderBy: [{ last_name: 'asc' }, { first_name: 'asc' }],
    });
    res.json({ users });
  } catch (err) {
    logger.error('Failed to list manual communication log performers:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * POST /api/communication/manual-log — record a communication that already happened.
 *
 * Guarded by `log_past Communication` on the route. The referenced lead (or job) is resolved
 * TENANT-SCOPED, so an identifier belonging to another organisation is a 404 and not a 403: the
 * caller learns nothing about whether the row exists elsewhere.
 */
export async function createManualCommunicationLog(req: Request, res: Response) {
  try {
    const body = req.body as CreateBody;
    const organizationId = req.user!.organization_id;
    const userId = req.user!.id;

    // The ORG's clock, not the browser's and not the server's. Held rather than discarded: the
    // response reads the stored instant back out through the SAME zone (occurredAtLocal), so the
    // wall clock a caller sent and the one it gets back are the same string.
    const timeZone = await getRequestOrgTimezone(req);
    const occurredAt = resolveOccurredAtOr400(res, body.occurred_at, timeZone);
    if (!occurredAt) return;

    if (!(await resolveAnchorOr404(req, res, body))) return;

    const performedBy = body.performed_by ?? userId;
    if (!(await resolvePerformerOr404(req, res, performedBy))) return;

    /**
     * ONE TRANSACTION — THE ENTRY AND ITS AUDIT EVENT ARE ONE FACT (C15).
     *
     * All three writes below — the entry, slice 7's contacted-at stamp, slice 9's activity event
     * — commit together or not at all. They used to be three separate statements, and the gap
     * between them is not theoretical: a QA runner SIGKILLed this process mid-request and left
     * entry 85eca0ee-… in `manual_communication_logs` with no `timeline_events` row behind it.
     *
     * WHY THAT PARTICULAR HOLE MATTERS MORE THAN A MISSING ROW USUALLY WOULD. The delete handler
     * deliberately leaves the activity event standing (C14): "a human added a record here, and
     * this is who" is meant to outlive the record it describes, so that the feature's one audit
     * surface is not erasable by the person with the most reason to erase it. An audit trail
     * that is immutable but full of silent holes buys nothing — a reader cannot tell a missing
     * event from an entry nobody ever logged. Atomicity is what makes C14's promise true.
     *
     * INTERACTIVE FORM, NEVER `$transaction([...])`. Under DB_TENANT_GUARD the batch form is
     * broken here: the guard proxies every model delegate so that each op runs its own per-op
     * transaction, which means the promises handed to `$transaction([...])` have already fired
     * by the time the array is built. The interactive form is the one lib/tenant-guard.ts sets
     * the org session var for, before the callback runs. Recorded incident, not a hypothetical.
     *
     * EVERY WRITE INSIDE GOES THROUGH `tx`, INCLUDING THE ONE INSIDE THE HELPER. Reaching for the
     * global client from within an interactive transaction takes a SECOND connection out of the
     * pool while the first is still held, which deadlocks it under load (P2024) — also recorded
     * here. `recordLeadOutboundContact` takes its client as its first parameter and hands it
     * straight to `stampLeadClock`, whose `updateMany` is the only statement it runs, so passing
     * `tx` is the whole of what that costs.
     *
     * SLICE 7's RACE SAFETY IS UNCHANGED. `stampLeadClock` still puts `contacted_at: null` in the
     * WHERE of that `updateMany`: the decision is made inside the statement by Postgres and the
     * column is read nowhere. Opening a transaction around it does not weaken that, and must not
     * tempt anyone into "simplifying" it into a read-then-write now that one is open — that is
     * exactly the pre-transaction-read race this codebase has shipped before.
     *
     * WHAT THIS DOES CHANGE, stated rather than hidden. The contacted-at writer still swallows
     * and logs its own failure, but a failure it swallows has already aborted the surrounding
     * transaction in Postgres, so the entry no longer survives one. Slice 7's "never fails the
     * user's send" was written for the three platform channels, where the message really had
     * already gone out; here nothing has gone anywhere, and a 500 the caller can retry is better
     * than an entry whose lead clock disagrees with it — `contacted_at` is first-write-wins and
     * can never be moved afterwards, so a stamp left behind by a rolled-back entry is permanent.
     *
     * THE READS STAY OUTSIDE. `getRequestOrgTimezone`, `resolveAnchorOr404` and
     * `resolvePerformerOr404` all run before this opens, and the latter two send their own 404s:
     * a response written from inside the callback would either leave the transaction open across
     * it or be rolled back after the client had already been told the outcome. The 201 is
     * likewise built after the commit, off the row the callback returns.
     */
    const row = await prisma.$transaction(async (tx) => {
      const created = await tx.manualCommunicationLog.create({
        data: {
          organization_id: organizationId,
          // Chosen as of slice 6, and still CALL when the client says nothing - which is what every
          // entry logged before the picker existed is.
          channel: CHANNEL[body.channel ?? 'call'],
          direction: DIRECTION[body.direction],
          occurred_at: occurredAt,
          // Two different people, and the asymmetry is the point: the performer is CHOSEN (an
          // admin credits the colleague who actually had the conversation), the logger is the
          // authenticated caller and is never a client input.
          performed_by: performedBy,
          logged_by: userId,
          notes: body.notes,
          // Optional both, and written as explicit NULLs when absent - an entry that says nothing
          // about how long it was or how it went is a complete entry, not a partial one.
          duration_minutes: body.duration_minutes ?? null,
          subject: body.subject ?? null,
          lead_id: body.lead_id ?? null,
          job_id: body.job_id ?? null,
          customer_id: body.customer_id ?? null,
        },
      });

      /**
       * SLICE 7 — an outbound entry on a LEAD marks that lead contacted, at the moment the
       * conversation happened.
       *
       * This goes through the SAME writer the three platform channels use rather than touching
       * `contacted_at` here, because the rule has to be identical everywhere or the response-time
       * metric is unreportable — and the specific way it goes wrong is silent (see the module
       * header of lead-contact.service.ts). What that writer contributes here:
       *
       *   FIRST WRITE WINS, decided by Postgres. `stampLeadClock`'s `WHERE contacted_at IS NULL`
       *   makes the decision INSIDE the statement, so two people logging the same lead at the same
       *   moment cannot both observe null and both write. A read of the column before this point,
       *   however carefully guarded afterwards, would be exactly the pre-transaction-read race this
       *   codebase has shipped before.
       *
       *   INBOUND IS NOT OUTREACH. `isHumanOutboundTouch` refuses anything but `direction: 'out'`.
       *   A customer chasing us is not us doing our job (user story 15), and that holds whether or
       *   not the lead already carries a value.
       *
       *   A JOB-ANCHORED ENTRY TOUCHES NOTHING. `lead_id` is null on that branch and the writer
       *   no-ops on a null lead — structurally, rather than through a condition here that a later
       *   edit could invert. The lead a job converted from is deliberately NOT resolved and
       *   deliberately NOT stamped: it is out of scope, and inventing the join would silently
       *   widen the blast radius of every job-anchored log.
       *
       * `at` is the entry's own `occurredAt`, never `new Date()`: an admin typing up three months
       * of history must stamp each lead with the day the conversation happened, not with today.
       *
       * AWAITED, and it still SWALLOWS — but the swallow no longer saves the entry (C15). The
       * writer keeps its own contract: it catches and logs at error level rather than throwing.
       * What changed is what that buys HERE. Inside the transaction opened above, a statement
       * that failed has already aborted the transaction in Postgres, so the entry is rolled back
       * whether or not this function rethrows. That is the right trade at this call site and the
       * wrong one at the other three: there the message had genuinely already gone out, and a
       * bookkeeping failure must not turn a send that plainly happened into a 500. Here nothing
       * has gone anywhere, the caller can retry, and the alternative is a lead stamped
       * `contacted_at` from an entry that does not exist — a stamp that is first-write-wins and
       * therefore permanent. It is still awaited so the failure is logged before the rollback,
       * rather than becoming the fire-and-forget shape that fakes a green result.
       */
      await recordLeadOutboundContact(tx, {
        // Null on the job branch — the XOR above guarantees exactly one of the two is set.
        leadId: created.lead_id,
        orgId: organizationId,
        channel: CONTACT_CHANNEL[body.channel ?? 'call'],
        direction: body.direction,
        // Named explicitly, not left to the default. A hand-logged entry is a human asserting a
        // conversation took place — there is no automation that types one — and the writer's own
        // contract asks every call site to state this rather than inherit it.
        automated: false,
        at: created.occurred_at,
      });

      /**
       * SLICE 9 — ONE activity-timeline event, on the anchor the entry names, and NOTHING ELSE.
       *
       * WHAT THIS ADDS. The Communication tab already shows the entry. The activity feed is where
       * someone auditing the record learns that a HUMAN put it there and which human — the same
       * feed that carries the status changes and the owner changes, so the hand-written record
       * sits in the record's own history rather than only in the timeline it is about.
       *
       * `created_by` IS THE LOGGER, NEVER THE PERFORMER. Both endpoints that read this table join
       * `created_by` to a name, and the question this event answers is "who added this record" —
       * the entry itself already answers "who had the conversation", and answering the second here
       * would credit the colleague for an admin's keystrokes on every backfilled row.
       *
       * THE DESCRIPTION READS OFF THE STORED ROW, not off `body`. They cannot then disagree: the
       * feed and the entry become two renderings of one value rather than two derivations of the
       * same intent, which is how the timeline's own title drifted from the column before.
       *
       * NOT FAILURE-ISOLATED, deliberately — and as of C15 it cannot be. "Creating an entry
       * writes one activity event" is a promise the 201 makes, and it is now kept by the
       * transaction rather than by hope: this write and the entry commit together, so an entry
       * with nobody able to see who added it is not a state the database can hold. Swallowing a
       * failure here would break that in both directions — it would leave the entry standing
       * without its event AND report success for it. The three inputs are the org from the
       * session, an anchor id already resolved TENANT-SCOPED above, and the authenticated caller,
       * so there is little left to fail on; the guarantee no longer rests on that being true.
       *
       * ─── AND NOTHING ELSE ────────────────────────────────────────────────────────────────────
       *
       * NO AUTOMATION IS DISPATCHED AND NO NOTIFICATION IS RAISED, on this path or any other this
       * controller grows. That is not an omission to be tidied up later — it is the constraint the
       * onboarding use case rests on. An admin typing up months of history may create hundreds of
       * entries in an afternoon; dispatching on each would fire a flood of stale automated actions
       * against months-old conversations and alert colleagues about calls from three months ago,
       * which is precisely what would make the feature unusable for the case it exists for.
       *
       * Structurally this costs nothing: `dispatchAutomationEvent` and `emit` are separate call
       * sites, so the whole of the behaviour is not importing them. It is cheap to break by
       * accident, though — both are fire-and-forget and swallow their own failures, so wiring one
       * in changes nothing an HTTP caller or a later query could observe. The guard is therefore a
       * SPY on each, asserted never-called, in comm-manual-log-audit.test.ts via the shared
       * `expectNothingWokenUp` helper. If you add a wake-up here on purpose, that suite is where
       * the argument for it has to be made.
       */
      await tx.timelineEvent.create({
        data: {
          organization_id: organizationId,
          entity_type: created.lead_id ? 'LEAD' : created.customer_id ? 'CUSTOMER' : 'JOB',
          entity_id: (created.lead_id ?? created.customer_id ?? created.job_id)!,
          event_type: 'COMMUNICATION_LOGGED',
          description: `${DIRECTION_WORD[created.direction as keyof typeof DIRECTION_WORD]} ${CHANNEL_NOUN[created.channel as keyof typeof CHANNEL_NOUN]} logged`,
          created_by: userId,
        },
      });

      return created;
    });

    res.status(201).json({ entry: toResponse(row, timeZone) });
  } catch (err) {
    logger.error('Failed to create manual communication log:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SLICE 8 — correcting and removing an entry.
//
// A hand-typed record can be wrong: a mistyped date, the wrong colleague credited, the wrong lead
// entirely. Both endpoints below are guarded by the same `log_past Communication` ability on the
// route, plus ONE MORE RULE that the route cannot express because it is about the ROW: the
// requester must be the entry's LOGGER, or an organisation ADMIN.
//
// NEITHER PATH WRITES AN ACTIVITY EVENT, DISPATCHES AN AUTOMATION, OR RAISES A NOTIFICATION.
// Create writes exactly one activity event (see the block in the create handler above); an edit
// and a delete write none. Structurally that is, again, simply not calling anything — and it is
// cheap to break by accident, so it is spied on rather than inferred, in
// comm-manual-log-audit.test.ts via `expectNothingWokenUp`.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * MAY THIS REQUESTER MODIFY THIS ENTRY — the row-level rule slice 8 adds.
 *
 * The logger, or an organisation admin. One person cannot quietly rewrite another's account of a
 * conversation (user story 40); an admin can clean up after a departed colleague (user story 39).
 * The PERFORMER is deliberately not in this test: being credited with a conversation somebody
 * else typed up does not make their record of it yours to rewrite.
 *
 * `role`, and not `isSuperUser`. The question here is "what kind of user is this", which
 * lib/permissions/effectiveRole.ts's own header reserves for the BASE role — an ADMIN-derived
 * custom role ("full access minus payroll") is still the organisation's admin, and is still the
 * person expected to clean up after a leaver. `isSuperUser` answers a different question: whether
 * the CASL manage-all short-circuit applies.
 */
function mayModifyEntry(req: Request, entry: { logged_by: string }): boolean {
  return entry.logged_by === req.user!.id || req.user!.role === 'ADMIN';
}

/**
 * Load the entry this request names, TENANT-SCOPED, and apply the rule above.
 *
 * Two different refusals, and the difference is deliberate:
 *
 *   404 — no such entry IN THIS ORGANISATION. A cross-tenant id is indistinguishable from a
 *   nonexistent one, so the caller learns nothing about another organisation's data.
 *
 *   403 — the entry is right there in the requester's own organisation and they can already read
 *   it on the timeline. Pretending it does not exist would be a lie they can disprove by
 *   scrolling; "you may not change this" is the true answer.
 */
async function loadModifiableEntry(
  req: Request,
  res: Response,
): Promise<ManualLogRow | null> {
  const id = req.params.id as string;
  // A path segment that is not a uuid can name no row, and handing it to Postgres as one would
  // raise a driver error the catch below would render as a 500 — a server fault for what is a
  // client's malformed request. It is the same answer a well-formed unknown id gets.
  if (!ENTRY_ID.test(id)) {
    res.status(404).json({ error: 'Entry not found' });
    return null;
  }
  const entry = (await prisma.manualCommunicationLog.findFirst({
    where: { id, ...tenantWhere(req) },
  })) as ManualLogRow | null;
  if (!entry) {
    res.status(404).json({ error: 'Entry not found' });
    return null;
  }
  if (!mayModifyEntry(req, entry)) {
    res.status(403).json({ error: 'Insufficient permissions' });
    return null;
  }
  return entry;
}

/** The stored row, as both handlers below read it back. */
type ManualLogRow = Parameters<typeof toResponse>[0] & { organization_id: string };

/**
 * GET /api/communication/manual-log/:id — the entry, in full, so the capture form can reopen on
 * it.
 *
 * NOT A GENERAL READ. The timeline endpoints are the general read and are guarded by
 * `read Communication`; this one exists because the timeline ITEM is not enough to edit from —
 * its `preview` is truncated at 160 characters and it carries no duration, performer id
 * or subject, so a form seeded from it would silently discard the tail of somebody's notes on
 * save. It is therefore scoped to exactly the principals who may perform that save, through the
 * same `loadModifiableEntry` the two writes use: a reader who cannot edit gains nothing here they
 * could not already see on the timeline.
 */
export async function getManualCommunicationLog(req: Request, res: Response) {
  try {
    const entry = await loadModifiableEntry(req, res);
    if (!entry) return;
    res.json({ entry: toResponse(entry, await getRequestOrgTimezone(req)) });
  } catch (err) {
    logger.error('Failed to read manual communication log:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * PUT /api/communication/manual-log/:id — correct an entry.
 *
 * THE WHOLE EDITABLE RECORD, replaced (see the schema's own comment for why PUT and not PATCH).
 * Channel, direction, occurred-at, performer, notes, duration, subject — and WHICH LEAD
 * OR JOB the entry hangs off, which is how an entry gets moved between the two.
 *
 * WHAT AN EDIT CANNOT CHANGE:
 *
 *   THE LOGGER. Set at creation, never a client input, and `.strict()` refuses a body naming it.
 *   Telling an eyewitness record from a second-hand one is the point of keeping both.
 *
 *   THE ORGANISATION. The row is resolved tenant-scoped and `organization_id` is not in the
 *   update payload at all, so an entry cannot be moved between tenants even by a caller who
 *   discovered a foreign id.
 *
 *   `contacted_at` ON THE LEAD. Slice 7 stamps it when an outbound entry is CREATED on a lead,
 *   first-write-wins, because the stamp records the FIRST time somebody reached that customer.
 *   An edit is a correction to the record of a conversation, not a new conversation, so it does
 *   not re-run the stamp — correcting a typo three weeks later must not move a lead's response
 *   time to today. The consequence is stated rather than hidden: an entry corrected from inbound
 *   to outbound will not stamp a lead that has never been contacted, and one corrected the other
 *   way leaves an existing stamp in place. Both are the conservative direction — the clock is
 *   never moved by a keystroke that was not itself a conversation.
 *
 * AN ENTRY ALREADY DATED IN THE FUTURE IS STILL CORRECTABLE HERE. The future bound is on the
 * VALUE THE REQUEST CARRIES, never on the stored row, so `loadModifiableEntry` and the read and
 * delete paths do not consult it at all: a row that predates the guard can be opened, corrected
 * to a real time, and saved. What it cannot do is be saved back UNCHANGED, and that is the point
 * — the only edit refused is the one that re-asserts the wrong value.
 *
 * ONE WRITE, SO NOTHING TO WRAP. The create path performs three — the row, the contacted-at
 * stamp, the activity event — and they are wrapped in a single interactive transaction (C15, see
 * its own block above), because an entry that committed without its audit event would put a
 * silent hole in a trail the delete path deliberately makes immutable. That hazard does not arise
 * here or on the delete: each is a single statement, so it either happens or it does not, and the
 * status code says which. Adding a second write to either of them means opening a transaction
 * around it too — the create's block is the model, including why the batch form is not an option.
 */
export async function updateManualCommunicationLog(req: Request, res: Response) {
  try {
    const body = req.body as UpdateBody;

    const entry = await loadModifiableEntry(req, res);
    if (!entry) return;

    // The ORG's clock, not the browser's and not the server's — the same composition as create,
    // through the same function. An edit is exactly as capable of landing on the wrong day as a
    // creation is, and a rep in another timezone correcting "yesterday, 4pm" has to land on the
    // ORGANISATION's yesterday both times.
    const timeZone = await getRequestOrgTimezone(req);
    const occurredAt = resolveOccurredAtOr400(res, body.occurred_at, timeZone);
    if (!occurredAt) return;

    // The RE-POINTED anchor, resolved tenant-scoped by the same helper create uses: a lead or job
    // belonging to another organisation is not-found, whether or not the entry already hung off
    // one this caller can see.
    if (!(await resolveAnchorOr404(req, res, body))) return;
    if (!(await resolvePerformerOr404(req, res, body.performed_by))) return;

    const row = (await prisma.manualCommunicationLog.update({
      where: { id: entry.id },
      data: {
        channel: CHANNEL[body.channel],
        direction: DIRECTION[body.direction],
        occurred_at: occurredAt,
        performed_by: body.performed_by,
        notes: body.notes,
        // Explicit NULLs, not omissions. This is a replacement, so a field the user cleared is
        // cleared in the row — an omitted key would silently retain yesterday's answer, which is
        // how a duration typed against a call survives onto an email.
        duration_minutes: body.duration_minutes ?? null,
        subject: body.subject ?? null,
        // BOTH anchors are written on every edit, exactly one of them non-null. Writing only the
        // one the body names would leave the old one set and produce a row naming both — the
        // state the DB's `manual_communication_logs_exactly_one_anchor` CHECK refuses, and the
        // one that would be double-counted on two timelines.
        lead_id: body.lead_id ?? null,
        job_id: body.job_id ?? null,
        customer_id: body.customer_id ?? null,
      },
    })) as ManualLogRow;

    res.json({ entry: toResponse(row, timeZone) });
  } catch (err) {
    logger.error('Failed to update manual communication log:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * DELETE /api/communication/manual-log/:id — remove an entry logged on the wrong record.
 *
 * The same two-step refusal as the update: not-found outside the organisation, forbidden inside
 * it for anyone who is neither the logger nor an admin.
 *
 * 204, with no body. There is nothing left to return, and an empty `{}` at 200 would invite a
 * client to read a field off it.
 *
 * THE ACTIVITY EVENT THE CREATE WROTE IS DELIBERATELY LEFT STANDING.
 *
 * It cannot be paired with this row in any case — `COMMUNICATION_LOGGED` is written with
 * `metadata` NULL, so it carries no reference back to the entry that produced it — but the
 * decision is not driven by that. It is that an audit trail a deletion can erase is a weak audit
 * trail. The event's claim is "a human added a record here, and this is who": that claim stays
 * true after the record is removed, and it is exactly the claim somebody auditing a disputed
 * entry needs to be able to read. Adding a reference so that delete could remove the pair would
 * make the feature's one audit surface erasable by the person with the most reason to erase it.
 *
 * The consequence, stated rather than hidden: a lead's activity feed can carry "Outbound call
 * logged" for an entry that is no longer on the Communication tab. That reads correctly — the
 * conversation was logged, and then the log was removed — and no DELETED event is written to say
 * so, because the spec's rule for this slice is that deleting writes none.
 *
 * `contacted_at` is likewise NOT unwound. The stamp records when a customer was first reached;
 * removing the record of that conversation does not unhappen it, and a delete that could move a
 * lead's clock would let one keystroke rewrite a response-time metric. Slice 7's stamp is
 * first-write-wins and stays where it landed.
 */
export async function deleteManualCommunicationLog(req: Request, res: Response) {
  try {
    const entry = await loadModifiableEntry(req, res);
    if (!entry) return;

    // Addressed by id alone, and safely so: `loadModifiableEntry` resolved that id INSIDE the
    // requester's organisation, so there is no row a foreign id could reach by the time this runs.
    await prisma.manualCommunicationLog.delete({ where: { id: entry.id } });

    res.status(204).send();
  } catch (err) {
    logger.error('Failed to delete manual communication log:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
