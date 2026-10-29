/**
 * catalog.ts — single source of truth for the Automation Center's vocabulary.
 *
 * Everything the builder UI and the engine agree on lives here: trigger
 * definitions (incl. which merge fields each exposes), action definitions
 * (incl. which recipients each allows per trigger entity), merge-field labels
 * + sample values (client-side live preview), and the prebuilt template
 * gallery. Served verbatim by GET /api/workflows/catalog.
 *
 * Invariants are pinned by __tests__/catalog.test.ts — every enum member must
 * be described here, and every template must validate against its trigger.
 */

import {
  AutomationTriggerType,
  AutomationActionType,
  AutomationSendWindow,
  WorkflowStepType,
} from '@prisma/client';
import type { AutomationEntity } from './automationEntity';
import { audiencesForEntity, audienceLabel, type RecipientKey as AudienceKey } from './recipients';
import {
  ANCHORS_FOR_ENTITY,
  ANCHOR_LABELS,
  LEAD_STAGE_CLOCK_ANCHORS,
  type AnchorKey,
  type WaitDirection,
} from './anchors';
import { taskTransitionFields } from './taskTransitions';

/**
 * Re-exported, not re-declared. The union itself now lives in automationEntity.ts so the
 * modules catalog.ts imports (anchors.ts) can reference the same name without a cycle;
 * every historic `import type { AutomationEntity } from './catalog'` keeps working.
 */
export type { AutomationEntity };

export type RecipientKey =
  | 'customer'
  | 'assigned_techs'
  | 'all_admins'
  | 'all_dispatchers'
  | 'specific_user'
  | 'custom';

// ── merge fields ──────────────────────────────────────────────────────────────

const ORG_FIELDS = ['org.name', 'org.phone'];
const CUSTOMER_FIELDS = ['customer.first_name', 'customer.last_name', 'customer.full_name'];
// `job.visit_location` is the visit-location spec's job half (D5/D6). It sits beside the service
// address because it answers the question that address only answers by DEFAULT: where this
// particular trip is happening. An organisation with a yard, a workshop or a showroom holds
// roughly half its job visits somewhere the customer never goes, and the value varies per VISIT -
// which is exactly what an automation body cannot do, so it has to be carried by the record.
//
// Named apart from the lead side's 'Walkthrough visit address' ON PURPOSE (D5): ServWave's
// vocabulary distinguishes a walkthrough from a job visit, so the field list does too.
//
// ALL FOUR ADDRESS FIELDS NOW READ `<whose> <which> address` (Ran, 2026-09-15). The pair used to
// be 'Service address' and 'Walkthrough location', which shared no word and named the same kind
// of thing two different ways, so the picker gave an author no way to tell which one they wanted:
// one said WHAT it was and the other said only that it was a place. The four are now
//
//   lead.address              Lead service address        the address held on the record
//   lead.walkthrough_location Walkthrough visit address   where THAT meeting is happening
//   job.address               Job service address         the address held on the record
//   job.visit_location        Job visit address           where THAT trip is happening
//
// so a reader gets the noun ('address') from the last word and the distinction from the first
// two. `lead.address` and `job.address` still mean exactly the same thing and still resolve
// identically; they differ only by the entity whose picker they appear in, which is the same
// distinction every other field in these two groups already carries.
const JOB_FIELDS = [
  'job.number',
  'job.scheduled_date',
  'job.scheduled_time',
  'job.address',
  'job.visit_location',
  'job.type',
  'job.scope_notes',
  'technician.first_name',
  'technician.names',
  // The number that reaches the crew on the trip, rather than the front desk (spec D7, slice 5).
  // Named 'Technician phone(s)' to sit with the two fields above it in the picker, and carried on the
  // `technician.` prefix that already buckets into the "Job" group - the prefixes are load-bearing,
  // a name with no known one falls silently into "Other".
  'technician.phones',
  // The SAME people, reached on the number the ORGANISATION owns (spec D7, slice 7). A sibling of
  // the field above rather than a replacement for it: the one above is the crew's own number, which
  // for many organisations is a personal mobile, and declining to publish that must not cost them
  // the capability. Both are offered; the template carries the decision by naming one.
  'technician.servwave_phones',
  // The person who sold the job (SRVW-303), for the sign-off line. Resolved job → estimate →
  // lead owner, since `job.salesperson_id` has no writer yet. A first-name half because the
  // whole point is a signature: "Dana" reads better than "Dana Whitfield" at the end of an email.
  'job.owner_name',
  'job.owner_first_name',
];
const ESTIMATE_FIELDS = [
  'estimate.number',
  'estimate.total',
  'estimate.link',
  // The lead owner, from an estimate template (SRVW-303): "your estimate is ready" is the second
  // most natural email to sign with the seller.
  'estimate.owner_name',
  'estimate.owner_first_name',
];
const INVOICE_FIELDS = ['invoice.number', 'invoice.total', 'invoice.due_date', 'invoice.link'];
const LEAD_FIELDS = [
  'lead.name',
  'lead.number',
  'lead.address',
  'lead.job_type',
  // The lead owner (SRVW-303). On LEAD_FIELDS rather than the walkthrough set so it reaches every
  // lead trigger, not only the walkthrough ones. Single-valued, unlike `lead.performer_names`: a
  // list of two names in an unstable order is a roster, not a sign-off.
  'lead.owner_name',
  'lead.owner_first_name',
];
const TASK_FIELDS = [
  'task.number',
  'task.title',
  'task.due_date',
  'task.status',
  'task.priority',
  'task.assignee_names',
  // Every other entity's group carries a link or an address; a task email a technician
  // cannot click is a thin version of "tell me without opening the app".
  'task.link',
  // A readable label for the job/lead/customer/estimate the task hangs off - empty when
  // the task is free-standing, never the word "null".
  'task.linked_record',
];

/**
 * The fields a DELETED task can still honestly answer for - Spec B slice 4.
 *
 * Task deletion is a hard delete: no soft-delete column, no archive table, the row and its
 * comments gone inside one transaction. By the time a TASK_DELETED workflow's email actually
 * goes out there is nothing to read a due date, a status, a priority or a live roster off, so
 * the merge context is built from what task.controller.ts's remove handler snapshotted BEFORE
 * the transaction - and that snapshot is the number and the title.
 *
 * Deliberately a separate list rather than a filter of TASK_FIELDS: this is a decision about
 * what can be rendered without lying, and a `.filter()` would let a field added to TASK_FIELDS
 * later drift silently into a template that has no value to put in it. A merge field resolving
 * to an empty string reads as a broken template, not as a deleted task; the validator refuses
 * a body that references one (workflowValidation.ts reads TRIGGERS[t].mergeFields directly),
 * so this list is the enforcement, not just the advertisement.
 */
const TASK_SNAPSHOT_FIELDS = ['task.number', 'task.title'];
// `lead.walkthrough_location` is the visit-location spec's lead half (D5/D6). It rides with the
// date and the team because it answers the other half of the same question a confirmation asks -
// when, who, and WHERE - and because the value varies per visit, which is exactly what an
// automation body cannot do: one automation now serves a showroom consultation and a site measure
// on the same lead. Named for the surface rather than for a generic "visit location": ServWave's
// vocabulary is walkthrough here, and the job side gets its own differently-named field.
const WALKTHROUGH_FIELDS = [
  'lead.walkthrough_date', 'lead.walkthrough_time', 'lead.performer_names',
  'lead.walkthrough_location',
  // The other half of "who is coming": a way to reach them (spec D7, slice 5). It rides beside the
  // team it belongs to, and it is a SEPARATE field rather than an addition to `performer_names`
  // because an author writing "{{lead.performer_names}} will be there" must not be forced to print
  // a phone number in the middle of that sentence.
  'lead.performer_phones',
  // The same team on the organisation's own number (slice 7) - see `technician.servwave_phones`
  // for why this is a second field and not a setting. Both sides ship together for the reason D6
  // gives for the location pair: the picker would otherwise read as though one side was forgotten.
  'lead.performer_servwave_phones',
];

// Request-time text the triggering event captured (event_payload.mergeFields —
// context.ts), not a live column any entity load could re-derive. Legal only
// on the two cancellation triggers that have a reason to carry — appended to
// their mergeFields directly below, NOT folded into BASE.
const EVENT_REASON_FIELD = ['event.reason'];

// SRVW-113 — the sub-status label the job just entered. Legal only on
// JOB_SUB_STATUS_ENTERED (appended below, NOT folded into JOB_FIELDS): every
// other job trigger's entity load has no reliable sub-status to offer (a job
// can be re-scheduled, completed, etc. with no sub-status set at all).
const JOB_SUB_STATUS_FIELD = ['job.sub_status'];

/**
 * The common ground of every trigger: who is sending, and who the record is about.
 *
 * THERE IS DELIBERATELY NO FIELD HERE FOR THE PERSON A PARTICULAR COPY OF A SEND IS ADDRESSED
 * TO, and this is the second-most likely thing for a future reader to "fix". There was one -
 * `{{recipient.first_name}}`, resolved per address by executors.ts - and Ran had it removed
 * outright on 2026-09-15 rather than merely hidden.
 *
 * The reasoning, so it does not have to be rediscovered: a merge field is offered per TRIGGER,
 * and a trigger has no audience. The audience is chosen per STEP, and one trigger's steps can
 * address the customer and the crew in turn. So a per-recipient name is correct on exactly the
 * staff half of the steps it is offered on, and on the customer half it duplicates
 * `{{customer.first_name}}` at best - at worst it is strictly worse than it, because
 * `customer.first_name` carries a fallback ("there", mergeFieldFallbacks.ts) and a company
 * customer with no first name on record therefore reads "Hi there," through that field and
 * "Hi ," through the recipient one. A field that is only right on half the steps that offer it
 * is not a field, and the staff copy that wanted it reads better addressed to nobody in
 * particular - see the seeded bodies in defaultAutomations.ts, which say "You have been
 * assigned to job X" and lose nothing.
 *
 * Re-adding it is not a one-line change. `renderMergeFields` leaves an unknown field LITERAL by
 * design, so the token's removal came with a data migration over every saved body
 * (20260915170000_drop_recipient_first_name_from_saved_copy).
 */
const BASE = [...ORG_FIELDS, ...CUSTOMER_FIELDS];

/**
 * BASE without the customer, for the entities that have none.
 *
 * A task belongs to the office, not to a customer: its people are staff and its subject is
 * internal work. Composing task triggers off BASE would advertise {{customer.first_name}}
 * on a trigger whose entity load has no customer to render into it, so every task email
 * would carry a silently empty field. Kept as a separate constant rather than a filter of
 * BASE so the omission is a decision someone reads, not an accident of ordering.
 *
 * It is currently spelled the same as ORG_FIELDS and is still NOT an alias of it. The two
 * answer different questions - "what does an organisation always have" and "what may a task
 * trigger offer" - and the day a genuinely universal field lands in ORG_FIELDS is the day the
 * difference matters. Collapsing them would also delete the paragraph above, which is the only
 * written record of why a task email never greets the customer.
 */
const TASK_BASE = [...ORG_FIELDS];

export const MERGE_FIELD_LABELS: Record<string, string> = {
  'org.name': 'Company name',
  'org.phone': 'Company phone',
  'customer.first_name': 'Customer first name',
  'customer.last_name': 'Customer last name',
  'customer.full_name': 'Customer full name',
  'event.reason': 'The reason given',
  'job.sub_status': 'Sub-status the job just entered',
  'job.number': 'Job number',
  'job.scheduled_date': 'Job date',
  'job.scheduled_time': 'Job time',
  'job.address': 'Job service address',
  'job.visit_location': 'Job visit address',
  'job.type': 'Job type',
  'job.scope_notes': 'Scope of work',
  'technician.first_name': 'Technician first name',
  'technician.names': 'Technician name(s)',
  'technician.phones': 'Technician phone(s)',
  'technician.servwave_phones': 'Technician ServWave phone(s)',
  'estimate.number': 'Estimate number',
  'estimate.total': 'Estimate total',
  'estimate.link': 'Estimate link',
  'invoice.number': 'Invoice number',
  'invoice.total': 'Invoice total',
  'invoice.due_date': 'Invoice due date',
  'invoice.link': 'Invoice link',
  'lead.name': 'Lead name',
  'lead.number': 'Lead number',
  'lead.address': 'Lead service address',
  'lead.job_type': 'Job type',
  'lead.walkthrough_date': 'Walkthrough date',
  'lead.walkthrough_time': 'Walkthrough time',
  'lead.performer_names': 'Walkthrough team',
  'lead.performer_phones': 'Walkthrough team phone(s)',
  'lead.performer_servwave_phones': 'Walkthrough team ServWave phone(s)',
  'lead.walkthrough_location': 'Walkthrough visit address',
  // "Owner" and not "salesperson": it is the word the lead form, the assign popover and the leads
  // table already put in front of the same user (SRVW-303).
  'lead.owner_name': 'Lead owner name',
  'lead.owner_first_name': 'Lead owner first name',
  'job.owner_name': 'Job owner name',
  'job.owner_first_name': 'Job owner first name',
  'estimate.owner_name': 'Estimate owner name',
  'estimate.owner_first_name': 'Estimate owner first name',
  'task.number': 'Task number',
  'task.title': 'Task title',
  'task.due_date': 'Task due date',
  'task.status': 'Task status',
  'task.priority': 'Task priority',
  'task.assignee_names': 'Task assignee name(s)',
  'task.link': 'Task link',
  'task.linked_record': 'Record the task is attached to',
  // The transition triggers' own two (taskTransitions.ts), resolved from the dispatching event.
  'task.completed_by': 'Completed by',
  'task.completed_at': 'Completed at',
  'task.cancelled_by': 'Cancelled by',
  'task.cancelled_at': 'Cancelled at',
};

/** Sample values used for live preview + test-sends. Kept realistic on purpose. */
export const SAMPLE_CONTEXT: Record<string, string> = {
  'org.name': 'Blue Ridge Plumbing',
  'org.phone': '(555) 204-7788',
  'customer.first_name': 'Sarah',
  'customer.last_name': 'Mitchell',
  'customer.full_name': 'Sarah Mitchell',
  'event.reason': 'Customer requested reschedule',
  'job.sub_status': 'Waiting on parts',
  'job.number': 'J00042',
  'job.scheduled_date': 'Tue, Jul 14',
  'job.scheduled_time': '9:00 AM',
  'job.address': '18 Maple Ave, Richmond, VA',
  // A company location, which is the shape the author is most likely to be writing for -
  // the name leads, then the address, so the preview shows why the field is worth using.
  // Deliberately NOT the same place as the service address above: a sample where the two
  // matched would preview as though the field changed nothing.
  'job.visit_location': 'North Yard, 40 Depot Rd, Richmond, VA',
  'job.type': 'Water heater replacement',
  'job.scope_notes': 'Replace 40gal water heater; shut-off is in the crawlspace',
  'technician.first_name': 'Mike',
  'technician.names': 'Mike Torres',
  // Shown WITH an extension, because that is the half of the format an author cannot guess: a
  // number and its extension render as one reachable contact, not as two numbers. Deliberately a
  // different number from `org.phone` above - a sample that matched the main line would preview as
  // though the field changed nothing.
  'technician.phones': '(555) 204-7794 ext. 12',
  // The organisation's own line for the same crew (slice 7). No extension, because there is none
  // to show: an extension belongs to the PERSONAL number and describes the switchboard behind it.
  // A fourth distinct number on purpose - four phone samples that matched would preview as though
  // the four fields were one field, which is exactly the question the author is deciding.
  'technician.servwave_phones': '(555) 204-0736',
  'estimate.number': 'E00108',
  'estimate.total': '$2,450.00',
  'estimate.link': 'https://app.servwave.com/p/estimates/…',
  'invoice.number': 'I00073',
  'invoice.total': '$1,180.00',
  'invoice.due_date': 'Jul 20',
  'invoice.link': 'https://app.servwave.com/p/invoices/…',
  'lead.name': 'Sarah Mitchell — water heater',
  'lead.number': 'L00042',
  'lead.address': '88 Cedar Lane, Asheville, NC',
  'lead.job_type': 'Water heater replacement',
  'lead.walkthrough_date': 'Sat, Aug 1',
  'lead.walkthrough_time': '2:00 PM',
  'lead.performer_names': 'Mike Torres',
  // The walkthrough half: one performer, one direct number, and not the main line - see
  // `technician.phones` for why the two samples differ from `org.phone` and from each other.
  'lead.performer_phones': '(555) 204-7791',
  // The walkthrough half of the organisation-owned pair - see `technician.servwave_phones`.
  'lead.performer_servwave_phones': '(555) 204-0712',
  // A company location, which is the shape the author is most likely to be writing for -
  // the name leads, then the address, so the preview shows why the field is worth using.
  'lead.walkthrough_location': 'Showroom, 12 Harbor St, Asheville, NC',
  // One person across the three entities, and deliberately NOT the technician above: a sample
  // that matched `technician.first_name` would preview as though the seller and the crew were
  // one field. The first name is the first word of the full name so the pair reads as one person.
  'lead.owner_name': 'Dana Whitfield',
  'lead.owner_first_name': 'Dana',
  'job.owner_name': 'Dana Whitfield',
  'job.owner_first_name': 'Dana',
  'estimate.owner_name': 'Dana Whitfield',
  'estimate.owner_first_name': 'Dana',
  'task.number': 'T00042',
  'task.title': 'Order the replacement thermostat',
  'task.due_date': 'Fri, Jul 17',
  'task.status': 'In progress',
  'task.priority': 'High',
  'task.assignee_names': 'Mike Torres',
  'task.link': 'https://app.servwave.com/tasks?task=…',
  'task.linked_record': 'Job J00042',
  // Deliberately NOT the assignee above: the person who ticks a task off is often the manager
  // who handed it out, and a sample that matched would preview as though they were one field.
  'task.completed_by': 'Dana Whitfield',
  'task.completed_at': 'July 17, 2026 at 3:45 PM',
  'task.cancelled_by': 'Dana Whitfield',
  'task.cancelled_at': 'July 17, 2026 at 3:45 PM',
};

// ── triggers ──────────────────────────────────────────────────────────────────

export interface TriggerDef {
  label: string;
  description: string;
  category: 'events' | 'timed' | 'date';
  entity: AutomationEntity;
  timeBased: boolean;
  /** Sensible builder default, minutes. Only for timed triggers. */
  defaultOffsetMinutes?: number;
  /** Which {{merge.fields}} are valid in message copy for this trigger. */
  mergeFields: string[];
}

export const TRIGGERS: Record<AutomationTriggerType, TriggerDef> = {
  JOB_SCHEDULED: {
    label: 'Job is scheduled',
    description: 'Fires the first time a job gets a date on the calendar.',
    category: 'events', entity: 'job', timeBased: false,
    mergeFields: [...BASE, ...JOB_FIELDS],
  },
  JOB_RESCHEDULED: {
    label: 'Job is rescheduled',
    description: 'Fires whenever a scheduled job is moved to a new date or time.',
    category: 'events', entity: 'job', timeBased: false,
    mergeFields: [...BASE, ...JOB_FIELDS],
  },
  TECH_ASSIGNED: {
    label: 'Technician is assigned',
    description: 'Fires for each technician the moment they are added to a job.',
    category: 'events', entity: 'job', timeBased: false,
    mergeFields: [...BASE, ...JOB_FIELDS],
  },
  JOB_COMPLETED: {
    label: 'Job is completed',
    description: 'Fires when a job is marked complete.',
    category: 'events', entity: 'job', timeBased: false,
    mergeFields: [...BASE, ...JOB_FIELDS],
  },
  JOB_CANCELLED: {
    label: 'Job is cancelled',
    description: 'Fires when a job is cancelled.',
    category: 'events', entity: 'job', timeBased: false,
    mergeFields: [...BASE, ...JOB_FIELDS, ...EVENT_REASON_FIELD],
  },
  ESTIMATE_SENT: {
    label: 'Estimate is sent',
    description: 'Fires the first time an estimate is sent to the customer.',
    category: 'events', entity: 'estimate', timeBased: false,
    mergeFields: [...BASE, ...ESTIMATE_FIELDS],
  },
  ESTIMATE_APPROVED: {
    label: 'Estimate is approved',
    description: 'Fires when the customer approves an estimate (any approval path).',
    category: 'events', entity: 'estimate', timeBased: false,
    mergeFields: [...BASE, ...ESTIMATE_FIELDS],
  },
  ESTIMATE_DECLINED: {
    label: 'Estimate is declined',
    description: 'Fires when the customer declines an estimate.',
    category: 'events', entity: 'estimate', timeBased: false,
    mergeFields: [...BASE, ...ESTIMATE_FIELDS],
  },
  INVOICE_SENT: {
    label: 'Invoice is sent',
    description: 'Fires when an invoice is sent to the customer.',
    category: 'events', entity: 'invoice', timeBased: false,
    mergeFields: [...BASE, ...INVOICE_FIELDS],
  },
  INVOICE_PAID: {
    label: 'Invoice is paid',
    description: 'Fires when an invoice is paid in full.',
    category: 'events', entity: 'invoice', timeBased: false,
    mergeFields: [...BASE, ...INVOICE_FIELDS],
  },
  LEAD_CREATED: {
    label: 'Lead is created',
    description: 'Fires when a new lead is created.',
    category: 'events', entity: 'lead', timeBased: false,
    mergeFields: [...BASE, ...LEAD_FIELDS],
  },
  LEAD_ASSIGNED: {
    label: 'Lead is assigned',
    description: 'Fires when a lead is assigned to an owner.',
    category: 'events', entity: 'lead', timeBased: false,
    mergeFields: [...BASE, ...LEAD_FIELDS],
  },
  WALKTHROUGH_SCHEDULED: {
    label: 'Walkthrough is scheduled',
    description: 'Fires when a lead’s walkthrough is put on the calendar.',
    category: 'events', entity: 'lead', timeBased: false,
    mergeFields: [...BASE, ...LEAD_FIELDS, ...WALKTHROUGH_FIELDS],
  },
  WALKTHROUGH_RESCHEDULED: {
    label: 'Walkthrough is rescheduled',
    description: 'Fires whenever a scheduled walkthrough is moved to a new time.',
    category: 'events', entity: 'lead', timeBased: false,
    mergeFields: [...BASE, ...LEAD_FIELDS, ...WALKTHROUGH_FIELDS],
  },
  WALKTHROUGH_COMPLETED: {
    label: 'Walkthrough is completed',
    description: 'Fires when a walkthrough is marked complete.',
    category: 'events', entity: 'lead', timeBased: false,
    mergeFields: [...BASE, ...LEAD_FIELDS, ...WALKTHROUGH_FIELDS],
  },
  WALKTHROUGH_CANCELLED: {
    label: 'Walkthrough is cancelled',
    description: 'Fires when a scheduled walkthrough is cancelled.',
    category: 'events', entity: 'lead', timeBased: false,
    mergeFields: [...BASE, ...LEAD_FIELDS, ...WALKTHROUGH_FIELDS, ...EVENT_REASON_FIELD],
  },
  WALKTHROUGH_PERFORMER_ASSIGNED: {
    label: 'Walkthrough performer is assigned',
    description: 'Fires for each person added to perform a walkthrough.',
    category: 'events', entity: 'lead', timeBased: false,
    mergeFields: [...BASE, ...LEAD_FIELDS, ...WALKTHROUGH_FIELDS],
  },
  WALKTHROUGH_PERFORMER_REMOVED: {
    label: 'Walkthrough performer is removed',
    description: 'Fires for each person taken off a walkthrough.',
    category: 'events', entity: 'lead', timeBased: false,
    mergeFields: [...BASE, ...LEAD_FIELDS, ...WALKTHROUGH_FIELDS],
  },
  TECH_UNASSIGNED: {
    label: 'Technician is unassigned',
    description: 'Fires for each technician the moment they are taken off a job.',
    category: 'events', entity: 'job', timeBased: false,
    mergeFields: [...BASE, ...JOB_FIELDS],
  },
  JOB_EN_ROUTE: {
    label: 'Technician is on the way',
    description: 'Fires the moment a technician is marked on the way to a job.',
    category: 'events', entity: 'job', timeBased: false,
    mergeFields: [...BASE, ...JOB_FIELDS],
  },
  JOB_SUB_STATUS_ENTERED: {
    label: 'Job enters a sub-status',
    description: 'Fires when a job is deliberately given a specific sub-status label (e.g. "Waiting on parts").',
    category: 'events', entity: 'job', timeBased: false,
    mergeFields: [...BASE, ...JOB_FIELDS, ...JOB_SUB_STATUS_FIELD],
  },
  BEFORE_JOB_START: {
    label: 'Before a job starts',
    description: 'Fires a set amount of time before the job’s scheduled start. Reschedules re-arm it automatically.',
    category: 'timed', entity: 'job', timeBased: true, defaultOffsetMinutes: 24 * 60,
    mergeFields: [...BASE, ...JOB_FIELDS],
  },
  AFTER_JOB_COMPLETED: {
    label: 'After a job is completed',
    description: 'Fires a set amount of time after the job was marked complete.',
    category: 'timed', entity: 'job', timeBased: true, defaultOffsetMinutes: 24 * 60,
    mergeFields: [...BASE, ...JOB_FIELDS],
  },
  INVOICE_OVERDUE: {
    label: 'Invoice is overdue',
    description: 'Fires a set amount of time after the due date if the invoice is still unpaid. Skips automatically once paid.',
    category: 'timed', entity: 'invoice', timeBased: true, defaultOffsetMinutes: 3 * 24 * 60,
    mergeFields: [...BASE, ...INVOICE_FIELDS],
  },
  ESTIMATE_FOLLOW_UP: {
    label: 'Estimate awaiting response',
    description: 'Fires a set amount of time after an estimate was sent if the customer hasn’t responded. Skips automatically once approved or declined.',
    category: 'timed', entity: 'estimate', timeBased: true, defaultOffsetMinutes: 3 * 24 * 60,
    mergeFields: [...BASE, ...ESTIMATE_FIELDS],
  },
  JOB_DATE_ANCHORED: {
    label: 'Before or after the appointment',
    description: 'Counts from the job’s scheduled time.',
    category: 'date', entity: 'job', timeBased: false,
    mergeFields: [...BASE, ...JOB_FIELDS],
  },
  LEAD_DATE_ANCHORED: {
    label: 'Before or after the walkthrough',
    description: 'Counts from the walkthrough’s scheduled time.',
    category: 'date', entity: 'lead', timeBased: false,
    mergeFields: [...BASE, ...LEAD_FIELDS, ...WALKTHROUGH_FIELDS],
  },
  INVOICE_DATE_ANCHORED: {
    label: 'Before or after the invoice due date',
    description: 'Counts from when payment is due.',
    category: 'date', entity: 'invoice', timeBased: false,
    mergeFields: [...BASE, ...INVOICE_FIELDS],
  },
  ESTIMATE_DATE_ANCHORED: {
    label: 'Before or after the estimate expiration',
    description: 'Counts from the day the estimate expires.',
    category: 'date', entity: 'estimate', timeBased: false,
    mergeFields: [...BASE, ...ESTIMATE_FIELDS],
  },
  // Spec B. Composed off TASK_BASE, NOT BASE - a task has no customer. The other four
  // task triggers land one per slice, each with its own enum value.
  TASK_CREATED: {
    label: 'Task is created',
    description: 'Fires when a task is created, so the people put on it hear about it without opening the app.',
    category: 'events', entity: 'task', timeBased: false,
    mergeFields: [...TASK_BASE, ...TASK_FIELDS],
  },
  // Spec B slice 2. Deliberately NOT fired at creation - see the mutual-exclusion note at
  // task.controller.ts's create handler. This is the LATER assignment only: someone added to
  // a task that already existed. Its one distinctive audience is `assigned_user`, gated on
  // ASSIGNED_RECIPIENT_TRIGGERS below.
  TASK_ASSIGNED: {
    label: 'Someone is added to a task',
    description: 'Fires when a person is added to a task that already existed - once per person, for that person. A task created with assignees fires \u201CTask is created\u201D instead, so nobody is told twice about the same moment.',
    category: 'events', entity: 'task', timeBased: false,
    mergeFields: [...TASK_BASE, ...TASK_FIELDS],
  },
  // Spec B slice 3. Unlike TASK_ASSIGNED this is about the task rather than about one
  // person, so it takes the entity-wide audiences and joins NEITHER trigger set below:
  // there is no newly-added and no just-removed person for a comment to carry.
  //
  // Occurrence-scoped on the NOTE id (dedupe.ts). Keyed on the task alone, the second
  // comment on any task would be swallowed as a duplicate of the first for ever.
  TASK_COMMENT_ADDED: {
    label: 'Someone comments on a task',
    description: 'Fires each time a comment is added to a task, so the people on it can answer the question without opening the app. The person who wrote the comment is never told about their own.',
    category: 'events', entity: 'task', timeBased: false,
    mergeFields: [...TASK_BASE, ...TASK_FIELDS],
  },
  // Slice 14 of the visits-and-task-categories plan: the status moved INTO DONE, from anything
  // else, including again after a reopen (each finish is its own occurrence - see
  // taskTransitions.ts). Keyed here, BEFORE TASK_DELETED, because this object's key order is the
  // order the builder lists a subject's events in, and a task is finished before it is deleted.
  // The two extra fields - who finished it and when - come from the dispatching event.
  TASK_COMPLETED: {
    label: 'Task is done',
    description: 'Fires each time a task is marked done - again if it is reopened and finished a second time - so the people waiting on the work hear it is finished. The person who marked it done is never told about their own action.',
    category: 'events', entity: 'task', timeBased: false,
    mergeFields: [...TASK_BASE, ...TASK_FIELDS, ...taskTransitionFields('TASK_COMPLETED')],
  },
  // Slice 15: the status moved INTO CANCELLED - the same transition machinery as TASK_COMPLETED
  // (taskTransitions.ts), keyed between it and TASK_DELETED for the same lifecycle-order reason.
  // Who cancelled it and when come from the dispatching event; a task records no cancellation
  // reason, so there is no reason field to offer.
  TASK_CANCELLED: {
    label: 'Task is cancelled',
    description: 'Fires each time a task is cancelled - again if it is reopened and cancelled a second time - so the people waiting on the work know it will not happen. The person who cancelled it is never told about their own action.',
    category: 'events', entity: 'task', timeBased: false,
    mergeFields: [...TASK_BASE, ...TASK_FIELDS, ...taskTransitionFields('TASK_CANCELLED')],
  },
  // Spec B slice 4. The ONE trigger in the whole catalogue whose entity is guaranteed GONE by
  // the time its steps run - task deletion is a hard delete - so it is also the one whose
  // merge fields are the snapshot set rather than the entity's full group. context.ts
  // synthesises its bundle from the enrollment's persisted event_payload, and does so ONLY
  // for this trigger: every other task trigger still stops when its row vanishes, which is
  // what keeps a deleted task from carrying on collecting reminders.
  TASK_DELETED: {
    label: 'Task is deleted',
    description: 'Fires when a task is deleted, so nobody sets off to do work that no longer exists. Because the task is gone, only its number and title can be used in the message.',
    category: 'events', entity: 'task', timeBased: false,
    mergeFields: [...TASK_BASE, ...TASK_SNAPSHOT_FIELDS],
  },
  // Spec B slice 5, and the only task trigger that is not an event. ONE trigger covers both
  // directions - a reminder BEFORE the due date and an overdue chase AFTER it - which is why
  // Spec B has no separate overdue trigger. `category: 'date'` is what routes it to the
  // builder's date-mode card rather than the event list; its timing rides trigger_config
  // ({anchor, direction, offset_minutes}), so `timeBased` (the LEGACY bare-offset flag the
  // four *_OVERDUE-era triggers use) stays false, exactly as on the other four anchors.
  TASK_DATE_ANCHORED: {
    label: 'Before or after the task due date',
    description: 'Counts from when the task is due - a reminder before it, or a chase once it has passed. Done and cancelled tasks are never picked up.',
    category: 'date', entity: 'task', timeBased: false,
    mergeFields: [...TASK_BASE, ...TASK_FIELDS],
  },
};

/**
 * Which directions an anchor can legally be used in.
 *
 * Derived from LEAD_STAGE_CLOCK_ANCHORS rather than re-listed, for the same reason that set is
 * itself derived: a stage clock records a moment AS IT HAPPENS, so the row only carries a date
 * once that moment is already past, and `direction: 'before'` can never fire. `workflowValidation`
 * refuses to save one. Advertising the restriction here is what lets the builder stop OFFERING it,
 * so the office never composes a rule the save is going to reject.
 *
 * Deliberately mirrors the validator and nothing more. The estimate subject is `before`-only as a
 * product judgement — the expiry sweep cancels the estimate at `valid_until`, so nothing survives
 * to count forward from — and that rule lives in the builder. Serving it here as though it were a
 * validation rule would put this list and the validator out of step in the other direction.
 */
function anchorDirections(key: AnchorKey): WaitDirection[] {
  return LEAD_STAGE_CLOCK_ANCHORS.has(key) ? ['after'] : ['before', 'after'];
}

/**
 * Anchors advertised to the builder. Previously the frontend kept a hand-synced
 * copy of the anchor registry; serving it here (sourced from anchors.ts, Task
 * A1's module) removes that drift risk.
 */
export const ANCHOR_OPTIONS: Record<
  AutomationEntity,
  Array<{ key: AnchorKey; label: string; directions: WaitDirection[] }>
> = {
  job: ANCHORS_FOR_ENTITY.job.map((key) => ({ key, label: ANCHOR_LABELS[key], directions: anchorDirections(key) })),
  lead: ANCHORS_FOR_ENTITY.lead.map((key) => ({ key, label: ANCHOR_LABELS[key], directions: anchorDirections(key) })),
  invoice: ANCHORS_FOR_ENTITY.invoice.map((key) => ({
    key,
    label: ANCHOR_LABELS[key],
    directions: anchorDirections(key),
  })),
  estimate: ANCHORS_FOR_ENTITY.estimate.map((key) => ({
    key,
    label: ANCHOR_LABELS[key],
    directions: anchorDirections(key),
  })),
  // Spec B slice 5 filled this in, in the same change as the TASK_DATE_ANCHORED enum value.
  // The builder reads an EMPTY list as "this subject has no date to count from" and locks
  // its date-mode card, so the one entry here is what unlocks task reminders for authoring.
  task: ANCHORS_FOR_ENTITY.task.map((key) => ({
    key,
    label: ANCHOR_LABELS[key],
    directions: anchorDirections(key),
  })),
};

// ── actions ───────────────────────────────────────────────────────────────────

export interface ActionDef {
  label: string;
  description: string;
  /** Recipient keys this action supports (before entity narrowing). */
  recipients: RecipientKey[];
  requiresSubject: boolean;
}

/**
 * The action types the Automation Center still OFFERS, as opposed to the ones
 * storage can hold. The mirror at the action layer of workflowValidation.ts's
 * `AuthorableStepType`, and hand-written for the same reason: AutomationActionType
 * is a Prisma enum that keeps every label it has ever had so historic rows still
 * resolve, which makes storage permanently wider than the authoring surface.
 *
 * Every map an admin's builder reads is keyed by THIS type rather than by the
 * Prisma enum - ACTIONS, AUDIENCES and the two functions that feed them - because
 * GET /api/workflows/catalog serves those maps verbatim and they are the menu the
 * builder renders. A retired action left on the menu is an offer, however the copy
 * beside it is worded. The run path (executors.ts, enrollment.ts) still speaks the
 * full Prisma enum, which is what lets a historic step run resolve its label.
 *
 * Putting the retired label back in here stops the build rather than quietly
 * re-advertising the action. See docs/adr/0005.
 */
export type AuthorableActionType = Exclude<AutomationActionType, 'NOTIFY_TEAM'>;

export const ACTIONS: Record<AuthorableActionType, ActionDef> = {
  SEND_EMAIL: {
    label: 'Send an email',
    description: 'Delivered via your ServWave email with your company branding.',
    recipients: ['customer', 'assigned_techs', 'all_admins', 'all_dispatchers', 'custom'],
    requiresSubject: true,
  },
  SEND_SMS: {
    label: 'Send a text message',
    description: 'Recorded in the customer’s conversation thread. Delivery to their phone activates when an SMS provider is connected.',
    recipients: ['customer'],
    requiresSubject: false,
  },
};

/**
 * The entities that HAVE a customer. Stated once, here, because two separate narrowings
 * ask the same question - the legacy recipientsFor below, and the merge-field composition
 * above (BASE vs TASK_BASE).
 *
 * It was three until Spec C slice 1. The third was audiencesFor's SMS branch, which
 * narrowed a text step's audiences to `customer` alone; a text now reaches every audience
 * an email does, so that branch is gone and this set no longer has a say in it.
 *
 * A task's customer, where one exists at all, belongs to the job or lead it is linked to.
 * The task is internal work and its audience is staff.
 */
const ENTITIES_WITH_CUSTOMER: ReadonlySet<AutomationEntity> = new Set([
  'job',
  'estimate',
  'invoice',
  'lead',
] satisfies AutomationEntity[]);

/**
 * Recipients valid for a given trigger+action pair (assigned_techs needs a job).
 *
 * The LEGACY six-member key set, kept for back-compat (see the note below on AudienceKey).
 * `SEND_SMS` lists `customer` alone here, so a task - which has no customer - comes back
 * with an EMPTY legal SMS recipient set rather than ['customer'].
 *
 * That is now the ONLY customer-only narrowing left on the text channel, and it is
 * deliberately not the live one: Spec C slice 1 widened audiencesFor to serve staff
 * audiences on a text step and left this list untouched, because nothing an admin can see
 * reads it. One frontend file DOES read catalog.actions[...] - the client mirror at
 * frontend/src/lib/workflows/recipients.ts, whose own recipientsFor() is built on
 * `catalog?.actions?.[action]?.recipients` - but that module has ZERO importers, so nothing
 * renders what it computes. The step picker's copy is hardcoded, and the live audience data
 * source is audiencesFor(). Do not "fix" the asymmetry by widening
 * ACTIONS.SEND_SMS.recipients - that changes no behaviour and only breaks the two assertions
 * that pin this list.
 */
export function recipientsFor(
  trigger: AutomationTriggerType,
  action: AuthorableActionType,
): RecipientKey[] {
  const entity = TRIGGERS[trigger].entity;
  let keys = ACTIONS[action].recipients;
  if (entity !== 'job') {
    keys = keys.filter((r) => r !== 'assigned_techs');
  }
  if (!ENTITIES_WITH_CUSTOMER.has(entity)) {
    keys = keys.filter((r) => r !== 'customer');
  }
  return keys;
}

// ── recipient audiences (v2.1 multi-select) ─────────────────────────────────
// The legal AUDIENCE for a trigger+action pair now comes from the audience
// resolver (recipients.ts), replacing the legacy RecipientKey/ACTIONS.recipients
// above as the multi-select's data source (that pair stays put, unchanged, for
// back-compat — see recipientsFor()). AudienceKey is a separate name from this
// file's own (legacy) RecipientKey so the two nine- vs six-member enums can't
// collide in the same module.
export type { AudienceKey };

export interface AudienceOption {
  key: AudienceKey;
  label: string;
  /** Plain-English copy for the audiences that aren't guaranteed to resolve to anyone (skipped, not blocked). */
  hint?: string;
}

/** Copy for the "not-guaranteed" audiences — Ran's decision: hint inline, never block authoring on these. */
function audienceHint(key: AudienceKey, entity: AutomationEntity): string | undefined {
  switch (key) {
    // Following a task is self-service, so a task can legitimately have no watchers at all.
    // `assignees` gets no hint on purpose: the task API refuses to leave a live task with an
    // empty assignee list, so there is nothing to warn the author about.
    case 'watchers':
      return 'Skipped if nobody is watching the task.';
    case 'salesperson':
      return 'Skipped if no salesperson is set.';
    case 'dispatcher':
      return 'Skipped if no dispatcher is set.';
    case 'creator':
      return 'Skipped if the record has no creator on file.';
    case 'assigned_team':
      return entity === 'lead' ? 'Skipped if no walkthrough team is assigned yet.' : 'Skipped if no one is assigned yet.';
    default:
      return undefined;
  }
}

/** The two triggers whose whole point is "someone was just taken off the record" — the only
 *  place `removed_user` means anything, since it resolves from the dispatching event, not the
 *  live entity (they're gone from it by the time the automation runs). */
const REMOVED_RECIPIENT_TRIGGERS: ReadonlySet<AutomationTriggerType> = new Set([
  'TECH_UNASSIGNED',
  'WALKTHROUGH_PERFORMER_REMOVED',
] satisfies AutomationTriggerType[]);

/** The mirror of REMOVED_RECIPIENT_TRIGGERS: the triggers that fire once PER newly-added
 *  person. A live-roster audience is the wrong one here - `assigned_team` resolves to the full
 *  crew/team and `assignees` to the whole task roster, so either would re-notify everyone
 *  already on the record every time one more person joins.
 *
 *  TASK_ASSIGNED (Spec B) joins them for exactly that reason: a task can carry several people,
 *  so building its default on `assignees` would re-email all of them on every addition, with no
 *  error and nothing in the logs. A single-assignee test cannot see it either - with one person
 *  on the task the two audiences return the same row. */
const ASSIGNED_RECIPIENT_TRIGGERS: ReadonlySet<AutomationTriggerType> = new Set([
  'TECH_ASSIGNED',
  'WALKTHROUGH_PERFORMER_ASSIGNED',
  'TASK_ASSIGNED',
] satisfies AutomationTriggerType[]);

/**
 * Legal recipient audiences for one trigger+action pair — the multi-select's
 * data source. Starts from audiencesForEntity(trigger.entity), adds `removed_user`
 * for the two REMOVED triggers and `assigned_user` for the three ASSIGNED triggers
 * (both trigger-specific, not entity-wide — added here rather than in
 * audiencesForEntity since e.g. JOB_SCHEDULED/TECH_ASSIGNED share job's entity
 * but only one of them has an assigned person to offer), then adds the one
 * channel-specific audience: SEND_EMAIL gets `custom` (a one-off address, not tied
 * to any user/entity relationship).
 *
 * `custom` is now the ONLY difference between the two channels' lists, and Spec C
 * slice 1 is where that became true. SEND_SMS used to narrow the whole list down to
 * `customer` on the grounds that there was no way to text a team number - which also
 * silently dropped removed_user and assigned_user, appended just above. A text step
 * now reaches whoever an email step reaches. `custom` stays email-only because it is
 * an audience of literal email ADDRESSES with nothing on a handset to resolve to;
 * `.strict()` on sendTextConfigSchema is what keeps its companion `custom_emails`
 * field off a text step.
 *
 * The task entity is where the change reads clearest: a task's audience is entirely
 * staff, so a task trigger used to advertise ZERO legal SMS audiences (there was no
 * `customer` for the filter to keep) and now advertises the same six an email does.
 *
 * NOTE the deliberate asymmetry with recipientsFor() above, which still narrows to
 * `customer`. That is the legacy six-member key set, read by nothing an admin can see;
 * widening it would be dead-payload churn. This function is the live one - it feeds
 * both the builder's multi-select and validateStep's publish-time legality check.
 *
 * The retired in-app action used to have a third branch here, dropping `customer`.
 * It went with the action: nothing can reach this function with a step type the
 * builder no longer offers and validateStep refuses ahead of the audience check,
 * so the branch was computing a legal set for a step that can never be published.
 */
export function audiencesFor(trigger: AutomationTriggerType, action: AuthorableActionType): AudienceOption[] {
  const entity = TRIGGERS[trigger].entity;
  let keys: AudienceKey[] = audiencesForEntity(entity);
  if (REMOVED_RECIPIENT_TRIGGERS.has(trigger)) {
    keys = [...keys, 'removed_user'];
  }
  if (ASSIGNED_RECIPIENT_TRIGGERS.has(trigger)) {
    keys = [...keys, 'assigned_user'];
  }
  if (action === 'SEND_EMAIL') {
    keys = [...keys, 'custom'];
  }
  return keys.map((key) => {
    const label = audienceLabel(key, entity);
    const hint = audienceHint(key, entity);
    return hint ? { key, label, hint } : { key, label };
  });
}

// Derived from ACTIONS (not hardcoded) so a future authorable action - which
// TypeScript already forces into the ACTIONS record above — is picked up here too.
// The cast is over the AUTHORABLE union, not the Prisma enum: casting to the enum
// would not error and would therefore lie about a key set that no longer spans it.
const AUDIENCE_ACTION_TYPES = Object.keys(ACTIONS) as AuthorableActionType[];

/** Every trigger × action's legal audiences — served verbatim by GET /api/workflows/catalog. */
export const AUDIENCES: Record<AutomationTriggerType, Record<AuthorableActionType, AudienceOption[]>> = (() => {
  const result = {} as Record<AutomationTriggerType, Record<AuthorableActionType, AudienceOption[]>>;
  for (const trigger of Object.keys(TRIGGERS) as AutomationTriggerType[]) {
    const byAction = {} as Record<AuthorableActionType, AudienceOption[]>;
    for (const action of AUDIENCE_ACTION_TYPES) {
      byAction[action] = audiencesFor(trigger, action);
    }
    result[trigger] = byAction;
  }
  return result;
})();

// ── prebuilt templates ────────────────────────────────────────────────────────

export interface AutomationTemplate {
  key: string;
  name: string;
  description: string;
  category: 'customer' | 'team' | 'money';
  trigger_type: AutomationTriggerType;
  /**
   * Two shapes, matching the two kinds of timed trigger the validator recognises: the legacy
   * bare offset (BEFORE_JOB_START, ESTIMATE_FOLLOW_UP, INVOICE_OVERDUE) and the anchor +
   * direction + offset of the date-anchored family. Widened by Spec B slice 7 for the task
   * due-date recipes, which have no event to hang a WAIT off - an anchored WAIT step accepts
   * only the two mid-workflow anchors, so a task reminder has to be a date-anchored TRIGGER.
   *
   * Structurally the validator's DateAnchorTriggerConfig, spelled out here rather than
   * imported: workflowValidation.ts imports THIS module, so taking the type back off it would
   * close a cycle.
   */
  trigger_config?: { offset_minutes: number } | { anchor: AnchorKey; direction: WaitDirection; offset_minutes: number };
  /**
   * Authorable, not the Prisma enum: five gallery entries used to install an
   * in-app workflow in one click, which is the very configuration ADR 0005
   * retires. Typing the field this way makes bringing one back a build failure
   * rather than something the every-template-validates test has to catch.
   */
  action_type: AuthorableActionType;
  action_config: {
    /**
     * The AUDIENCE key, not the legacy six-member RecipientKey this file also exports.
     * Widened by Spec B slice 7: a task recipe addresses `assignees`, which the legacy list
     * has never carried, and the legality check that actually gates a recipe is audiencesFor
     * - the same function validateStep enforces and the builder's multi-select reads.
     */
    recipient: AudienceKey;
    subject?: string;
    body: string;
    custom_email?: string;
    user_id?: string;
  };
  /**
   * Optional full step sequence for multi-step recipes (e.g. an anchored WAIT
   * before a SEND_EMAIL). When present, `templateToWorkflowBody` (FE) uses it
   * verbatim instead of folding `action_type`/`action_config` into one step.
   * `action_type`/`action_config` still carry a representative single action
   * for category grouping and gallery-card display either way.
   */
  steps?: Array<{ step_type: WorkflowStepType; config: Record<string, unknown> }>;
  /**
   * Always `ANYTIME`. The per-automation send window was removed from the
   * builder together with the trigger-surface control: the timing builder now
   * states send time concretely ("2 days before the invoice due date"), so a
   * separate "…but only 8am–8pm" qualifier contradicted the sentence the UI
   * shows, with no control left anywhere to reveal or change it. Seven recipes
   * used to ship BUSINESS_HOURS; leaving them would have meant real deferral
   * behaviour that no screen could explain.
   *
   * Kept as a field (not deleted) because published WorkflowVersions froze it
   * and `enrollment.ts` still reads it for those rows. Reinstate quiet hours as
   * ONE org-level setting before SMS unlocks (#743) — a 2am email is harmless,
   * a 2am text is not.
   */
  send_window: AutomationSendWindow;
}

export const TEMPLATES: AutomationTemplate[] = [
  // ── Customer messages ──────────────────────────────────────────────────────
  {
    key: 'reminder-24h',
    name: '24-hour appointment reminder',
    description: 'Text the customer one day before their scheduled job. The single biggest no-show reducer.',
    category: 'customer',
    trigger_type: 'BEFORE_JOB_START',
    trigger_config: { offset_minutes: 24 * 60 },
    action_type: 'SEND_SMS',
    action_config: {
      recipient: 'customer',
      body: 'Hi {{customer.first_name}}, a reminder from {{org.name}}: {{technician.names}} is scheduled for {{job.scheduled_date}} at {{job.scheduled_time}} at {{job.address}}. Questions? Call us at {{org.phone}}.',
    },
    send_window: 'ANYTIME',
  },
  {
    key: 'reminder-1h',
    name: '1-hour heads-up',
    description: 'A short text shortly before the technician arrives.',
    category: 'customer',
    trigger_type: 'BEFORE_JOB_START',
    trigger_config: { offset_minutes: 60 },
    action_type: 'SEND_SMS',
    action_config: {
      recipient: 'customer',
      body: '{{org.name}} here — {{technician.names}} will arrive at {{job.address}} around {{job.scheduled_time}} today. See you soon!',
    },
    send_window: 'ANYTIME',
  },
  {
    key: 'job-scheduled-confirmation',
    name: 'Job scheduled confirmation',
    description: 'Email the customer as soon as their job gets a date on the calendar.',
    category: 'customer',
    trigger_type: 'JOB_SCHEDULED',
    action_type: 'SEND_EMAIL',
    action_config: {
      recipient: 'customer',
      subject: 'Your appointment with {{org.name}} is booked — {{job.scheduled_date}}',
      body: 'Hi {{customer.first_name}},\n\nYour appointment is confirmed:\n\nJob {{job.number}} — {{job.type}}\n{{job.scheduled_date}} at {{job.scheduled_time}}\n{{job.address}}\n\nIf you need to make changes, call us at {{org.phone}}.\n\nThank you,\n{{org.name}}',
    },
    send_window: 'ANYTIME',
  },
  {
    key: 'job-rescheduled-notice',
    name: 'Reschedule notice',
    description: 'Text the customer their new time whenever a job is moved. Most platforms forget this one.',
    category: 'customer',
    trigger_type: 'JOB_RESCHEDULED',
    action_type: 'SEND_SMS',
    action_config: {
      recipient: 'customer',
      body: 'Hi {{customer.first_name}}, your appointment with {{org.name}} has been moved to {{job.scheduled_date}} at {{job.scheduled_time}}. Questions? Call {{org.phone}}.',
    },
    send_window: 'ANYTIME',
  },
  {
    key: 'estimate-follow-up-3d',
    name: 'Estimate follow-up (3 days)',
    description: 'Nudge customers who haven’t responded to an estimate after 3 days. Stops automatically once they approve or decline.',
    category: 'customer',
    trigger_type: 'ESTIMATE_FOLLOW_UP',
    trigger_config: { offset_minutes: 3 * 24 * 60 },
    action_type: 'SEND_EMAIL',
    action_config: {
      recipient: 'customer',
      subject: 'Any questions about your estimate from {{org.name}}?',
      body: 'Hi {{customer.first_name}},\n\nJust checking in on estimate {{estimate.number}} for {{estimate.total}} — happy to answer any questions or adjust the scope.\n\nYou can review and approve it here: {{estimate.link}}\n\nThank you,\n{{org.name}} · {{org.phone}}',
    },
    send_window: 'ANYTIME',
  },
  {
    key: 'estimate-follow-up-7d',
    name: 'Estimate follow-up (7 days)',
    description: 'A second, final nudge one week after sending.',
    category: 'customer',
    trigger_type: 'ESTIMATE_FOLLOW_UP',
    trigger_config: { offset_minutes: 7 * 24 * 60 },
    action_type: 'SEND_EMAIL',
    action_config: {
      recipient: 'customer',
      subject: 'Still interested? Your {{org.name}} estimate is ready when you are',
      body: 'Hi {{customer.first_name}},\n\nYour estimate {{estimate.number}} ({{estimate.total}}) is still available — approve it online any time:\n{{estimate.link}}\n\nIf now isn’t the right time, just reply and let us know.\n\nThank you,\n{{org.name}}',
    },
    send_window: 'ANYTIME',
  },
  {
    key: 'review-request',
    name: 'Review request',
    description: 'Ask for a review the day after a job is completed, while the experience is fresh.',
    category: 'customer',
    trigger_type: 'AFTER_JOB_COMPLETED',
    trigger_config: { offset_minutes: 24 * 60 },
    action_type: 'SEND_SMS',
    action_config: {
      recipient: 'customer',
      body: 'Hi {{customer.first_name}}, thanks for choosing {{org.name}}! If {{technician.names}} did a great job, we’d really appreciate a quick review — it helps our small business a lot.',
    },
    send_window: 'ANYTIME',
  },
  {
    key: 'walkthrough-scheduled-confirmation',
    name: 'Walkthrough confirmation',
    description: 'Email the customer as soon as their walkthrough is booked.',
    category: 'customer',
    trigger_type: 'WALKTHROUGH_SCHEDULED',
    action_type: 'SEND_EMAIL',
    action_config: {
      recipient: 'customer',
      subject: 'Your walkthrough with {{org.name}} is booked — {{lead.walkthrough_date}}',
      body: 'Hi {{customer.first_name}},\n\nYour walkthrough is scheduled for {{lead.walkthrough_date}} at {{lead.walkthrough_time}}.\n\n{{lead.performer_names}} will be there. Questions? Call {{org.phone}}.\n\nThank you,\n{{org.name}}',
    },
    send_window: 'ANYTIME',
  },
  {
    key: 'walkthrough-reminder-1d',
    name: 'Walkthrough reminder (1 day before)',
    description: 'Email the customer a reminder the day before their walkthrough. Follows the walkthrough if it moves.',
    category: 'customer',
    trigger_type: 'WALKTHROUGH_SCHEDULED',
    action_type: 'SEND_EMAIL',
    action_config: {
      recipient: 'customer',
      subject: 'Reminder: your walkthrough with {{org.name}} is tomorrow',
      body: 'Hi {{customer.first_name}},\n\nReminder — your walkthrough is {{lead.walkthrough_date}} at {{lead.walkthrough_time}}. See you then!\n\n{{org.name}} · {{org.phone}}',
    },
    steps: [
      { step_type: 'WAIT', config: { mode: 'anchored', anchor: 'lead.walkthrough_scheduled_at', direction: 'before', offset_minutes: 1440 } },
      { step_type: 'SEND_EMAIL', config: { recipient: 'customer', subject: 'Reminder: your walkthrough with {{org.name}} is tomorrow', body: 'Hi {{customer.first_name}},\n\nReminder — your walkthrough is {{lead.walkthrough_date}} at {{lead.walkthrough_time}}. See you then!\n\n{{org.name}} · {{org.phone}}' } },
    ],
    send_window: 'ANYTIME',
  },
  // ── Getting paid ───────────────────────────────────────────────────────────
  {
    key: 'invoice-overdue-3d',
    name: 'Overdue invoice reminder',
    description: 'A friendly nudge 3 days past due. Skips automatically the moment the invoice is paid.',
    category: 'money',
    trigger_type: 'INVOICE_OVERDUE',
    trigger_config: { offset_minutes: 3 * 24 * 60 },
    action_type: 'SEND_EMAIL',
    action_config: {
      recipient: 'customer',
      subject: 'Friendly reminder: invoice {{invoice.number}} from {{org.name}}',
      body: 'Hi {{customer.first_name}},\n\nJust a friendly reminder that invoice {{invoice.number}} for {{invoice.total}} was due on {{invoice.due_date}}.\n\nYou can view and pay it online here: {{invoice.link}}\n\nAlready paid? Please disregard this note — and thank you!\n\n{{org.name}} · {{org.phone}}',
    },
    send_window: 'ANYTIME',
  },
  {
    key: 'payment-thank-you',
    name: 'Payment thank-you',
    description: 'Thank the customer automatically when an invoice is paid in full.',
    category: 'money',
    trigger_type: 'INVOICE_PAID',
    action_type: 'SEND_EMAIL',
    action_config: {
      recipient: 'customer',
      subject: 'Thank you from {{org.name}}!',
      body: 'Hi {{customer.first_name}},\n\nWe’ve received your payment for invoice {{invoice.number}} — thank you!\n\nIt was a pleasure working with you. If you ever need us again, we’re one call away: {{org.phone}}.\n\n{{org.name}}',
    },
    send_window: 'ANYTIME',
  },
  // ── Team coordination ──────────────────────────────────────────────────────
  //
  // Spec B slice 7. This category emptied when the in-app step type was retired and refills
  // here with EMAIL recipes: the category was always about who the message reaches, not about
  // the channel, and a task is internal work whose audience is staff.
  //
  // Email only, and not by preference: a task has no customer, so audiencesFor leaves a task
  // trigger with zero legal SMS audiences and a text recipe here could never be published.
  //
  // Deliberately sequenced into the slice that seeds the defaults rather than the one that
  // widened the entity, so the gallery never offers a recipe for a trigger that cannot yet
  // deliver.
  {
    key: 'task-due-soon-reminder',
    name: 'Task due tomorrow',
    description: 'Email the people on a task the day before it is due. Done and cancelled tasks are never chased.',
    category: 'team',
    trigger_type: 'TASK_DATE_ANCHORED',
    trigger_config: { anchor: 'task.due_at', direction: 'before', offset_minutes: 24 * 60 },
    action_type: 'SEND_EMAIL',
    action_config: {
      recipient: 'assignees',
      subject: 'Due tomorrow: {{task.title}}',
      body: 'A reminder that task {{task.number}} - {{task.title}} is due {{task.due_date}}.\n\nOpen it here: {{task.link}}\n\n{{org.name}}',
    },
    send_window: 'ANYTIME',
  },
  {
    key: 'task-overdue-chase',
    name: 'Overdue task chase',
    description: 'Email the people on a task a day after its due date passes, so work does not sit forgotten.',
    category: 'team',
    trigger_type: 'TASK_DATE_ANCHORED',
    // The SAME trigger as the recipe above, pointed the other way. One trigger covers both
    // directions, which is why Spec B has no separate overdue trigger.
    trigger_config: { anchor: 'task.due_at', direction: 'after', offset_minutes: 24 * 60 },
    action_type: 'SEND_EMAIL',
    action_config: {
      recipient: 'assignees',
      subject: 'Still open: {{task.title}}',
      // "Status:" as a labelled line rather than "is still {{task.status}}" - that field renders
      // a capitalised label ("In progress"), which reads wrong mid-sentence at some values and
      // right at none. Same rule the crew-name lines in defaultAutomations.ts follow.
      body: 'Task {{task.number}} - {{task.title}} was due {{task.due_date}} and has not been closed out.\n\nStatus: {{task.status}}\n\nOpen it here: {{task.link}}\n\n{{org.name}}',
    },
    send_window: 'ANYTIME',
  },
  {
    key: 'task-comment-notice',
    name: 'Task comment notice',
    description: 'Email the people on a task when somebody comments, so a question on a task actually gets answered.',
    category: 'team',
    trigger_type: 'TASK_COMMENT_ADDED',
    action_type: 'SEND_EMAIL',
    action_config: {
      // The assignees. A recipe carries ONE audience; an admin who also wants the watchers
      // adds them in the builder, where both are offered on every task trigger.
      recipient: 'assignees',
      subject: 'New comment on: {{task.title}}',
      body: 'Somebody has commented on task {{task.number}} - {{task.title}}.\n\nRead it and reply here: {{task.link}}\n\n{{org.name}}',
    },
    send_window: 'ANYTIME',
  },
];
