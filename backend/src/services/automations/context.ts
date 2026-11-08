/**
 * context.ts — entity loading + merge-context building for automation runs.
 *
 * One org-scoped fetch per entity type, producing:
 *  - the ExecutionBundle the executor consumes (customer, assignees, merge ctx)
 *  - an EntityState snapshot the engine's staleness checks read
 * All dates render in the ORG's timezone; money in the org's currency, full
 * comma-grouped (design-system rule — never k/M abbreviations).
 */

import type { AutomationTriggerType } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { env } from '../../config/env';
import { customerLabel } from '../../lib/tasks/enrich';
import { DEFAULT_TIMEZONE, formatShortDateInZone } from '../../lib/timezone';
import { isLiveVisit } from '../../lib/visit-status';
import { resolveCurrentWalkthrough, resolveNextJobVisit } from '../walkthrough.service';
import { visitLocationSelect, formatVisitLocation } from '../visitLocation';
import {
  formatPerformerPhones, performerPhoneSelect, resolveServWavePhones,
  type PerformerPhoneRow,
} from '../performerPhone';
import type { ExecutionBundle, RecipientUser } from './executors';

/**
 * A person on a visit, as the two arms below read them: everything an audience needs to be
 * MESSAGED (RecipientUser) plus the desk extension the phone merge fields need to be READ.
 *
 * `phone_ext` is added here rather than on `RecipientUser` itself deliberately. That interface is
 * constructed at dozens of sites - typed selects, hand-built dispatch payloads, test fixtures -
 * and its `phone` is required precisely so every one of them is a compile error until it selects
 * the column. Only the two visit-assignee reads need the extension, so widening the shared
 * interface would make forty sites answer for a column thirty-eight of them never render.
 */
type VisitPerson = RecipientUser & PerformerPhoneRow;

/**
 * What `visitMergeFields` needs to know about one member of a trip's crew: their name, and the
 * two columns that say how to reach them.
 *
 * EXPORTED so the dispatch sites that narrow a nullable relation name one shape instead of each
 * writing a copy of it. DO NOT READ THAT AS ENFORCEMENT. `(u): u is VisitCrewMember => u != null`
 * is a type PREDICATE, and a predicate is a cast rather than a check: it asserts the shape onto
 * whatever the read returned, so a read that asked for the two names alone passes straight
 * through it with tsc silent. Naming the exported type buys a reader one place to look; it buys
 * the compiler nothing.
 *
 * The site that narrows this way - job.controller.ts's PATCH-reschedule pre-read - is therefore
 * held by an assertion on that read's `select` in `job-visit-location.test.ts`, not by the
 * compiler. `PerformerPhoneRow` records which of the feature's five crew reads the compiler does
 * hold, and why each one is held.
 */
export type VisitCrewMember = { first_name: string; last_name: string } & PerformerPhoneRow;

export interface EntityState {
  jobStatus?: string;
  jobScheduledStart?: Date | null;
  jobCompletedAt?: Date | null;
  invoiceStatus?: string;
  invoiceAmountDue?: number;
  invoiceDueDate?: Date | null;
  estimateStatus?: string;
  estimateValidUntil?: Date | null;
  leadStatus?: string;
  leadWalkthroughScheduledAt?: Date | null;
  // The CURRENT visit's (D15) own status - SCHEDULED | COMPLETED | CANCELLED (the lead door
  // also allows the three live in-progress values, which only job visits reach in practice).
  // terminalStale.ts's WALKTHROUGH_SCHEDULED/_RESCHEDULED and LEAD_DATE_ANCHORED('before')
  // staleness guards key off THIS, not leadStatus. The lead's own status does follow its visits
  // (Walkthrough Scheduled / Walkthrough Completed, moved by syncLeadWalkthroughStatus), but it
  // describes ALL of the lead's visits together, while a reminder is about ONE trip: the lead
  // can be Walkthrough Scheduled because a second trip is booked while this trip was cancelled.
  // Estimate Sent, Won, Lost and Cancelled leads are never moved by a visit at all, so the
  // lead status cannot say whether a given trip is still pending.
  leadVisitStatus?: string | null;
  // ── Lead stage clocks (spec #1751 D8) ────────────────────────────────────
  // Read by anchorDateFor for the three new lead anchors, and by terminalStale's
  // "…and it still has not happened" guard, which needs the NEXT clock along to decide whether
  // the thing the owner was waiting for has since occurred. Both halves have to see the same
  // snapshot, which is why they are loaded here rather than re-queried at either site.
  leadCreatedAt?: Date | null;
  leadContactedAt?: Date | null;
  leadWalkthroughFirstBookedAt?: Date | null;
  leadLastVisitCompletedAt?: Date | null;
  leadFirstEstimateSentAt?: Date | null;
  // ── Task (Spec B) ────────────────────────────────────────────────────────
  // Both halves of the engine read THIS snapshot: anchorDateFor resolves the due-date
  // anchor from `taskDueAt`, and the send-time staleness guard reads `taskStatus` to stop
  // chasing a task that finished while an enrollment was parked. Loaded once here for the
  // same reason the lead stage clocks are - two re-queries would eventually disagree.
  taskStatus?: string;
  taskDueAt?: Date | null;
}

export interface LoadedExecution {
  bundle: ExecutionBundle;
  state: EntityState;
}

interface OrgRow {
  name: string;
  phone: string | null;
  timezone: string | null;
  currency: string;
  logo_url: string | null;
  brand_color: string;
}

/**
 * ── SUPERSEDES D7 OF THE VISIT-LOCATION SPEC ──────────────────────────────────────
 * READ THIS BEFORE CITING D7. `2026-09-10-visit-location-and-performer-phone.md` D7 is titled
 * "Never resolve to an empty string", and it says the opposite of the second half of this note:
 *
 *     "The usual guard, `?? ''`, is equally wrong here: 'Please meet us at .' is broken copy
 *      that has already been sent."
 *
 * That decision is why SERVICE_ADDRESS_FALLBACK and MAIN_LINE_FALLBACK exist. It was argued, not
 * defaulted, and grepping D7 will turn up a spec forbidding exactly what this module now does -
 * so the divergence is stated here rather than left for somebody to trip over.
 *
 * WHAT CHANGED SINCE D7 WAS WRITTEN. The 2026-09-13 scheduling-notifications build shipped a
 * per-step, author-editable "If empty, fill with" map (`mergeFieldFallbacks.ts`), applied by
 * `renderMergeFields` ONLY when a field resolves to ''. D7 predates it, so at the time a phrase
 * in this module was the only place standby wording COULD live. It no longer is, and a phrase
 * here now actively breaks the newer layer: a field that never goes empty can never reach the
 * author's box, so their setting is unreachable and uneditable.
 *
 * Ran's call, 2026-09-14, on both halves: the phrase was fitted to one sentence and misread in
 * the others ("{{org.name}} · {{org.phone}}" rendered "Acme · our office" in three seeded
 * signature lines), and the standby wording belongs where an author can change it.
 *
 * D7's FIRST half still binds, unchanged, and is asserted below and in the sweep:
 *
 * `undefined` is still forbidden here, and for an unchanged reason: `renderMergeFields` leaves an
 * UNKNOWN field literal on purpose, so a typo'd `{{customer.frist_name}}` stays visible in the
 * preview instead of vanishing. A field this module forgets to write therefore prints its own
 * token in a customer's inbox. Every advertised field must be an own property of the context.
 *
 * WHAT IT MUST RESOLVE TO IS A VALUE, OR ''. Not a phrase. A merge field is a variable, and the
 * sentences it lands in are unbounded - the seeded copy is a handful of them, and every template
 * an org writes afterwards is the rest. A phrase tuned to one sentence reads as a defect in the
 * others: 'our office' was fitted to "Questions? Call {{org.phone}}." and rendered the signature
 * line "{{org.name}} · {{org.phone}}" as "Acme · our office".
 *
 * So the standby wording lives one layer up, per send step, in the author's own "If empty, fill
 * with" map - `mergeFieldFallbacks.ts` for the defaults, applied by `renderMergeFields` when a
 * field resolves to ''. That layer is editable and clearable; a phrase here is neither, and worse,
 * it SHADOWS the author's setting: a field this module never lets go empty can never reach the
 * fallback the author configured for it. That collision is real - `customer.first_name` carried
 * 'there' in BOTH places until this change, and the copy here won.
 *
 * The one substitution that stays is VALUE-FOR-VALUE: a company customer has no `first_name`, so
 * the name fields walk to `company_name` (see `customerDisplayName`). That is still a real name
 * off the same record, and it reads correctly in any sentence, which is exactly what a phrase
 * cannot promise.
 *
 * Dates, times and links take neither: a date has no standby wording, and prose in a URL slot is
 * a dead link the customer clicks. Those need the surrounding clause suppressed - conditional
 * template sections, tracked separately - and stay '' here meanwhile.
 *
 * THE ADDRESS AND PHONE PHRASES ARE NO LONGER INJECTED HERE AT ALL (Ran, 2026-09-15). They were,
 * and that is exactly what made "If empty, fill with" a dead box on nine fields: a value this
 * module had already filled is never empty, so the renderer's "empty -> the author's text" rule
 * could not fire and whatever the author typed was silently ignored. Those nine now resolve '',
 * `mergeFieldFallbacks.ts` seeds the same two phrases as their defaults, and the renderer applies
 * them. The customer reads exactly what they read before; the wording became the author's.
 *
 * The invariant the sharing existed for is unchanged: {{lead.address}} beside
 * {{lead.walkthrough_location}}, and {{org.phone}} beside {{lead.performer_phones}}, must not
 * offer two different phrases for one absent thing. They still come off ONE resolution each, and
 * they now carry one seeded fallback each rather than one hard-coded phrase each.
 */

/**
 * How this product writes a customer's name, and the reason `customer.full_name` is the one field
 * in this sweep that gets a VALUE rather than a phrase.
 *
 * A COMPANY customer has no `first_name` and no `last_name` - its name lives in `company_name` -
 * so `[first, last].join(' ')` resolved to '' for every B2B customer in the product, which is not
 * a degenerate row but an entire customer kind. The ladder is `customerLabel`'s (lib/tasks/enrich
 * .ts), which is the convention the task list, the entity pickers and this file's own
 * `taskLinkedRecordLabel` already display a customer by: company, else person, else the customer
 * number.
 *
 * Returns '' for "no customer row", NOT a phrase - the callers below choose their own terminal
 * wording, because a salutation and an identifier do not degrade to the same words.
 *
 * TRIMMED at every rung: `company_name` is free text and ' ' is truthy, joins to ' ', and renders
 * "Hi  ," - the same hole with whitespace in it. Same argument `formatVisitOwnLocation` states.
 */
function customerDisplayName(c: CustomerRow | null | undefined): string {
  if (!c) return '';
  return (
    c.company_name?.trim() ||
    [c.first_name, c.last_name].map((p) => p?.trim()).filter(Boolean).join(' ') ||
    c.customer_number?.trim() ||
    ''
  );
}

function money(amount: unknown, currency: string): string {
  const n = Number(amount ?? 0);
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(n);
}

function fmtDate(date: Date | null | undefined, timeZone: string): string {
  return date ? formatShortDateInZone(date, timeZone) : '';
}

function fmtTime(date: Date | null | undefined, timeZone: string): string {
  if (!date) return '';
  try {
    return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone }).format(date);
  } catch {
    return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: DEFAULT_TIMEZONE }).format(date);
  }
}

/**
 * Multi-visit D18: the merge fields a VISIT-scoped occurrence overrides on its parent job.
 *
 * The job branch below renders `job.scheduled_date` / `job.scheduled_time` off
 * Job.scheduled_start, which under D14 is a MIRROR of the job's next upcoming visit - so a
 * workflow enrolled by visit 3 would tell the customer visit 2's date, and `technician.names`
 * would name the job-level union rather than the crew going on that trip. The enrollment is
 * visit-scoped (dedupe.ts); this is what makes what it SENDS visit-scoped too.
 *
 * Written by the dispatching controller into event_payload.mergeFields, which is persisted on the
 * enrollment and re-applied on EVERY step load - so the override survives however many WAIT steps
 * sit before the send. The same channel `event.reason` already travels on.
 *
 * IT WAS NOT THE WHOLE OF D18, AND THE OTHER HALF NOW EXISTS ELSEWHERE. This is a string bag, so
 * it could only ever override merge fields; `EntityState` - and with it the anchored WAIT's fire
 * moment, `stopIf` and `terminalStale` - is not a string and was still resolved per ENTITY. The
 * per-visit-enrollment spec (2026-09-14) closed that half where it belonged: the enrollment
 * persists `visit_id` and `loadEntityBundle` resolves THAT trip, so both halves now agree.
 *
 * THIS FUNCTION STAYS, unchanged and required (that spec's D11). A dispatch site knows the
 * triggering visit; the enrollment it creates carries the same id, so the override and the
 * resolution now describe one trip rather than two. Removing it is separate work.
 */
export function visitMergeFields(
  visit: { scheduled_at?: Date | null },
  /**
   * The people on THIS trip - so that an occurrence keyed to one visit cannot render that visit's
   * crew beside the job-level union's numbers; see `technician.phones` below.
   *
   * `phone`/`phone_ext` are REQUIRED on the shape (slice 5), but this parameter is NOT what makes
   * a dispatch site's read ask Postgres for them: a site that narrows its rows with a
   * `VisitCrewMember` type predicate satisfies this signature whatever it selected. See
   * `VisitCrewMember` above for which site that is and what holds it instead.
   */
  crew: VisitCrewMember[],
  timeZone: string,
  /**
   * Where THIS trip is happening, already formatted by `formatVisitLocation` (visit-location
   * spec, slice 4). A REQUIRED parameter, not an optional one, and for the same reason
   * `resolveVisitLocationWrite`'s `currentLocationId` is: optional, it defaults to "say nothing",
   * and a dispatch site that forgot it would fall back to the job's per-ENTITY resolution - the
   * job's next upcoming visit - handing the customer visit 3's date beside visit 2's address.
   * Required, TypeScript makes each dispatch site state its answer out loud.
   *
   * Formatted by the CALLER rather than derived here, because following the pointer takes a
   * database read and this function has no client: a visit row handed straight in would carry
   * `location_id` and no relation, and the formatter would silently fall through to the service
   * address - a real address, in the right format, and the wrong place.
   */
  visitLocation: string,
  /**
   * The organisation's main line, already resolved to the string `{{org.phone}}` renders -
   * `getOrgMainLine` is the read. REQUIRED for the same reason `visitLocation` is: what
   * `technician.phones` falls back to must be decided by the dispatch site that knows the org,
   * and a defaulted '' here would put "Questions? Call ." in the one place D7 forbids it.
   */
  orgPhone: string,
  /**
   * The ORGANISATION'S number for the people on this trip, already resolved to a display string by
   * `resolveServWavePhones` (slice 7) - the whole of D7's four-rung chain, fallback included.
   *
   * Resolved by the CALLER for the reason `visitLocation` is: it takes a database read (the
   * person's default assignment, then the organisation's) and this function has no client. It is
   * REQUIRED for the reason both of those are, and the reason is sharper here. The override is
   * applied as a PARTIAL SPREAD over the per-entity context, so a dispatch site that simply left
   * this key out would keep the job-level union's number - a real, correctly-formatted number
   * belonging to somebody who is not going - with no error and nothing in the rendered string to
   * say so. Required, every site states its answer out loud or does not compile.
   *
   * Note it sits BESIDE `orgPhone` rather than replacing it: the two fields are alternatives an
   * author picks between, so one occurrence has to be able to render both. That both are plain
   * strings is the one hazard of this signature - a site could transpose them and compile - which
   * is why `job-visit-location.test.ts` pins every site against a fixture where the crew's number,
   * the organisation's default and the main line are three different values.
   */
  servwavePhones: string,
): Record<string, string> {
  const names = crew.map((u) => `${u.first_name} ${u.last_name}`.trim()).filter(Boolean);
  return {
    'job.scheduled_date': fmtDate(visit.scheduled_at ?? null, timeZone),
    'job.scheduled_time': fmtTime(visit.scheduled_at ?? null, timeZone),
    'job.visit_location': visitLocation,
    // '' for a crewless visit: the words go in the step's "If empty, fill with", so a crewless
    // trip renders the author's text, never ours.
    'technician.first_name': crew[0]?.first_name?.trim() ?? '',
    // Slice 5, and it travels HERE rather than only per entity for the same reason
    // `technician.names` does. The job arm below resolves one crew - the deduped UNION across
    // every trip on the job - and this object is spread OVER that context, so a key left out of
    // it keeps the union's answer. An occurrence keyed to visit 3 would then name visit 3's crew
    // beside a number belonging to somebody on visit 2: worse than the names mismatch it sits
    // next to, because the customer dials it.
    'technician.phones': formatPerformerPhones(crew, orgPhone),
    // Slice 7, and it travels here for exactly the reason its sibling above does - the spread is
    // partial, so a key left out silently keeps the job-level union's answer. Already resolved by
    // the dispatch site; this object only states it.
    'technician.servwave_phones': servwavePhones,
    // '' for an empty crew, for the same reason as `technician.first_name` above.
    'technician.names': names.join(', '),
  };
}

// ── task helpers (Spec B) ───────────────────────────────────────────────────

/**
 * Human words, not shouted enum labels. These emails are read by technicians, and
 * "IN_PROGRESS"/"URGENT" in the middle of a sentence reads as a leak, not as information.
 * Falls back to the raw value so an enum member added without a label degrades to something
 * legible rather than to an empty string.
 */
const TASK_STATUS_LABELS: Record<string, string> = {
  TODO: 'To do',
  IN_PROGRESS: 'In progress',
  BLOCKED: 'Blocked',
  DONE: 'Done',
  CANCELLED: 'Cancelled',
};

const TASK_PRIORITY_LABELS: Record<string, string> = {
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
  URGENT: 'Urgent',
};

/**
 * A readable label for the record a task hangs off - "Job J00042", "Sarah Mitchell".
 *
 * Org-scoped on every arm, and every arm tolerates a miss: `linked_entity_id` carries no
 * foreign key either, so a deleted job leaves a dangling link, and the correct rendering of
 * a dangling link is an empty merge field rather than a throw.
 *
 * Deliberately NOT routed through lib/tasks/enrich's resolveEntityLabels: that function
 * redacts against a READER's entity scope, and an automation has no reader - its audience
 * is whichever staff the admin addressed. Per-reader redaction of an automation body is its
 * own decision, not a rider on this one.
 */
async function taskLinkedRecordLabel(
  type: string | null,
  id: string | null,
  organizationId: string,
): Promise<string> {
  if (!type || !id) return '';
  switch (type) {
    case 'JOB': {
      const job = await prisma.job.findFirst({ where: { id, organization_id: organizationId }, select: { job_number: true } });
      return job ? `Job ${job.job_number}` : '';
    }
    case 'LEAD': {
      const lead = await prisma.lead.findFirst({ where: { id, organization_id: organizationId }, select: { lead_number: true } });
      return lead ? `Lead ${lead.lead_number}` : '';
    }
    case 'ESTIMATE': {
      const estimate = await prisma.estimate.findFirst({
        where: { id, organization_id: organizationId },
        select: { estimate_number: true },
      });
      return estimate ? `Estimate ${estimate.estimate_number}` : '';
    }
    case 'CUSTOMER': {
      const customer = await prisma.customer.findFirst({
        where: { id, organization_id: organizationId },
        select: { company_name: true, first_name: true, last_name: true, customer_number: true },
      });
      // Same "company, else person, else number" convention the task list itself uses.
      return customer ? customerLabel(customer) : '';
    }
    default:
      return '';
  }
}

/**
 * The task's people, off bare Postgres uuid[] columns with no foreign key (see the Task
 * model's own comment) - so they are fetched by id rather than through a relation include.
 * ONE query for the union of every list the caller cares about.
 *
 * Ids that do not come back are DROPPED, silently and on purpose. Nothing in the database
 * removes a deactivated user's id from either array - lib/tasks/deactivation.ts does it in
 * the application layer - so a row a sweep missed still carries one, and the alternatives
 * are a recipient with no email address or a thrown enrollment.
 */
async function loadTaskPeople(organizationId: string, ids: string[]): Promise<Map<string, RecipientUser>> {
  const unique = [...new Set(ids)];
  const people = unique.length
    ? await prisma.user.findMany({
        where: { id: { in: unique }, organization_id: organizationId, is_active: true },
        select: { id: true, email: true, first_name: true, last_name: true, phone: true },
      })
    : [];
  return new Map<string, RecipientUser>(people.map((u) => [u.id, u]));
}

/**
 * STORED order, not query order: the assignee list is what the office typed, and
 * {{task.assignee_names}} reads back the way they wrote it. `flatMap` rather than map+filter
 * so the drop is a widening the compiler checks, not a hand-written type predicate (the
 * select's row type is NARROWER than RecipientUser, so a predicate over it does not typecheck).
 */
function inStoredOrder(byId: Map<string, RecipientUser>, ids: string[]): RecipientUser[] {
  return ids.flatMap((id) => {
    const user = byId.get(id);
    return user ? [user] : [];
  });
}

interface CustomerRow {
  id: string;
  /**
   * A COMPANY customer's name, and the reason `customer.full_name` rendered '' for every B2B
   * customer until this was read. OPTIONAL on this interface, not on the row: every branch below
   * loads its customer through CUSTOMER_INCLUDE, and a Prisma `include` returns every scalar - so
   * these two are always present at runtime. Optional here so a hand-built fixture that predates
   * them still typechecks and degrades down the ladder rather than off the end of it.
   */
  company_name?: string | null;
  /** The last rung of the display ladder, and NOT NULL on the model - see `customerDisplayName`. */
  customer_number?: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  /** Opted-in secondary addresses only — narrowed by CUSTOMER_INCLUDE, see below. */
  extra_emails?: { email: string }[];
}

/**
 * The customer include shared by every entity branch below. `extra_emails` is narrowed
 * to the addresses opted in to automated mail (`customer_emails.receives_emails`) — the
 * opt-out is enforced HERE, in the query, so an opted-out address can never reach an
 * executor no matter what the downstream code does with the bundle.
 * -> recipients.ts, the `customer` audience.
 */
const CUSTOMER_INCLUDE = {
  include: { extra_emails: { where: { receives_emails: true }, select: { email: true } } },
};

/**
 * The three customer merge fields, none of which may resolve to '' (D7 - see the block above
 * `money`).
 *
 * ONE LADDER, TWO TERMINALS. All three fields walk the same rungs and differ only in where they
 * start and how they end, because a COMPANY customer has no first or last name and the honest
 * answer to "what do we call them" is the same string in all three slots: "Hi Harbor Cabinet Co,"
 * is how a real business addresses a company account, and it is what `customer.full_name` says
 * two lines further down the same email.
 *
 * The terminals differ because the SENTENCES differ, which is the same reason 'Our team' is
 * capitalised and 'our office' is not. `full_name` identifies a record in staff copy, so it ends
 * at the customer NUMBER and only then at a phrase. `first_name` / `last_name` greet a person, so
 * they end at 'there' - "Hi there," - and never at a number.
 */
function customerCtx(c: CustomerRow | null | undefined): Record<string, string> {
  const display = customerDisplayName(c);
  const first = c?.first_name?.trim();
  const last = c?.last_name?.trim();
  const company = c?.company_name?.trim();
  return {
    'customer.first_name': first || company || last || '',
    'customer.last_name': last || company || first || '',
    'customer.full_name': display,
  };
}

/**
 * The owner sign-off (SRVW-303): `{{lead.owner_name}}` / `{{job.owner_name}}` /
 * `{{estimate.owner_name}}` and their first-name halves, so a confirmation can end with the
 * name of the person who sold the work rather than with {{org.name}}.
 *
 * "Owner" is the word the lead form, the assign popover and the leads table already use; the
 * bundle's `salesperson` is the SAME person, resolved the SAME way, and the two are fed from one
 * value at every call site so an audience and a signature can never name different people.
 *
 * '' when nobody owns the record - never a phrase. The words for an unowned lead belong to the
 * step's own "If empty, fill with", seeded from `DEFAULT_MERGE_FIELD_FALLBACKS`, exactly as
 * `technician.first_name` does it. A value-level substitution here (the org name, say) would
 * make that box a dead control for this field, which is the defect class fixed on 2026-09-15.
 */
function ownerCtx(
  prefix: 'lead' | 'job' | 'estimate',
  owner: { first_name: string | null; last_name: string | null } | null | undefined,
): Record<string, string> {
  const first = owner?.first_name?.trim() ?? '';
  const last = owner?.last_name?.trim() ?? '';
  return {
    [`${prefix}.owner_name`]: [first, last].filter(Boolean).join(' '),
    [`${prefix}.owner_first_name`]: first,
  };
}

/**
 * The event recipient, read back off JSON that was written BEFORE this field existed.
 *
 * `event_payload` is persisted on the enrollment at dispatch and replayed on every step, so
 * an enrollment already in flight (parked at a WAIT, or mid-run when this deployed) carries a
 * recipient object with NO `phone` key at all. Prisma's Json type is structurally `any` here,
 * so that absence type-checks and would ride into the executor as `undefined` - which reads
 * as "not yet loaded" everywhere the executor looks at it, rather than as the truth, which is
 * "this run has no number for them". Normalized to null once, here, at the JSON seam.
 */
function normalizeEventRecipient(recipient: RecipientUser | null | undefined): RecipientUser | null {
  if (!recipient) return null;
  return { ...recipient, phone: recipient.phone ?? null };
}

/**
 * Anything the triggering event captured that the live entity can't reproduce
 * later — persisted on the enrollment as event_payload, read back in on
 * EVERY step (so it survives a WAIT of any length, unlike a one-time entity
 * load). `mergeFields` are free-form (e.g. `event.reason`); `recipient` feeds
 * ExecutionBundle.eventRecipient for the removed_user audience (recipients.ts).
 */
export interface EventPayload {
  mergeFields?: Record<string, string>;
  recipient?: RecipientUser | null;
  /**
   * Rule 0 (never tell someone about their own action): the user whose request
   * dispatched the event. It rides HERE rather than in memory because
   * advanceEnrollment takes only an enrollment id and the cron sweeper resumes a
   * parked enrollment long after the request is gone - an in-memory actor would
   * be lost at the first WAIT, exactly where nobody would notice. Absent on the
   * actorless paths (cron sweeps, Stripe webhooks, public doors) and on every
   * enrollment created before this shipped, both of which load as null.
   */
  actorId?: string | null;
  /**
   * Spec B slice 4 - who was on a task that no longer exists.
   *
   * Task deletion is a HARD delete (task.controller.ts's remove handler drops the row and its
   * comments inside one transaction), so a TASK_DELETED enrollment's every step reads a task
   * that is gone. The delete handler already snapshots these three id sets BEFORE opening that
   * transaction, for the bell's `task.deleted` verb; the dispatch carries the same snapshot
   * here so the AUDIENCE can be resolved from it too.
   *
   * IDS, not user rows: the people still exist, only the task is gone, so their contact details
   * are read live and stay subject to the same org scoping and is_active filter the live task
   * arm applies. What the snapshot pins is the ROSTER - who was on the task at the moment it
   * was destroyed - which is the only part no query could recover afterwards.
   *
   * Read at EXACTLY ONE place (the task arm of loadEntityBundle) and only when the enrollment's
   * pinned trigger is TASK_DELETED. Never widen that: a synthesis that fired for any missing
   * task would make every task trigger survive deletion, so a deleted task would keep taking
   * its due-date reminders - the inverse of what the staleness rules promise.
   */
  taskSnapshot?: { assigneeIds: string[]; watcherIds: string[]; creatorId?: string | null };
}

export async function loadExecutionBundle(args: {
  entityType: string;
  entityId: string;
  entityLabel?: string | null;
  organizationId: string;
  dedupeKey: string;
  eventPayload?: EventPayload | null;
  /**
   * The enrollment's PINNED trigger. Governs one thing only: whether the task arm may
   * synthesise a bundle for a row that is gone (see EventPayload.taskSnapshot). Optional, and
   * absent means "no", so every caller that does not pass it - and every one of the other four
   * entities whatever it passes - keeps the pre-existing contract byte for byte: a missing row
   * yields null and the caller stops the enrollment.
   */
  trigger?: AutomationTriggerType | null;
  /**
   * WHICH VISIT this enrollment is about, read back off `workflow_enrollments.visit_id` (spec
   * 2026-09-14-per-visit-automation-enrollment, D1).
   *
   * Given one, the job and lead arms resolve THAT trip instead of calling `resolveNextJobVisit` /
   * `resolveCurrentWalkthrough` on the parent - so the merge fields, the `EntityState` the
   * anchored WAIT and the staleness checks read, and `rearmAnchoredWaits`' occurrence re-sync are
   * all corrected by one edit rather than by an override layer. An override would fix the strings
   * and leave the state wrong, which is the situation this replaces.
   *
   * Absent - every row written before the column existed, every non-visit trigger, every entity
   * with no visits - nothing changes, byte for byte.
   */
  visitId?: string | null;
}): Promise<LoadedExecution | null> {
  const loaded = await loadEntityBundle(args);
  if (!loaded) return null;
  return {
    ...loaded,
    bundle: {
      ...loaded.bundle,
      eventRecipient: normalizeEventRecipient(args.eventPayload?.recipient),
      actorId: args.eventPayload?.actorId ?? null,
      mergeCtx: { ...loaded.bundle.mergeCtx, ...args.eventPayload?.mergeFields },
    },
  };
}

/**
 * The bundle for a task that no longer exists - Spec B slice 4, and the ONE place in this
 * module that builds an execution context without reading the entity it is about.
 *
 * Returns null unless BOTH halves of the narrow gate hold:
 *   * the enrollment's pinned trigger is TASK_DELETED, and
 *   * the persisted event_payload actually carries the pre-delete roster snapshot.
 *
 * Either half missing means the caller sees exactly what it saw before this function existed
 * - null, and the enrollment finishes STOPPED with "The task no longer exists". That is the
 * right answer for every other task trigger: a reminder or a comment mail about work that has
 * been destroyed is worse than silence. It is also the right answer for a TASK_DELETED
 * enrollment written before this shipped, whose payload has no snapshot to synthesise from.
 *
 * What is deliberately NOT here:
 *   * no EntityState. A deleted task has no status and no due date, so it must not be judged
 *     on one; the empty state is what makes an anchored WAIT on this trigger stop for the
 *     anchor's own honest reason rather than fire against a fabricated date.
 *   * no task.* merge fields. The identity strings ride event_payload.mergeFields and are
 *     merged over this context by loadExecutionBundle, exactly as `event.reason` and the
 *     per-visit overrides already do. Every other task field is ABSENT rather than empty, so
 *     a body that somehow references one renders it literally instead of as a blank - and the
 *     catalogue does not offer them, so workflowValidation refuses to save one at all.
 */
async function deletedTaskBundle(
  args: {
    entityId: string;
    entityLabel?: string | null;
    organizationId: string;
    eventPayload?: EventPayload | null;
    trigger?: AutomationTriggerType | null;
  },
  base: Omit<ExecutionBundle, 'entityRef' | 'customer' | 'assignees' | 'mergeCtx' | 'jobRef'>,
  orgCtx: Record<string, string>,
): Promise<LoadedExecution | null> {
  if (args.trigger !== 'TASK_DELETED') return null;
  const snapshot = args.eventPayload?.taskSnapshot;
  if (!snapshot) return null;

  const assigneeIds = snapshot.assigneeIds ?? [];
  const watcherIds = snapshot.watcherIds ?? [];
  const creatorId = snapshot.creatorId ?? null;
  // The people outlived the task, so their contact details are read live and stay subject to
  // the same org scoping and is_active filter the live arm applies. Only the ROSTER comes from
  // the snapshot, because only the roster is unrecoverable once the row is gone.
  const byId = await loadTaskPeople(args.organizationId, [
    ...assigneeIds,
    ...watcherIds,
    ...(creatorId ? [creatorId] : []),
  ]);

  return {
    bundle: {
      ...base,
      // The title, persisted on the enrollment at dispatch. Same choice, same reason, as the
      // live arm and the bell verbs: a task's number means nothing to the person being told.
      entityRef: { type: 'task', id: args.entityId, label: args.entityLabel ?? null },
      customer: null,
      assignees: inStoredOrder(byId, assigneeIds),
      watchers: inStoredOrder(byId, watcherIds),
      creator: creatorId ? byId.get(creatorId) ?? null : null,
      jobRef: null,
      mergeCtx: { ...orgCtx },
    },
    state: {},
  };
}

async function loadEntityBundle(args: {
  entityType: string;
  entityId: string;
  entityLabel?: string | null;
  organizationId: string;
  dedupeKey: string;
  eventPayload?: EventPayload | null;
  trigger?: AutomationTriggerType | null;
  /** The enrollment's own visit — see loadExecutionBundle above. */
  visitId?: string | null;
}): Promise<LoadedExecution | null> {
  const org = (await prisma.organization.findUnique({
    where: { id: args.organizationId },
    select: { name: true, phone: true, timezone: true, currency: true, logo_url: true, brand_color: true },
  })) as OrgRow | null;
  if (!org) return null;

  const tz = org.timezone || DEFAULT_TIMEZONE;
  // Resolved ONCE and used twice - as {{org.phone}} and as what the two phone fields fall back to
  // - so a customer can never be told to call one number in a sentence that then prints another.
  //
  // '' WHEN THE COLUMN IS BLANK, AND THE PHRASE IS THE STEP'S (Ran, 2026-09-15). `MAIN_LINE_FALLBACK`
  // used to be substituted right here, which is what made "If empty, fill with" a dead box on all
  // five phone fields: the value was never empty, so the renderer's "empty -> the author's text"
  // rule could not fire. It is now the seeded default for each of them in mergeFieldFallbacks.ts
  // and the renderer applies it, so the customer reads the same words and the author can change
  // them.
  //
  // `Organization.phone` is nullable free text and '' is the state every org is in before somebody
  // fills Settings in, so the seeded walkthrough confirmation - "Questions? Call {{org.phone}}." -
  // was sending "Questions? Call ." to those orgs' customers. That is still fixed; the fix moved
  // one layer out, to where the wording is editable.
  //
  // RESOLVED ONCE AND USED TWICE - as {{org.phone}} and as what the phone fields fall back to -
  // for the reason it always was: a customer must never be told to call one number in a sentence
  // that then prints another. The two now agree because they resolve to the same '' and carry the
  // same seeded fallback, rather than because this line hard-coded the phrase into both.
  const orgPhone = org.phone?.trim() ?? '';
  const orgCtx: Record<string, string> = {
    'org.name': org.name,
    'org.phone': orgPhone,
  };

  const base: Omit<ExecutionBundle, 'entityRef' | 'customer' | 'assignees' | 'mergeCtx' | 'jobRef'> = {
    organizationId: args.organizationId,
    org: { name: org.name, timezone: tz, logo_url: org.logo_url, brand_color: org.brand_color },
    dedupeKey: args.dedupeKey,
    // Only a task has watchers. Defaulted HERE, once, rather than per arm: `watchers` is a
    // required field on ExecutionBundle precisely so a new entity arm cannot forget it, and
    // this is the single place the four watcher-less entities answer for it.
    watchers: [],
  };

  switch (args.entityType) {
    case 'job': {
      const job = await prisma.job.findFirst({
        where: { id: args.entityId, organization_id: args.organizationId },
        include: {
          customer: CUSTOMER_INCLUDE,
          service_location: true,
          sub_status: { select: { label: true } },
          // S8 (D6): crew through the trips. Plus, since the visit-location spec's slice 4, the
          // LOCATION RELATION rather than a copy of its columns: D2's whole point is that
          // correcting the yard's address in Settings changes what an unsent reminder renders,
          // with no write to the visit. `include` already brings every scalar on the visit, so the
          // six location columns arrive for free - the relation is what has to be asked for, and
          // it is spread from the one exported select so every reader of this feature asks for the
          // same thing. Deliberately UNFILTERED: an archived location must go on resolving for the
          // trips already booked at it, or a customer told to come to the yard is sent home.
          visits: {
            include: {
              // `...performerPhoneSelect` is the number AND the extension, spread from the one
              // exported pair (slice 5). Selecting `phone` alone compiles, renders a switchboard
              // number with no way through it, and reads in a customer's inbox as a working
              // contact - so the two columns are asked for as one thing, everywhere.
              assignees: {
                include: {
                  user: {
                    select: {
                      id: true, email: true, first_name: true, last_name: true,
                      ...performerPhoneSelect,
                    },
                  },
                },
              },
              location: visitLocationSelect.location,
            },
          },
          dispatcher: { select: { id: true, email: true, first_name: true, last_name: true, phone: true } },
          salesperson: { select: { id: true, email: true, first_name: true, last_name: true, phone: true } },
          // Salesperson fallback path (job.salesperson_id unset): job → estimate → lead → commission_owner.
          estimate: {
            select: {
              lead: {
                select: { commission_owner: { select: { id: true, email: true, first_name: true, last_name: true, phone: true } } },
              },
            },
          },
          // The last rung (SRVW-303): a multi-estimate conversion writes `estimate_id: null` and
          // `lead_id` on the job (job.controller.ts), so the estimate rung above finds nothing
          // for exactly those jobs. The lead is on the job directly; read its owner there too.
          lead: {
            select: { commission_owner: { select: { id: true, email: true, first_name: true, last_name: true, phone: true } } },
          },
        },
      });
      if (!job) return null;
      // S8 (D6): deduped union across the job's trips - a person on two trips is one recipient.
      const seen = new Set<string>();
      // `VisitPerson`, not `RecipientUser`: the same rows, kept wide enough to still carry the
      // extension when they reach `formatPerformerPhones` below. They narrow to RecipientUser on
      // their way onto the bundle, which is all any audience resolver reads.
      const assignees: VisitPerson[] = [];
      for (const v of job.visits ?? []) {
        for (const a of v.assignees ?? []) {
          if (seen.has(a.user.id)) continue;
          seen.add(a.user.id);
          assignees.push(a.user);
        }
      }
      // S8 §2 (A4, RATIFIED): the anchored-WAIT resolver moves OFF the Job.scheduled_start
      // mirror and onto the same LIVE-visit resolution syncJobFromVisits uses to WRITE that
      // mirror (walkthrough.service.ts's resolveNextJobVisit, called on the isLiveVisit subset -
      // exactly as syncJobFromVisits itself does), so anchorDateFor() and the
      // job.scheduled_date/_time merge fields below read the job's next upcoming live visit
      // fresh rather than trusting a column that is only ever correct between writes.
      // A job with no live visits (none booked, all cancelled, or - per resolveNextJobVisit's
      // own fallback - all elapsed and unactioned) resolves nextVisit to null exactly like the
      // mirror does once D16's collapse applies.
      //
      // ── AND, WHEN THE ENROLLMENT NAMES ITS TRIP, THAT TRIP WINS ─────────────────────────────
      // Per-visit automation enrollment (spec 2026-09-14). visitMergeFields' comment above used to
      // end "that half needs the visit id persisted on the enrollment"; this is that half. The
      // per-JOB resolution below is now the answer only for an enrollment that names no trip -
      // which is every row written before the column existed (D10), every non-visit trigger, and
      // every job with no visits. Those are unchanged byte for byte.
      //
      // A NAMED TRIP THAT IS NOT ON THIS JOB STOPS THE ENROLLMENT (D4). No fallback: the caller
      // finishes it STOPPED naming the visit. Falling back would hand the customer a DIFFERENT
      // trip's date, address and crew, which is the defect - and it is why `visit_id` carries no
      // foreign key (D2), since ON DELETE SET NULL would perform exactly that fallback silently.
      // A trip belonging to another organisation resolves the same way and by the same mechanism:
      // the job above was read with its tenant clause, so a foreign visit is simply not among its
      // visits.
      const carriedVisit = args.visitId
        ? (job.visits ?? []).find((v) => v.id === args.visitId)
        : undefined;
      if (args.visitId && !carriedVisit) return null;
      // The LIVE gate still applies to a carried trip, and it is the same gate `.filter(isLiveVisit)`
      // applies below. A cancelled trip resolving an anchor would let "your appointment is
      // tomorrow" sail past terminalStale's "Job is no longer scheduled" floor and reach a customer
      // whose visit was called off - a regression this change must not introduce while removing a
      // different one. Unlike the lead arm, the job arm has no visit status in EntityState, so
      // "not live" has to be expressed as "no anchor", exactly as today.
      // ONE decision, read by BOTH lines below. Gating the date/location here and the crew
      // separately let a CANCELLED carried trip render the fallback's date beside that trip's crew
      // and phones - two lines describing two different trips. `terminalStale` stops such an
      // enrollment before it can send, so this was latent rather than live; the coherence is the
      // point. A carried trip that is not live is not the trip this message is about, for ANY
      // field, and the answer is the same one a no-trip-named enrollment gets.
      const liveCarried = carriedVisit && isLiveVisit(carriedVisit) ? carriedVisit : null;
      const nextVisit = carriedVisit
        ? liveCarried
        : resolveNextJobVisit((job.visits ?? []).filter(isLiveVisit));
      // Who is going on the trip this message is about. Without a named trip this stays the
      // job-level union, unchanged - and `assignees` (the AUDIENCE, who gets messaged) stays the
      // union either way, which is exactly what visitMergeFields does on the dispatch path: it
      // overrides the technician.* STRINGS for one trip and leaves the audience alone.
      const visitCrew: VisitPerson[] = liveCarried
        ? (liveCarried.assignees ?? []).map((a: { user: VisitPerson }) => a.user)
        : assignees;
      const loc = job.service_location;
      // D7: `service_location_id` is NOT NULL on `model Job`, so the hole here is not a job
      // without a location but a ServiceLocation whose address columns are blank - which makes
      // `filter(Boolean).join(', ')` render '' and the seeded confirmation say "at .".
      // '' rather than SERVICE_ADDRESS_FALLBACK since 2026-09-15: the phrase is the seeded
      // default for `job.address` AND `job.visit_location` in mergeFieldFallbacks.ts, so the two
      // stay indistinguishable in one email body for the same reason as before - one resolution,
      // one set of words - while the words become the author's. See the note on `orgPhone` above.
      const address =
        loc ? [loc.address_line1, loc.city, loc.state].map((v) => v?.trim()).filter(Boolean).join(', ') : '';
      const techNames = visitCrew.map((u) => [u.first_name, u.last_name].filter(Boolean).join(' ')).join(', ');
      // ONE resolution for the audience and the signature: job → estimate → lead → job.lead.
      // `job.salesperson_id` has no writer yet (schema: "writer-less for now"), so in practice
      // this is the lead owner every time; the direct column stays first so a writer, when one
      // lands, is honoured without touching this file.
      const jobOwner =
        job.salesperson ?? job.estimate?.lead?.commission_owner ?? job.lead?.commission_owner ?? null;
      return {
        bundle: {
          ...base,
          entityRef: { type: 'job', id: job.id, label: job.job_number },
          customer: job.customer,
          assignees,
          dispatcher: job.dispatcher ?? null,
          salesperson: jobOwner,
          jobRef: { id: job.id, label: job.job_number },
          mergeCtx: {
            ...orgCtx,
            ...customerCtx(job.customer),
            ...ownerCtx('job', jobOwner),
            'job.number': job.job_number,
            'job.scheduled_date': fmtDate(nextVisit?.scheduled_at ?? null, tz),
            'job.scheduled_time': fmtTime(nextVisit?.scheduled_at ?? null, tz),
            'job.address': address,
            // Where the job visit is ACTUALLY happening, which is the customer's own address only
            // by default (visit-location spec, D1/D7). Resolved against the SAME `nextVisit`
            // `job.scheduled_date` uses - a second notion of "which trip" would let one email name
            // one visit's date beside another visit's address.
            //
            // The service address is passed IN rather than re-derived inside the formatter: the
            // no-location fallback has to be the same string this email renders under
            // {{job.address}} directly above, and a second derivation would be free to drift.
            'job.visit_location': formatVisitLocation(nextVisit, address),
            // D7. `{{job.type}}` lands in "Job {{job.number}} - {{job.type}}" in the seeded
            // appointment confirmation, so an untyped job sent "Job J00042 - ".
            'job.type': job.job_type?.trim() ?? '',
            // '' when unset: "Scope: {{job.scope_notes}}" is staff-facing, and the step's own
            // "If empty, fill with" is where that wording belongs.
            'job.scope_notes': job.scope_notes?.trim() ?? '',
            // '' when no assignees sit on the job's trips - see visitMergeFields: the words for
            // a crewless job are the step's own "If empty, fill with", never this module's.
            //
            // Resolved off `visitCrew`, which IS `assignees` (the job-level union) for an
            // enrollment that names no trip and is the named trip's OWN crew when it names one -
            // so a reminder for Thursday says who is coming on Thursday rather than everybody
            // booked on the job. User stories 3 and 4: a stranger at the door, and a number that
            // reaches somebody who is at another job.
            'technician.first_name': visitCrew[0]?.first_name?.trim() ?? '',
            'technician.names': techNames,
            // How to reach them (D7, slice 5). Resolved off the SAME `visitCrew` `technician.names`
            // is, so an email cannot name one set of people and offer another set's numbers. A crew
            // with no numbers on file falls back to the main line this very email renders under
            // {{org.phone}}; NOT to '', which reads as "Questions? Call ." Note the per-VISIT
            // override in visitMergeFields: an occurrence keyed to one trip replaces both of these.
            'technician.phones': formatPerformerPhones(visitCrew, orgPhone),
            // The same crew on the number the ORGANISATION owns (slice 7), for the template that
            // declines to publish mobiles. Resolved off `visitCrew` - the SAME list its sibling
            // above and `technician.names` come off - so the two fields cannot name one set of
            // people and offer another set's numbers. Per-visit enrollment made that list the
            // named trip's own crew rather than the job-level union; both phone fields followed
            // it together, because a reminder that says who is coming on Thursday must offer the
            // number of somebody who is coming on Thursday. Like its sibling it is still REPLACED
            // per visit by visitMergeFields for an occurrence keyed to one trip.
            'technician.servwave_phones': await resolveServWavePhones(
              args.organizationId, visitCrew.map((u) => u.id), orgPhone,
            ),
            'job.sub_status': job.sub_status?.label ?? '',
          },
        },
        state: { jobStatus: job.status, jobScheduledStart: nextVisit?.scheduled_at ?? null, jobCompletedAt: job.completed_at },
      };
    }

    case 'estimate': {
      const estimate = await prisma.estimate.findFirst({
        where: { id: args.entityId, organization_id: args.organizationId },
        include: {
          // SERV10X-61 - direct anchor (R6) so a lead-less estimate resolves its customer for
          // automation merge fields; falls back through the lead for lead-anchored rows.
          customer: CUSTOMER_INCLUDE,
          lead: {
            include: {
              customer: CUSTOMER_INCLUDE,
              commission_owner: { select: { id: true, email: true, first_name: true, last_name: true, phone: true } },
            },
          },
          creator: { select: { id: true, email: true, first_name: true, last_name: true, phone: true } },
        },
      });
      if (!estimate) return null;
      const customer = estimate.lead?.customer ?? estimate.customer ?? null;
      const link = estimate.public_token
        ? `${env.FRONTEND_URL}/p/estimates/${estimate.id}?token=${estimate.public_token}`
        : '';
      return {
        bundle: {
          ...base,
          entityRef: { type: 'estimate', id: estimate.id, label: estimate.estimate_number },
          customer,
          assignees: [],
          creator: estimate.creator ?? null,
          salesperson: estimate.lead?.commission_owner ?? null,
          jobRef: null,
          mergeCtx: {
            ...orgCtx,
            ...customerCtx(customer),
            // Off the same person `salesperson` above is, so audience and signature agree.
            ...ownerCtx('estimate', estimate.lead?.commission_owner),
            'estimate.number': estimate.estimate_number,
            'estimate.total': money(estimate.total_amount, org.currency),
            'estimate.link': link,
          },
        },
        state: { estimateStatus: estimate.status, estimateValidUntil: estimate.valid_until ?? null },
      };
    }

    case 'invoice': {
      const invoice = await prisma.invoice.findFirst({
        where: { id: args.entityId, organization_id: args.organizationId },
        include: { customer: CUSTOMER_INCLUDE, job: { select: { id: true, job_number: true } } },
      });
      if (!invoice) return null;
      const link = invoice.public_token
        ? `${env.FRONTEND_URL}/p/invoices/${invoice.id}?token=${invoice.public_token}`
        : '';
      return {
        bundle: {
          ...base,
          entityRef: { type: 'invoice', id: invoice.id, label: invoice.invoice_number },
          customer: invoice.customer,
          assignees: [],
          jobRef: invoice.job ? { id: invoice.job.id, label: invoice.job.job_number } : null,
          mergeCtx: {
            ...orgCtx,
            ...customerCtx(invoice.customer),
            'invoice.number': invoice.invoice_number,
            'invoice.total': money(invoice.total_amount, org.currency),
            'invoice.due_date': fmtDate(invoice.due_date, tz),
            'invoice.link': link,
          },
        },
        state: { invoiceStatus: invoice.status, invoiceAmountDue: Number(invoice.amount_due), invoiceDueDate: invoice.due_date ?? null },
      };
    }

    case 'lead': {
      const lead = await prisma.lead.findFirst({
        where: { id: args.entityId, organization_id: args.organizationId },
        include: {
          customer: CUSTOMER_INCLUDE,
          // Walkthrough-as-entity redesign, PR-B2 (D15): merge fields lead.walkthrough_date/
          // _time/performer_names, and the leadWalkthroughScheduledAt staleness state, resolve
          // against the lead's CURRENT visit - the next upcoming SCHEDULED one; else the most
          // recent one that happened (completed or cancelled) - not the legacy flat columns,
          // which mixed data across visits once a lead could have more than one.
          visits: {
            select: {
              id: true, status: true, scheduled_at: true, duration_minutes: true,
              completed_at: true, cancelled_at: true, cancelled_reason: true, cancelled_by: true,
              customer_email_sent_at: true, notes: true, created_at: true,
              // Where the trip is happening, plus the LOCATION RELATION rather than a copy of its
              // columns: D2's whole point is that correcting the showroom's address in Settings
              // changes what an unsent reminder renders, with no write to the visit. Spread from
              // the one exported select so every reader of this feature asks for the same set.
              ...visitLocationSelect,
              assignees: {
                // Number AND extension, from the one exported pair - see the job arm above for
                // why selecting `phone` alone is worse than selecting neither.
                include: {
                  user: {
                    select: {
                      id: true, email: true, first_name: true, last_name: true,
                      ...performerPhoneSelect,
                    },
                  },
                },
              },
            },
          },
          commission_owner: { select: { id: true, email: true, first_name: true, last_name: true, phone: true } },
          service_location: true,
        },
      });
      if (!lead) return null;
      // The customer half of {{lead.name}}, on the SAME ladder {{customer.full_name}} walks -
      // so a company lead reads "Harbor Cabinet Co - new showroom doors" rather than losing its
      // left operand. '' here means "no customer row at all", which the join below handles.
      const customerName = customerDisplayName(lead.customer);
      const request = (lead.service_request ?? '').trim().slice(0, 60);
      // ── THE TRIP THIS ENROLLMENT IS ABOUT, WHEN IT NAMES ONE ────────────────────────────────
      // Per-visit automation enrollment (spec 2026-09-14). The lead arm is where this matters
      // most: there is no lead-side `visitMergeFields` anywhere in the codebase, so these five
      // visit-derived fields - and `leadWalkthroughScheduledAt` / `leadVisitStatus` with them -
      // were resolved per ENTITY on EVERY path, the event-driven one included. A showroom meeting
      // followed by a site visit sent the customer to the showroom for the site visit.
      //
      // D4: a named trip that is not on this lead STOPS the enrollment - never a fall back to
      // `resolveCurrentWalkthrough`, which would quietly describe the other trip. The lead was read
      // with its tenant clause, so a trip in another organisation is simply not among its visits
      // and resolves to the same null.
      //
      // NO liveness gate here, unlike the job arm, and deliberately: `resolveCurrentWalkthrough`
      // itself falls back to the most recent trip that HAPPENED, and `leadVisitStatus` below
      // carries the trip's own status into `terminalStale`, which applies the allow-list per
      // direction ('before' wants a still-pending walkthrough; 'after' expects a completed one).
      // The status travels, so it does not have to be pre-judged here.
      const carriedVisit = args.visitId
        ? (lead.visits ?? []).find((v) => v.id === args.visitId) ?? null
        : null;
      if (args.visitId && !carriedVisit) return null;
      // Past the guard above, a set `visitId` guarantees `carriedVisit`, so this reads as it says:
      // the named trip if there is one, otherwise the lead's own current visit exactly as today.
      const currentVisit = carriedVisit ?? resolveCurrentWalkthrough(lead.visits);
      // Built once and used twice - as {{lead.address}} and as the visit-location fallback - so
      // the two can never disagree inside one email.
      // D7: `Lead.service_location_id` is NULLABLE, so this is the field that genuinely resolved
      // '' on a real staging record - "Please meet us at ." in the seeded walkthrough copy.
      // '' rather than SERVICE_ADDRESS_FALLBACK since 2026-09-15. `lead.address` and
      // `lead.walkthrough_location` still cannot offer two different answers for one absent
      // address - they still come off this ONE resolution, and they now carry the same seeded
      // fallback in mergeFieldFallbacks.ts instead of the same hard-coded phrase. See the note on
      // `orgPhone` above.
      const serviceAddress =
        lead.service_location
          ? [lead.service_location.address_line1, lead.service_location.city, lead.service_location.state]
              .map((v) => v?.trim())
              .filter(Boolean)
              .join(', ')
          : '';
      const assignees: VisitPerson[] = (currentVisit?.assignees ?? []).map(
        (p: { user: VisitPerson }) => p.user,
      );
      // The lead-side twin of `technician.names`, and '' for the same reason: a walkthrough
      // nobody is booked on renders the step's "If empty, fill with" text, never our words.
      const performerNames =
        assignees
          .map((u) => [u.first_name, u.last_name].map((v) => v?.trim()).filter(Boolean).join(' '))
          .filter(Boolean)
          .join(', ');
      return {
        bundle: {
          ...base,
          entityRef: { type: 'lead', id: lead.id, label: lead.lead_number },
          customer: lead.customer,
          assignees,
          salesperson: lead.commission_owner ?? null,
          jobRef: null,
          mergeCtx: {
            ...orgCtx,
            ...customerCtx(lead.customer),
            // Off the same person `salesperson` above is, so audience and signature agree.
            ...ownerCtx('lead', lead.commission_owner),
            // D7, and the separator is half the defect: the old ternary keyed only off `request`,
            // so a lead whose customer resolved to '' shipped " — QA0912-B no address lead" -
            // an em-dash with nothing on its left. JOINED rather than branched, so the separator
            // can only appear between two operands that exist. Both absent falls through to the
            // customer field's own answer, which is never empty.
            'lead.name': [customerName, request].filter(Boolean).join(' — '),
            'lead.number': lead.lead_number,
            // Same shape as job.address — the walkthrough emails these automations
            // replace told the customer where to be.
            'lead.address': serviceAddress,
            // Where the walkthrough is ACTUALLY happening, which is the customer's own address
            // only by default (visit-location spec, D1/D7). Resolved against the SAME current
            // visit `lead.walkthrough_date` uses - a second notion of "which visit" would let an
            // email name one trip's date beside another trip's address.
            //
            // The service address is passed IN rather than re-derived inside the formatter: the
            // no-location fallback has to be the same string this email renders under
            // {{lead.address}}, and a second derivation would be free to drift from it.
            'lead.walkthrough_location': formatVisitLocation(currentVisit, serviceAddress),
            // D7. Non-undefined was only ever HALF of this: renderMergeFields leaves an
            // *unknown* field literal so typos stay visible, so a declared field resolving to
            // undefined prints {{lead.job_type}} verbatim in a customer-facing email - but `?? ''`
            // then printed "Job type: ." instead, which is the sentence the staging QA send
            // actually carried. Same phrase as `job.type`: one job type, one wording.
            'lead.job_type': lead.job_type?.trim() ?? '',
            'lead.walkthrough_date': fmtDate(currentVisit?.scheduled_at ?? null, tz),
            'lead.walkthrough_time': fmtTime(currentVisit?.scheduled_at ?? null, tz),
            'lead.performer_names': performerNames,
            // How to reach them (D7, slice 5), off the SAME current visit the date, the time and
            // the names resolve against - a second notion of "which visit" would put one trip's
            // date beside another trip's team's number. Unlike `performer_names`, which is allowed
            // to render '' for a visit nobody is going on, this one never can: an empty
            // {{lead.performer_phones}} reads as "Call us on ." Where SOME of the team have
            // numbers it renders those, and falls back only when NOBODY does.
            'lead.performer_phones': formatPerformerPhones(assignees, orgPhone),
            // The same team on the organisation's own number (slice 7). A SIBLING of the field
            // above, not a replacement: the author chose one of the two by naming it in the
            // template, so this one must never fall through to the personal number the other
            // renders - the choice was made precisely to withhold it. Off the same current visit
            // the date, the time and the names resolve against.
            'lead.performer_servwave_phones': await resolveServWavePhones(
              args.organizationId, assignees.map((u) => u.id), orgPhone,
            ),
          },
        },
        state: {
          leadStatus: lead.status,
          leadWalkthroughScheduledAt: currentVisit?.scheduled_at ?? null,
          leadVisitStatus: currentVisit?.status ?? null,
          // Straight off the lead row (this loader uses `include`, so every scalar is already
          // here). Note these are the STORED clocks, not the current-visit projection above:
          // leadWalkthroughScheduledAt moves both ways with the visit set by design, whereas
          // leadLastVisitCompletedAt only ever moves FORWARD and only when a trip is actually
          // completed - booking, moving or cancelling a visit never touches it. That difference
          // is the whole point of D3.
          leadCreatedAt: lead.created_at,
          leadContactedAt: lead.contacted_at,
          leadWalkthroughFirstBookedAt: lead.walkthrough_first_booked_at,
          leadLastVisitCompletedAt: lead.last_visit_completed_at,
          leadFirstEstimateSentAt: lead.first_estimate_sent_at,
        },
      };
    }

    case 'task': {
      const task = await prisma.task.findFirst({
        where: { id: args.entityId, organization_id: args.organizationId },
        include: { creator: { select: { id: true, email: true, first_name: true, last_name: true, phone: true } } },
      });
      // ── THE ESCAPE HATCH, and it is deliberately one line wide ──────────────────────────
      // A task is the only entity this engine runs against that can be HARD deleted, so it is
      // the only one whose row is guaranteed absent by the time a workflow about it executes.
      // TASK_DELETED - and NOTHING else - answers that from the snapshot the delete handler
      // persisted on the enrollment.
      //
      // The gate is an equality on the pinned trigger, not a check that the row is missing.
      // Widening it to "a missing task is survivable" would make EVERY task trigger outlive
      // deletion, so a deleted task would go on collecting its due-date reminders and comment
      // mail - the exact inverse of what the staleness rules promise. The other four entities
      // never reach this line at all.
      if (!task) return deletedTaskBundle(args, base, orgCtx);
      const byId = await loadTaskPeople(args.organizationId, [...task.assignee_ids, ...task.watcher_ids]);
      const assignees = inStoredOrder(byId, task.assignee_ids);
      const watchers = inStoredOrder(byId, task.watcher_ids);

      const linkedRecord = await taskLinkedRecordLabel(
        task.linked_entity_type,
        task.linked_entity_id,
        args.organizationId,
      );

      return {
        bundle: {
          ...base,
          // The TITLE, not the task number. Every other sweep arm writes a record number, but
          // the task bell verbs already write the title, with the recorded reason that a
          // task's number means nothing to the person being told about it - and the Activity
          // tab is the same audience. Tasks follow the task convention.
          entityRef: { type: 'task', id: task.id, label: task.title },
          customer: null,
          assignees,
          watchers,
          creator: task.creator ?? null,
          jobRef: null,
          mergeCtx: {
            ...orgCtx,
            // No customerCtx spread: TASK_BASE carries no customer fields, so rendering
            // three permanently-empty ones would only invite someone to advertise them.
            'task.number': task.task_number,
            'task.title': task.title,
            'task.due_date': fmtDate(task.due_at, tz),
            'task.status': TASK_STATUS_LABELS[task.status] ?? task.status,
            'task.priority': TASK_PRIORITY_LABELS[task.priority] ?? task.priority,
            // '' for an unassigned task - staff-facing, and the step's "If empty, fill with"
            // owns the wording, the same way the crew fields do.
            'task.assignee_names': assignees
              .map((u) => [u.first_name, u.last_name].map((v) => v?.trim()).filter(Boolean).join(' '))
              .filter(Boolean)
              .join(', '),
            'task.link': `${env.FRONTEND_URL}/tasks?task=${task.id}`,
            'task.linked_record': linkedRecord,
          },
        },
        state: { taskStatus: task.status, taskDueAt: task.due_at ?? null },
      };
    }

    default:
      return null;
  }
}
