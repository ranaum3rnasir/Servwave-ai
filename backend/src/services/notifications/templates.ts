/**
 * templates.ts — per-verb notification template registry
 *
 * Encodes the title/body/category/priority/action_type/object_type for every
 * v1 verb listed in the in-app-notifications implementation plan (lines 53–62).
 *
 * Deferred verbs (estimate.viewed, *.delivery_failed, billing.payment_failed,
 * service_plan.*) are intentionally NOT in this registry. renderTemplate() throws
 * for any unrecognised verb so the caller can log and skip.
 *
 * `task.*` is NO LONGER deferred: the five verbs of the multi-assignee design §5
 * (assigned / watching / completed / removed / deleted), plus `task.cancelled`
 * (issue 03) and `task.commented` (Spec B slice 3), are registered below.
 * Still deferred within that family are task.due_soon / task.overdue — they need a
 * cron that does not exist yet.
 *
 * Note on priority: the value here is the BASE (event-level) priority.
 * resolveRecipients() may assign a different priority per recipient row
 * (e.g. the same estimate.approved interrupts the Sales owner but feeds
 * the Dispatcher).  The UI uses the per-recipient row's priority, not this
 * base value.  However, we set base priority to INTERRUPT whenever ANY role
 * receives an INTERRUPT for that verb — keeps the logic conservative and
 * consistent with the §3 matrix.
 */

import { NotificationCategory, NotificationPriority } from '@prisma/client';
import { UNMATCHED_REPLY_MESSAGE } from './whyLines';

// ── helpers ──────────────────────────────────────────────────────────────────

/** Safely pull a string from the data bag; returns fallback if absent/null. */
function s(data: Record<string, any>, key: string, fallback = ''): string {
  const v = data[key];
  return typeof v === 'string' && v.length > 0 ? v : fallback;
}

/**
 * The why line of an alert that came to a person as a fallback (Roles & Permissions, PRD 6): the sentence that says why it reached
 * them ("This invoice has no job or lead"), added under the body. Nothing when the person was told as the record's own person.
 */
function withWhy(data: Record<string, any>, body?: string): string | undefined {
  return [body ?? '', s(data, 'fallback_reason')].filter(Boolean).join('\n') || undefined;
}

/** "Dana", "Dana and Sam", "Dana, Sam and Lee": the names an alert gives to the people it is about. */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The people an alert names, from the data bag (the "naming" wording of Job assigned); empty when it names nobody. */
function namedPeople(data: Record<string, any>): string[] {
  const v = data['assigned_names'];
  return Array.isArray(v) ? v.filter((n): n is string => typeof n === 'string' && n.length > 0) : [];
}


/**
 * V7-13 part 2 (BE-13d, BE-13e): what happened to the customer after a bank payment failed or was returned, in the
 * office's words. `customer_notice` is the outcome of the email attempt; a key missing (a notice stored before this
 * existed) says nothing about the customer, so it never claims a send.
 */
const CANNOT_PAY_ONLINE = 'No email was sent because this invoice cannot be paid online right now.';
const NO_EMAIL_ON_FILE = 'No email was sent because this customer has no email address on file. Contact them to pay again.';
const EMAIL_BOUNCED = 'No email was sent because earlier emails to this customer\u2019s address bounced. Contact them to pay again.';
const EMAIL_NOT_SENT = 'The email to the customer could not be sent. Contact them to pay again.';

/** The ending of billing.bank_payment_failed, by outcome. */
const BANK_FAILED_ENDING: Record<string, string> = {
  sent: 'We emailed the customer a link to pay again.',
  no_email: NO_EMAIL_ON_FILE,
  bounced: EMAIL_BOUNCED,
  not_sent: EMAIL_NOT_SENT,
  // BE-13d: unchanged on its own; the C-38 sentence needs the `cannot_pay` marker (PAID by another payment or DISPUTED).
  not_open: 'The invoice is no longer open for payment.',
};

/** The ending for this notice: the C-38 sentence replaces `not_open` only when the marker says PAID by another payment or DISPUTED. */
function bankFailedEnding(data: Record<string, any>): string | undefined {
  const notice = s(data, 'customer_notice');
  return notice === 'not_open' && s(data, 'cannot_pay') ? CANNOT_PAY_ONLINE : BANK_FAILED_ENDING[notice];
}

/**
 * The body of billing.chargeback for a bank return. The balance is named only when the marker says the debit had
 * cleared (`cleared` yes); one returned before it cleared never reached the balance, and a missing marker says
 * nothing about it. The ending follows the customer outcome; `cannot_pay` marks a not_open invoice that is PAID or
 * DISPUTED rather than voided.
 */
function bankReturnBody(data: Record<string, any>): string | undefined {
  const amount = s(data, 'amount');
  if (!amount) return undefined;
  const cleared = s(data, 'cleared');
  const base = cleared === 'yes'
    ? 'Amount: $' + amount + ' was taken back from your ServWave Payments balance.'
    : cleared === 'no'
      ? 'Amount: $' + amount + '. The bank returned this payment before it cleared, so no money reached your ServWave Payments balance.'
      : 'Amount: $' + amount + '.';
  const open = cleared === 'no' ? 'The invoice is still open' : 'The invoice is open again';
  const notice = s(data, 'customer_notice');
  const ending: string | undefined = notice === 'sent' ? open + ' and we emailed the customer a link to pay again.'
    : notice === 'no_email' ? open + '. ' + NO_EMAIL_ON_FILE
    : notice === 'bounced' ? open + '. ' + EMAIL_BOUNCED
    : notice === 'not_sent' ? open + '. ' + EMAIL_NOT_SENT
    : notice === 'not_open' ? (s(data, 'cannot_pay') ? CANNOT_PAY_ONLINE : 'The invoice stays voided, so the customer was not asked to pay.')
    : undefined;
  return ending ? base + ' ' + ending : base;
}

/**
 * Payments go-live slice 09: a dispute or bank return on money that has no payment row (written
 * down as unapplied, or a bank payment recorded by hand) changes nothing on the invoice, so the
 * alert says what a person must check. Undefined when the dispute is on a recorded payment.
 */
function unrecordedDisputeBody(data: Record<string, any>, stage: 'open' | 'lost'): string | undefined {
  const unrecorded = s(data, 'unrecorded');
  if (unrecorded === 'bank') {
    return 'This bank payment was not recorded automatically, so nothing on the invoice changed. '
      + 'If it was recorded by hand, void that payment and check the balance.';
  }
  if (unrecorded === 'card') {
    return 'This payment was not recorded on the invoice, so nothing on the invoice changed. '
      + (stage === 'open'
        ? 'Do not refund it while the dispute is open; contact ServWave support if you need help.'
        : 'The money was taken back: do not refund it.');
  }
  return undefined;
}

/** The processor's reason code, in words an owner reads ("product_not_received" -> "Product not received"). */
export function disputeReasonWords(reason: string | null | undefined): string {
  const words = (reason ?? '').replace(/_/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : '';
}

/** Slice 32: the body of a dispute alert - what, why and by when. */
function openedDisputeBody(data: Record<string, any>): string | undefined {
  const amount = s(data, 'amount');
  const reason = s(data, 'reason_words');
  if (s(data, 'variant') === 'bank_return') {
    if (!amount) return undefined;
    return `The bank took back $${amount}.` + (reason ? ` Reason: ${reason}.` : '');
  }
  const parts = [
    amount ? `Amount: $${amount}.` : '',
    reason ? `Reason: ${reason}.` : '',
    s(data, 'evidence_due') ? `Respond by ${s(data, 'evidence_due')}.` : '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : undefined;
}

/** Communication verbs: customer name → caller number → object label. */
function comWho(data: Record<string, any>): string {
  return s(data, 'customer_name')
    || s(data, 'caller_number')
    || s(data, 'object_label', 'Unknown number');
}

/**
 * The never-silent fallback of a call or text alert (S08.24) adds the company number it came in on and the time to the data. A
 * holder who cannot read the conversation gets the alert with `redacted` set and none of the caller's details: the title names the
 * company number, and the body says when. A holder who can read it gets the ordinary title, then the line that says on which
 * number and when, ahead of the reason line.
 */
function fallbackTitle(what: string, data: Record<string, any>): string {
  return `${what} on ${s(data, 'company_number', 'a company number')}`;
}

/** "On (555) 555-0142, October 12, 2026 at 7:05 PM": where and when a call or text the fallback tells came in; nothing when unknown. */
function fallbackWhere(data: Record<string, any>): string | undefined {
  const number = s(data, 'company_number');
  const at = s(data, 'occurred_at');
  if (number && at) return `On ${number}, ${at}`;
  if (number) return `On ${number}`;
  return at || undefined;
}

// ── public interface ──────────────────────────────────────────────────────────

export interface RenderedTemplate {
  category: NotificationCategory;
  /** Base/event-level priority. Per-recipient priority lives on the recipient row. */
  priority: NotificationPriority;
  needs_action: boolean;
  action_type: string | null;
  title: string;
  body?: string;
  object_type: string;
}

type TemplateFactory = (data: Record<string, any>) => RenderedTemplate;

// ── registry ─────────────────────────────────────────────────────────────────

// `satisfies` rather than a `Record<string, TemplateFactory>` annotation: an annotation is
// the DECLARED type of the binding, so it discards the literal keys and collapses
// `keyof typeof registry` to `string`. That would silently degrade VERB_RULES below from an
// exhaustive map into a free-for-all - every missing and every stray verb would compile.
// The trailing clause still supplies the contextual type, so every `category: 'LEAD'` /
// `priority: 'INTERRUPT'` literal keeps narrowing to its Prisma enum and no entry below
// needed editing. Same pattern and same reasoning as lib/pdf/templates/registry.ts:14-17.
// Deliberately NOT `as const`: the values are functions, and it would make every factory's
// return type readonly.
const registry = {

  // ── LEAD ───────────────────────────────────────────────────────────────────

  'lead.assigned': (data) => ({
    category: 'LEAD',
    object_type: 'LEAD',
    priority: 'INTERRUPT',
    action_type: null,
    needs_action: false,
    title: s(data, 'object_label', 'Lead') + ' assigned to you'
      + (s(data, 'customer_name') ? ' — ' + s(data, 'customer_name') : ''),
  }),

  'lead.unassigned_created': (data) => ({
    category: 'LEAD',
    object_type: 'LEAD',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: 'New lead with no owner'
      + (s(data, 'customer_name') ? ': ' + s(data, 'customer_name') : '')
      + (s(data, 'object_label') ? ' (' + s(data, 'object_label') + ')' : ''),
    // Roles & Permissions, PRD 6 (S06.26): `fallback_reason` is the sentence that says why the person covering for a missing
    // Dispatcher was told. Every verb that moved onto M6's chain carries it as its body.
    body: s(data, 'fallback_reason') || undefined,
  }),

  'lead.reassigned_away': (data) => ({
    category: 'LEAD',
    object_type: 'LEAD',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: s(data, 'object_label', 'Lead') + ' reassigned away from you'
      + (s(data, 'customer_name') ? ' — ' + s(data, 'customer_name') : ''),
  }),

  'lead.walkthrough_scheduled': (data) => ({
    category: 'LEAD',
    object_type: 'LEAD',
    priority: 'INTERRUPT',
    action_type: null,
    needs_action: false,
    title: 'Walkthrough scheduled for '
      + s(data, 'object_label', 'lead')
      + (s(data, 'customer_name') ? ' — ' + s(data, 'customer_name') : ''),
    body: s(data, 'fallback_reason') || undefined,
  }),

  // Spider lead watcher (#2619): a lead stayed in a stage longer than the company's limit.
  // FEED: Spider's own button, panel and red frame are its interrupting surfaces, and the bell never
  // shows it (bellHiddenVerbs.ts, D3). His in-app title and body, which the sweep writes as `title`
  // and `body` (services/spider/messages.ts).
  'spider.alert': (data) => ({
    category: 'LEAD',
    object_type: 'LEAD',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: s(data, 'title') || 'Spider Alert - ' + s(data, 'customer_name', 'Customer') + ' (' + s(data, 'object_label', 'Lead') + ')',
    body: s(data, 'body') || undefined,
  }),

  // Spider's starting summary (#2794): one per person, the leads already past their limit when Spider
  // started watching something new. FEED: it lists in the bell and never toasts or raises the red
  // frame. The sweep writes the title and body (services/spider/summaryMessages.ts); its link_path
  // opens the person's summary.
  'spider.starting_summary': (data) => ({
    category: 'LEAD',
    object_type: 'SPIDER_SUMMARY',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: s(data, 'title') || 'Spider is on. Some of your leads were already past their limit.',
    body: s(data, 'body') || undefined,
  }),

  // ── ESTIMATE ───────────────────────────────────────────────────────────────

  'estimate.approved': (data) => ({
    category: 'ESTIMATE',
    object_type: 'ESTIMATE',
    priority: 'INTERRUPT',
    action_type: 'SCHEDULE_JOB',
    needs_action: true,
    title: s(data, 'object_label', 'Estimate') + ' won'
      + (s(data, 'customer_name') ? ' by ' + s(data, 'customer_name') : ''),
    // #2090 - what the customer actually bought. An estimate that offered no add-ons carries
    // neither key, so its body is exactly the amount line it was before this existed.
    body: [
      [
        s(data, 'amount') ? 'Amount: $' + s(data, 'amount') : '',
        s(data, 'options_chosen') ? 'Chose: ' + s(data, 'options_chosen') : '',
        s(data, 'options_declined') ? 'Declined: ' + s(data, 'options_declined') : '',
      ].filter(Boolean).join(' · '),
      // S06.26: why this reached a person who is covering for a missing Dispatcher, on its own line.
      s(data, 'fallback_reason'),
    ].filter(Boolean).join('\n') || undefined,
  }),

  'estimate.declined': (data) => ({
    category: 'ESTIMATE',
    object_type: 'ESTIMATE',
    priority: 'INTERRUPT',
    action_type: null,
    needs_action: false,
    title: s(data, 'object_label', 'Estimate') + ' declined'
      + (s(data, 'customer_name') ? ' by ' + s(data, 'customer_name') : ''),
    body: s(data, 'fallback_reason') || undefined,
  }),

  'estimate.deposit_paid': (data) => ({
    category: 'ESTIMATE',
    object_type: 'ESTIMATE',
    priority: 'INTERRUPT',
    action_type: 'SCHEDULE_JOB',
    needs_action: true,
    title: 'Deposit paid for ' + s(data, 'object_label', 'estimate')
      + (s(data, 'customer_name') ? ' — ' + s(data, 'customer_name') : ''),
    body: [s(data, 'amount') ? 'Amount: $' + s(data, 'amount') : '', s(data, 'fallback_reason')].filter(Boolean).join('\n') || undefined,
  }),

  'estimate.cancelled': (data) => ({
    category: 'ESTIMATE',
    object_type: 'ESTIMATE',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: s(data, 'object_label', 'Estimate') + ' archived'
      + (s(data, 'customer_name') ? ' — ' + s(data, 'customer_name') : ''),
    body: s(data, 'fallback_reason') || undefined,
  }),

  'estimate.deposit_waived': (data) => ({
    category: 'ESTIMATE',
    object_type: 'ESTIMATE',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: 'Deposit waived for ' + s(data, 'object_label', 'estimate')
      + (s(data, 'customer_name') ? ' — ' + s(data, 'customer_name') : ''),
    body: s(data, 'fallback_reason') || undefined,
  }),

  // R4 (2026-07-21) — D13 guarded unwind (port-plan §3.2).
  'estimate.approval_voided': (data) => ({
    category: 'ESTIMATE',
    object_type: 'ESTIMATE',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: 'Approval voided for ' + s(data, 'object_label', 'estimate')
      + (s(data, 'customer_name') ? ' — ' + s(data, 'customer_name') : ''),
    body: s(data, 'fallback_reason') || undefined,
  }),

  // R4b (2026-07-21) — backtodraft/backtosent (port-plan §3.2/§14.2). No `estimate.marked_sent`
  // entry here: mark-sent deliberately stays silent, matching send()'s own first-send path, which
  // has never emitted a notification either — sending/marking-sent is the actor's own action, not
  // something that happens TO them.
  'estimate.status_corrected': (data) => ({
    category: 'ESTIMATE',
    object_type: 'ESTIMATE',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: s(data, 'object_label', 'Estimate') + ' ' + s(data, 'transition_label', 'status corrected')
      + (s(data, 'customer_name') ? ' — ' + s(data, 'customer_name') : ''),
    body: s(data, 'fallback_reason') || undefined,
  }),

  // ── DISPATCH ───────────────────────────────────────────────────────────────

  // Job assigned (S06.27) has two wordings of one event: "J00123 assigned to you" for the person named, and, for everyone else the
  // chain reaches, the same alert naming whoever was assigned ("Dana was assigned to J00123"; `assigned_names` is set on that one).
  // `fallback_reason` is the sentence that says why the person covering for a missing Dispatcher was told.
  'dispatch.job_assigned': (data) => {
    const named = namedPeople(data);
    return {
      category: 'DISPATCH',
      object_type: 'JOB',
      priority: 'INTERRUPT',
      action_type: null,
      needs_action: false,
      title: named.length > 0
        ? `${joinNames(named)} ${named.length > 1 ? 'were' : 'was'} assigned to ${s(data, 'object_label', 'the job')}`
        : s(data, 'object_label', 'Job') + ' assigned to you'
          + (s(data, 'customer_name') ? ' — ' + s(data, 'customer_name') : ''),
      body: s(data, 'fallback_reason') || undefined,
    };
  },

  'dispatch.job_unassigned': (data) => ({
    category: 'DISPATCH',
    object_type: 'JOB',
    priority: 'INTERRUPT',
    action_type: null,
    needs_action: false,
    // `visit_label` (visits-and-task-categories slice 02): the person came off ONE trip and is still
    // on another trip of the job, so the notice names the trip, not the job.
    title: s(data, 'visit_label')
      ? s(data, 'object_label', 'Job') + ' ' + s(data, 'visit_label') + ' — you were removed from this visit'
      : s(data, 'object_label', 'Job') + ' unassigned from you',
  }),

  'dispatch.job_rescheduled': (data) => ({
    category: 'DISPATCH',
    object_type: 'JOB',
    priority: 'INTERRUPT',
    action_type: null,
    needs_action: false,
    title: s(data, 'object_label', 'Job') + ' rescheduled'
      + (s(data, 'customer_name') ? ' — ' + s(data, 'customer_name') : ''),
    body: s(data, 'fallback_reason') || undefined,
  }),

  'dispatch.job_created': (data) => ({
    category: 'DISPATCH',
    object_type: 'JOB',
    priority: 'INTERRUPT',
    action_type: null,
    needs_action: false,
    title: 'Job created'
      + (s(data, 'object_label') ? ': ' + s(data, 'object_label') : '')
      + (s(data, 'customer_name') ? ' — ' + s(data, 'customer_name') : ''),
    body: s(data, 'fallback_reason') || undefined,
  }),

  // ── JOB ────────────────────────────────────────────────────────────────────

  // Roles & Permissions, PRD 6 (S06.25). Job started, cancelled and reopened go through M6's two lanes like the job completed
  // alert below; `fallback_reason` is the sentence that says why the person covering for a missing Dispatcher was told.
  // The words and the priorities are what they always were.
  'job.started': (data) => ({
    category: 'JOB',
    object_type: 'JOB',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: s(data, 'object_label', 'Job') + ' started'
      + (s(data, 'customer_name') ? ' — ' + s(data, 'customer_name') : ''),
    body: s(data, 'fallback_reason') || undefined,
  }),

  // Roles & Permissions, PRD 6 (S06.23). Completing a job lands it in Office review, so the alert says so. `panel` rides
  // in the notification's data (the job page opens that panel); `fallback_reason` is the sentence that says why the
  // person covering for a missing Dispatcher was told.
  'job.completed': (data) => ({
    category: 'JOB',
    object_type: 'JOB',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: 'Job completed: ' + s(data, 'object_label', 'the job') + ' is ready for office review',
    body: s(data, 'fallback_reason') || undefined,
  }),

  // Roles & Permissions, PRD 6 (S06.24). Finishing a review moves the job to Ready to close; the alert asks the people
  // who close jobs to look. Its link opens the job itself (no `panel`), where the banner offers Mark Done. FEED, and
  // the resolver sets "needs action" for the Close jobs holders only. `fallback_reason` says why the Manage roles
  // and permissions holders were told when nobody who can close jobs can open the job.
  'job.ready_to_close': (data) => ({
    category: 'JOB',
    object_type: 'JOB',
    priority: 'FEED',
    action_type: null,
    needs_action: true,
    title: s(data, 'object_label', 'The job') + ' is ready to close',
    body: s(data, 'fallback_reason') || undefined,
  }),

  // Roles & Permissions, PRD 6 (S06.24). Office review attention: one alert for a landing, listing what changed in the
  // panel's own words (`items_text`, one line per item). High priority, bell only; its link opens the review panel.
  'job.review_attention': (data) => ({
    category: 'JOB',
    object_type: 'JOB',
    priority: 'INTERRUPT',
    action_type: null,
    needs_action: false,
    title: s(data, 'object_label', 'The job') + ' needs your attention',
    body: [s(data, 'items_text'), s(data, 'fallback_reason')].filter(Boolean).join('\n') || undefined,
  }),

  'job.cancelled': (data) => ({
    category: 'JOB',
    object_type: 'JOB',
    priority: 'INTERRUPT',
    action_type: null,
    needs_action: false,
    title: s(data, 'object_label', 'Job') + ' cancelled'
      + (s(data, 'customer_name') ? ' — ' + s(data, 'customer_name') : ''),
    body: s(data, 'fallback_reason') || undefined,
  }),

  'job.reopened': (data) => ({
    category: 'JOB',
    object_type: 'JOB',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: s(data, 'object_label', 'Job') + ' reopened'
      + (s(data, 'customer_name') ? ' — ' + s(data, 'customer_name') : ''),
    body: s(data, 'fallback_reason') || undefined,
  }),

  // Roles & Permissions, PRD 4 (S04.16). One alert per finished visit, through M6's two lanes. The last
  // live visit's alert is the one that asks somebody to complete the job, so it carries needs_action; the
  // resolver sets it per person (only the people who must act are asked). `fallback_reason` is the sentence
  // that says why lane 2 reached them when the job has no Dispatcher.
  'job.visit_finished': (data) => {
    const finished = 'Visit ' + s(data, 'visit_seq', '1') + ' finished on ' + s(data, 'object_label', 'the job')
      + (s(data, 'actor_name') ? ', by ' + s(data, 'actor_name') : '');
    const reason = s(data, 'fallback_reason');
    if (data.all_finished === true) {
      return {
        category: 'JOB',
        object_type: 'JOB',
        priority: 'FEED',
        action_type: null,
        needs_action: true,
        title: 'All visits finished: ready to complete',
        body: finished + (reason ? '. ' + reason : ''),
      };
    }
    return {
      category: 'JOB',
      object_type: 'JOB',
      priority: 'FEED',
      action_type: null,
      needs_action: false,
      title: finished,
      body: reason || undefined,
    };
  },

  // ── TASK ───────────────────────────────────────────────────────────────────
  // Design §5. `object_label` is the task's TITLE, not its number: a task's number
  // means nothing to the person being told about it, and `task.deleted` outlives its
  // row, so the title is the only thing that can still say WHICH task. `task_number`
  // rides along in the data bag for anyone who wants it.
  //
  // All six are FEED with no `needs_action` / `action_type` — nothing here is an
  // approval, and a shared to-do list that interrupts is a to-do list people mute.

  'task.assigned': (data) => ({
    category: 'TASK',
    object_type: 'TASK',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: 'Assigned to you: ' + s(data, 'object_label', 'a task'),
  }),

  'task.watching': (data) => ({
    category: 'TASK',
    object_type: 'TASK',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: 'You are now watching: ' + s(data, 'object_label', 'a task'),
  }),

  'task.completed': (data) => ({
    category: 'TASK',
    object_type: 'TASK',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: 'Task completed: ' + s(data, 'object_label', 'a task'),
  }),

  // Issue 03. A cancellation is NOT a completion, and must never be told as one: `task.completed`
  // is gated on the flip into DONE and does not fire here. But being silently dropped from work
  // you were assigned is the surprise `task.removed` exists to prevent, so the other assignees
  // and the watchers are told, in words that say the work was abandoned rather than finished.
  'task.cancelled': (data) => ({
    category: 'TASK',
    object_type: 'TASK',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: 'Task cancelled: ' + s(data, 'object_label', 'a task'),
  }),

  'task.removed': (data) => ({
    category: 'TASK',
    object_type: 'TASK',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: 'You were removed from: ' + s(data, 'object_label', 'a task'),
  }),

  // Spec B slice 3. Classified exactly as its six siblings, and for the recorded reason
  // above rather than by copying: a question asked on a shared to-do list is worth telling
  // people about, and is not worth interrupting them for.
  //
  // A DIVERGENCE worth writing down, because it is invisible from either side alone: the
  // task CREATOR is in no task verb's recipient set (resolveRecipients.ts's TASK block
  // routes assignees and watchers only), while `creator` IS one of the audiences task
  // automations offer (services/automations/recipients.ts's AUDIENCES.task). So a creator
  // who is neither assigned nor watching can be emailed about a comment by an automation
  // and will never see a bell for the same comment. That is defensible - the bell is for
  // people the task NAMES, the automation audience is the admin's choice - but it was
  // recorded nowhere until this verb made the two meet on the same event.
  'task.commented': (data) => ({
    category: 'TASK',
    object_type: 'TASK',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: 'New comment on: ' + s(data, 'object_label', 'a task'),
  }),

  // The one verb whose object is already gone by the time anyone reads this. The
  // title is SNAPSHOT into object_label (and repeated in the body) because there is
  // no row left to resolve it from; the deep link dead-ends, which design §5 accepts.
  'task.deleted': (data) => ({
    category: 'TASK',
    object_type: 'TASK',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: 'Task deleted: ' + s(data, 'object_label', 'a task'),
    body: 'This task no longer exists'
      + (s(data, 'task_number') ? ' (' + s(data, 'task_number') + ')' : '') + '.',
  }),

  // ── BILLING ────────────────────────────────────────────────────────────────

  'billing.payment_received': (data) => ({
    category: 'BILLING',
    object_type: 'INVOICE',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: 'Payment received for ' + s(data, 'object_label', 'invoice')
      + (s(data, 'customer_name') ? ' — ' + s(data, 'customer_name') : ''),
    body: withWhy(data, s(data, 'amount') ? 'Amount: $' + s(data, 'amount') : undefined),
  }),

  'billing.partial_payment': (data) => ({
    category: 'BILLING',
    object_type: 'INVOICE',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: 'Partial payment received for ' + s(data, 'object_label', 'invoice')
      + (s(data, 'customer_name') ? ' — ' + s(data, 'customer_name') : ''),
    body: withWhy(data, s(data, 'amount') ? 'Amount: $' + s(data, 'amount') : undefined),
  }),

  'billing.invoice_overdue': (data) => ({
    category: 'BILLING',
    object_type: 'INVOICE',
    priority: 'FEED',
    action_type: 'SEND_REMINDER',
    needs_action: true,
    title: s(data, 'object_label', 'Invoice') + ' is overdue'
      + (s(data, 'customer_name') ? ' — ' + s(data, 'customer_name') : ''),
    body: withWhy(data, s(data, 'amount') ? 'Balance due: $' + s(data, 'amount') : undefined),
  }),

  'billing.invoice_due_soon': (data) => ({
    category: 'BILLING',
    object_type: 'INVOICE',
    priority: 'FEED',
    action_type: 'SEND_REMINDER',
    needs_action: true,
    title: s(data, 'object_label', 'Invoice') + ' is due soon'
      + (s(data, 'customer_name') ? ' — ' + s(data, 'customer_name') : ''),
    body: withWhy(data, s(data, 'amount') ? 'Balance due: $' + s(data, 'amount') : undefined),
  }),

  'billing.refunded': (data) => ({
    category: 'BILLING',
    object_type: 'INVOICE',
    priority: 'INTERRUPT',
    action_type: 'VIEW',
    needs_action: true,
    title: 'Refund issued for ' + s(data, 'object_label', 'invoice')
      + (s(data, 'customer_name') ? ' — ' + s(data, 'customer_name') : ''),
    body: withWhy(data, s(data, 'amount') ? 'Amount: $' + s(data, 'amount') : undefined),
  }),

  'billing.disputed': (data) => ({
    category: 'BILLING',
    // A dispute on money no invoice of this org carries is recorded on the org itself.
    object_type: s(data, 'object_kind') === 'ORGANIZATION' ? 'ORGANIZATION' : 'INVOICE',
    priority: 'INTERRUPT',
    action_type: 'VIEW',
    needs_action: true,
    // Payments go-live slice 09: a bank payment returned after it cleared arrives as a dispute.
    title: (s(data, 'variant') === 'bank_return' ? 'Bank returned the payment for ' : 'Payment disputed for ')
      + s(data, 'object_label', 'invoice')
      + (s(data, 'customer_name') ? ' — ' + s(data, 'customer_name') : ''),
    // Slice 32: what was disputed, why, and by when the owner must answer.
    body: withWhy(data, unrecordedDisputeBody(data, 'open') ?? openedDisputeBody(data)),
  }),

  'billing.chargeback': (data) => ({
    category: 'BILLING',
    object_type: s(data, 'object_kind') === 'ORGANIZATION' ? 'ORGANIZATION' : 'INVOICE',
    priority: 'INTERRUPT',
    action_type: 'VIEW',
    needs_action: true,
    title: (s(data, 'variant') === 'partial_chargeback'
      ? 'Part of a payment charged back for '
      : s(data, 'variant') === 'bank_return' ? 'Bank payment returned for ' : 'Chargeback received for ')
      + s(data, 'object_label', 'invoice')
      + (s(data, 'customer_name') ? ' — ' + s(data, 'customer_name') : ''),
    // Payments go-live slice 09: a lost dispute for less than the payment leaves the payment as
    // recorded, so a person must check the balance.
    body: withWhy(data, unrecordedDisputeBody(data, 'lost') ?? (s(data, 'variant') === 'partial_chargeback'
      ? (s(data, 'amount') ? '$' + s(data, 'amount') + ' was taken back. ' : '')
        + 'The payment was left as recorded and the balance was not changed. Review the balance by hand.'
      : s(data, 'variant') === 'bank_return' ? bankReturnBody(data)
      : s(data, 'amount') ? 'Amount: $' + s(data, 'amount') + ' was taken back from your ServWave Payments balance.' : undefined)),
  }),

  // Payments go-live slice 32: a dispute reached a final answer that cost nothing (the owner won,
  // or it ended without a chargeback). A lost one is billing.chargeback.
  'billing.dispute_closed': (data) => ({
    category: 'BILLING',
    object_type: 'INVOICE',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: (s(data, 'outcome') === 'WON' ? 'Dispute won for ' : 'Dispute closed for ') + s(data, 'object_label', 'invoice')
      + (s(data, 'customer_name') ? ' — ' + s(data, 'customer_name') : ''),
    body: withWhy(data, (s(data, 'amount') ? 'Amount: $' + s(data, 'amount') + '. ' : '')
      + (s(data, 'outcome') === 'WON'
        ? 'It was decided in your favor and the payment stands.'
        : 'It ended without a chargeback.')),
  }),

  // Payments go-live slice 32: a bank payment's three moments. Started and cleared are feed items;
  // a failure interrupts, since the invoice is owed again.
  'billing.bank_payment_started': (data) => ({
    category: 'BILLING',
    object_type: 'INVOICE',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: 'Bank payment started for ' + s(data, 'object_label', 'invoice')
      + (s(data, 'customer_name') ? ' — ' + s(data, 'customer_name') : ''),
    body: withWhy(data, (s(data, 'amount') ? 'Amount: $' + s(data, 'amount') + '. ' : '') + 'It usually takes a few business days to clear.'),
  }),

  'billing.bank_payment_cleared': (data) => ({
    category: 'BILLING',
    object_type: 'INVOICE',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: 'Bank payment cleared for ' + s(data, 'object_label', 'invoice')
      + (s(data, 'customer_name') ? ' — ' + s(data, 'customer_name') : ''),
    body: withWhy(data, s(data, 'amount') ? 'Amount: $' + s(data, 'amount') : undefined),
  }),

  'billing.bank_payment_failed': (data) => ({
    category: 'BILLING',
    object_type: 'INVOICE',
    priority: 'INTERRUPT',
    action_type: 'VIEW',
    needs_action: true,
    title: 'Bank payment failed for ' + s(data, 'object_label', 'invoice')
      + (s(data, 'customer_name') ? ' — ' + s(data, 'customer_name') : ''),
    body: withWhy(data, (s(data, 'amount') ? 'Amount: $' + s(data, 'amount') + '. ' : '')
      + 'No money moved.' + (bankFailedEnding(data) ? ' ' + bankFailedEnding(data) : '')),
  }),

  // Payments go-live slice 32: a refund the processor could not complete.
  'billing.refund_failed': (data) => ({
    category: 'BILLING',
    // A refund of money no invoice of this org carries is recorded on the org itself.
    object_type: s(data, 'object_kind') === 'ORGANIZATION' ? 'ORGANIZATION' : 'INVOICE',
    priority: 'INTERRUPT',
    action_type: 'VIEW',
    needs_action: true,
    title: 'Refund failed for ' + s(data, 'object_label', 'invoice')
      + (s(data, 'customer_name') ? ' — ' + s(data, 'customer_name') : ''),
    body: withWhy(data, (s(data, 'refund_kind') === 'bank' ? 'A bank refund' : 'A refund')
      + (s(data, 'amount') ? ' of $' + s(data, 'amount') : '')
      + ' to ' + s(data, 'customer_name', 'the customer')
      + ' failed. The money is back in your ServWave Payments balance and the customer still needs to be repaid.'),
  }),

  // #2031 slice 5 (F1) — a card capture the system refused to apply. The money exists and nothing
  // in the ledger accounts for it, so this is an INTERRUPT: it needs a person, today.
  'billing.payment_unrecorded': (data) => ({
    category: 'BILLING',
    // Slice 08: money no invoice of this org can carry is recorded on the org itself.
    object_type: s(data, 'object_kind') === 'ORGANIZATION' ? 'ORGANIZATION' : 'INVOICE',
    priority: 'INTERRUPT',
    action_type: 'VIEW',
    needs_action: true,
    title: s(data, 'reason') === 'REFUND_UNMATCHED'
      ? 'A refund could not be matched to a payment'
      : s(data, 'payment_label', 'Card payment') + ' could not be applied to ' + s(data, 'object_label', 'an invoice'),
    body: withWhy(data, s(data, 'reason') === 'OVERPAYMENT'
      ? 'The customer paid more than this invoice was owed. The balance is paid; the rest was not applied. '
        + 'Check the payment against the invoice before replying to the customer.'
      : s(data, 'reason') === 'INVOICE_NOT_PAYABLE'
        ? 'The payment cleared after this invoice was closed for payment, so it was not applied. '
          + 'Check the payment against the invoice before replying to the customer.'
        : s(data, 'reason') === 'INVOICE_NOT_FOUND' || s(data, 'reason') === 'WRONG_ORG'
            ? 'The customer was charged, but the payment does not belong to any invoice in this account, '
              + 'so no payment was recorded. Open Needs attention on the Payments page to send the money back.'
            : s(data, 'reason') === 'REFUND_UNMATCHED'
              ? 'Money was refunded from this account for a payment ServWave has no record of. '
                + 'Contact ServWave support if you did not expect this refund.'
              : s(data, 'reason') === 'DEPOSIT_SUPERSEDED' || s(data, 'reason') === 'DEPOSIT_ON_HOLD'
                ? 'The customer paid a deposit request that is no longer current, so no payment was recorded. '
                  + 'Check the payment against the estimate before replying to the customer.'
                : s(data, 'reason') === 'DOCUMENT_MISMATCH'
                  ? 'The customer was charged, but the payment was made for a different document than this invoice, '
                    + 'so no payment was recorded. Check the payment against the invoice before replying to the customer.'
                  : 'The customer was charged but the amount does not match what this invoice is owed, '
                    + 'so no payment was recorded. Check the payment against the invoice before replying to the customer.'),
  }),

  'billing.voided': (data) => ({
    category: 'BILLING',
    object_type: 'INVOICE',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: s(data, 'object_label', 'Invoice') + ' voided'
      + (s(data, 'customer_name') ? ' — ' + s(data, 'customer_name') : ''),
    body: withWhy(data),
  }),

  'billing.credit_applied': (data) => ({
    category: 'BILLING',
    object_type: 'INVOICE',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: 'Credit applied to ' + s(data, 'object_label', 'invoice')
      + (s(data, 'customer_name') ? ' — ' + s(data, 'customer_name') : ''),
    body: withWhy(data, s(data, 'amount') ? 'Amount: $' + s(data, 'amount') : undefined),
  }),

  // ── BILLING: payments-account lifecycle (Stripe Connect, Task 1.8) ─────────
  // Fired after the account events (services/payment-reconciler) and the status
  // refresh store the account's status (lib/payments-notifications.ts). object_type ORGANIZATION is non-scoped (absent from
  // filterByAccess's SCOPE_TYPE_MAP) so recipients pass through unfiltered.

  'billing.payments_activated': (data) => ({
    category: 'BILLING', object_type: 'ORGANIZATION', priority: 'FEED', action_type: null, needs_action: false,
    title: 'ServWave Payments is active — you can take card payments now.',
    body: withWhy(data),
  }),

  'billing.payouts_activated': (data) => ({
    category: 'BILLING', object_type: 'ORGANIZATION', priority: 'FEED', action_type: null, needs_action: false,
    title: 'Payouts enabled — your bank account is ready.',
    body: withWhy(data),
  }),

  'billing.payments_action_needed': (data) => ({
    category: 'BILLING', object_type: 'ORGANIZATION', priority: 'INTERRUPT', action_type: 'VIEW', needs_action: true,
    title: 'ServWave Payments needs one more thing to keep your payments running.',
    // What to do, in ServWave words (the notice builds it); never the processor's own codes.
    body: withWhy(data, s(data, 'what_to_do') || undefined),
  }),

  'billing.payments_paused': (data) => ({
    category: 'BILLING', object_type: 'ORGANIZATION', priority: 'INTERRUPT', action_type: 'VIEW', needs_action: true,
    title: 'Card payments are paused — ServWave Payments needs more information.',
    body: withWhy(data, s(data, 'reason') || undefined),
  }),

  // Payments go-live slice 10: the payments account was disconnected from ServWave
  // (account.application.deauthorized). No online payment can be taken until it is set up again.
  'billing.payments_disconnected': (data) => ({
    category: 'BILLING', object_type: 'ORGANIZATION', priority: 'INTERRUPT', action_type: 'VIEW', needs_action: true,
    title: 'ServWave Payments is turned off — online payments are off until it is set up again.',
    body: withWhy(data),
  }),

  // ── BILLING: deferred-bank first-payment nudge (Task 1.9, §6.6/§6.8) ──────
  // One-shot FEED item fired from webhook.controller.ts's checkout.session.completed
  // CARD branch the first time a direct-charge org collects a card payment while
  // stripe_payouts_enabled is still false. data.amount arrives pre-formatted
  // (e.g. "$500.00") — interpolated straight into the §6.8 copy, not re-prefixed.
  'billing.payouts_pending_first_payment': (data) => ({
    category: 'BILLING', object_type: 'ORGANIZATION', priority: 'FEED', action_type: null, needs_action: false,
    title: `You've collected ${s(data, 'amount', 'a payment')}. Add your bank account to get paid out.`,
    body: withWhy(data, s(data, 'amount') || undefined),
  }),

  // ── TEAM ───────────────────────────────────────────────────────────────────

  'team.invite_accepted': (data) => ({
    category: 'TEAM',
    object_type: 'USER',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: (s(data, 'actor_name') || 'A new user') + ' accepted their invite',
    body: withWhy(data),
  }),

  // Roles & Permissions, PRD 10 (S10.3). A user mailbox created without an address (the user's first.last was
  // already taken, or the user has no usable name) rings the new user and, once, every active holder of Edit
  // users. Two verbs, because an alert carries one line for everyone on it. In-app only, and nothing names a
  // provider: the mailbox is the company's own.
  'mailbox.address_needed': (_data) => ({
    category: 'TEAM',
    object_type: 'USER',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: "You don't have an email address yet. An admin needs to set one before you can send email.",
  }),

  'mailbox.address_needed_admin': (data) => ({
    category: 'TEAM',
    object_type: 'USER',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: (s(data, 'user_name') || 'A new user') + ' has no email address yet',
    body: 'Their name was already taken by another address in your company. Set a free address for them on the Users page so they can send email.',
  }),

  // ── CALENDAR ENTRY (slice 07, spec §5) ──────────────────────────────────────
  //
  // In-app half of the three-outcome family for USER participants (customer participants get
  // the email trio in lib/email.ts instead — see lib/calendar-entries/notify.ts). No CALENDAR
  // NotificationCategory exists in the schema, and adding one is a migration this slice does
  // not need — TEAM already covers org-visible, non-work coordination notices (see
  // team.invite_accepted above), which is exactly what a calendar
  // entry is. FEED, not INTERRUPT: a Calendar Entry is never a request for action (no
  // assignment, no approval to make), so needs_action stays false for all three.
  //
  // WHICH of the three verbs fires is decided entirely by the caller (lib/calendar-entries/
  // notify.ts) from the start/end diff and each participant's own prior-known state — never a
  // status read, because CalendarEntry has no status column (spec §9 risk 3, issue #1550).

  'calendar_entry.scheduled': (data) => ({
    category: 'TEAM',
    object_type: 'CALENDAR_ENTRY',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: (s(data, 'object_label') || 'Event') + ' was added to your calendar',
  }),

  'calendar_entry.moved': (data) => ({
    category: 'TEAM',
    object_type: 'CALENDAR_ENTRY',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: (s(data, 'object_label') || 'Event') + ' moved'
      + (s(data, 'new_start_label') ? ' to ' + s(data, 'new_start_label') : ''),
  }),

  'calendar_entry.cancelled': (data) => ({
    category: 'TEAM',
    object_type: 'CALENDAR_ENTRY',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: (s(data, 'object_label') || 'Event') + ' was cancelled',
  }),

  // ── INVENTORY ──────────────────────────────────────────────────────────────

  'inventory.stock_approval_requested': (data) => ({
    category: 'INVENTORY',
    object_type: 'STOCK_APPROVAL',
    priority: 'INTERRUPT',
    action_type: 'APPROVE_STOCK',
    needs_action: true,
    title: 'Stock approval requested'
      + (s(data, 'item_name') ? ': ' + s(data, 'item_name') : ''),
    body: withWhy(data, s(data, 'object_label') ? 'Request: ' + s(data, 'object_label') : undefined),
  }),

  'inventory.low_stock': (data) => ({
    category: 'INVENTORY',
    object_type: 'INVENTORY_ITEM',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: 'Low stock' + (s(data, 'item_name') ? ': ' + s(data, 'item_name') : ''),
    // P5: the emit payload carries on_hand/min (numbers) — render them, never
    // fabricate. (No location NAME here: the emitter only has location_id, and
    // enriching it would mean a query inside applyStockMovement's tx.)
    body: withWhy(data, data.on_hand != null && data.min != null
      ? `${data.on_hand} on hand (min ${data.min})`
      : undefined),
  }),

  'inventory.backorder': (data) => ({
    category: 'INVENTORY',
    object_type: 'INVENTORY_ITEM',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: 'Item on backorder' + (s(data, 'item_name') ? ': ' + s(data, 'item_name') : ''),
    body: withWhy(data),
  }),

  'inventory.staging_ready': (data) => ({
    category: 'INVENTORY',
    object_type: 'JOB_STAGE',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: 'Parts staged and ready'
      + (s(data, 'object_label') ? ' for ' + s(data, 'object_label') : ''),
    body: s(data, 'fallback_reason') || (s(data, 'item_name') ? s(data, 'item_name') : undefined),
  }),

  'inventory.staging_no_area': (data) => ({
    category: 'INVENTORY',
    object_type: 'JOB_STAGE',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: 'No staging area for parts'
      + (s(data, 'object_label') ? ' — ' + s(data, 'object_label') : ''),
    body: withWhy(data, s(data, 'item_name') ? s(data, 'item_name') : undefined),
  }),

  'inventory.po_partial': (data) => ({
    category: 'INVENTORY',
    object_type: 'PURCHASE_ORDER',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: 'Partial PO received'
      + (s(data, 'object_label') ? ': ' + s(data, 'object_label') : ''),
    body: withWhy(data, s(data, 'item_name') ? 'Item: ' + s(data, 'item_name') : undefined),
  }),

  // ── LOGISTIC ORDERS (LO-2) ───────────────────────────────────────────────────
  // object_type 'LOGISTIC_ORDER' is a plain String — no enum migration (verb /
  // object_type / action_type are all String on Notification; the INVENTORY
  // category already exists). It is deliberately ABSENT from filterByAccess.ts
  // SCOPE_TYPE_MAP, so LO recipients (approvers + creator — all org-wide LO
  // readers) pass the row-scope filter unfiltered; revisit that if a row-scoped
  // reader (e.g. a technician) ever becomes an LO recipient.

  'lo.submitted': (data) => ({
    category: 'INVENTORY',
    object_type: 'LOGISTIC_ORDER',
    priority: 'INTERRUPT',
    // VIEW reuses the already-registered inline handler (billing.refunded /
    // communication.call_missed precedent) so the pinned needs-action row can
    // be cleared by navigating to the LO — no new frontend wiring required.
    action_type: 'VIEW',
    needs_action: true,
    title: 'Logistic order submitted for approval'
      + (s(data, 'object_label') ? ': ' + s(data, 'object_label') : ''),
    // S07.9: the why line of the Manage roles and permissions holders who cover when nobody can approve it, on its own line.
    body: withWhy(data, s(data, 'actor_name') ? 'Submitted by ' + s(data, 'actor_name') : undefined),
  }),

  'lo.approved': (data) => ({
    category: 'INVENTORY',
    object_type: 'LOGISTIC_ORDER',
    priority: 'INTERRUPT',
    action_type: null,
    needs_action: false,
    title: s(data, 'object_label', 'Logistic order') + ' approved'
      + (s(data, 'actor_name') ? ' by ' + s(data, 'actor_name') : ''),
  }),

  // ── SECURITY ───────────────────────────────────────────────────────────────

  'security.new_signin': (data) => ({
    category: 'SECURITY',
    object_type: 'USER',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: 'New sign-in to your account'
      + (s(data, 'actor_name') ? ' (' + s(data, 'actor_name') + ')' : ''),
  }),

  'security.password_changed': (_data) => ({
    category: 'SECURITY',
    object_type: 'USER',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: 'Your password was changed',
  }),

  'security.mfa_enabled': (_data) => ({
    category: 'SECURITY',
    object_type: 'USER',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: 'Two-factor authentication enabled',
  }),

  'security.mfa_disabled': (_data) => ({
    category: 'SECURITY',
    object_type: 'USER',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: 'Two-factor authentication disabled',
  }),

  // ── COMMUNICATION (CTM phone + SMS) ─────────────────────────────────────────
  // Emitted by lib/ctm/ingest.ts on webhook activities. actorId is always null
  // (webhook-driven). "who" = matched customer/lead label, falling back to the
  // raw caller number (calls) or the object label (sms threads keyed by number).
  // No call_incoming template: inbound rings the cell, not the app (#870).

  'communication.call_missed': (data) => ({
    category: 'COMMUNICATION',
    object_type: 'CALL',
    priority: 'INTERRUPT',
    // VIEW gives the bell a working inline button (billing.refunded precedent)
    // so the pinned needs-action row can be cleared by navigating to the call.
    action_type: 'VIEW',
    needs_action: true,
    title: data.redacted === true
      ? fallbackTitle(s(data, 'call_status') === 'voicemail' ? 'Voicemail' : 'Missed call', data)
      : (s(data, 'call_status') === 'voicemail' ? 'Voicemail — ' : 'Missed call — ') + comWho(data),
    // Only the never-silent fallback carries a body: when, and why they are being told (the reason line, S08.24).
    body: data.redacted === true
      ? withWhy(data, s(data, 'occurred_at') || undefined)
      : withWhy(data, s(data, 'fallback_reason') ? fallbackWhere(data) : undefined),
  }),

  'communication.sms_inbound': (data) => ({
    category: 'COMMUNICATION',
    object_type: 'MESSAGE_THREAD',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    title: data.redacted === true ? fallbackTitle('New text', data) : 'New text — ' + comWho(data),
    // The preview, for whoever may read the conversation; the fallback adds where and when and why. The alert without caller
    // details has none of the preview.
    body: data.redacted === true
      ? withWhy(data, s(data, 'occurred_at') || undefined)
      : withWhy(data, [s(data, 'preview'), s(data, 'fallback_reason') ? fallbackWhere(data) ?? '' : ''].filter(Boolean).join('\n') || undefined),
  }),

  // A customer's reply to an email. FEED at the EVENT level on purpose: resolveRecipients raises it to INTERRUPT for the people the
  // conversation is theirs to answer, and the rest of the record's people are told on the feed. `fallback_reason` is the sentence
  // that says why a person covering for a record with nobody to take the reply was told. `comWho` falls back customer name →
  // object_label (the sender address), which is all an inbound reply with no Customer row behind it leaves us.
  'communication.email_inbound': (data) => ({
    category: 'COMMUNICATION',
    object_type: 'EMAIL_THREAD',
    priority: 'FEED',
    action_type: null,
    needs_action: false,
    // A reply from an address we did not send to (S10.19) is told in PRD 10's words and opens the held message.
    title: data.unmatched_reply === true ? UNMATCHED_REPLY_MESSAGE : 'New email — ' + comWho(data),
    body: withWhy(data, s(data, 'subject') || undefined),
  }),

  // ── AUTOMATION CENTER ───────────────────────────────────────────────────────
  // The Automation Center's only verb, and its only door into the bell. It was
  // the generic verb for the NOTIFY_TEAM step until that step was retired
  // (docs/adr/0005) and the engine's emit() call site went with it, so a
  // workflow RUN no longer reaches this template at all. What still does is the
  // Test dialog's send-to-me receipt (workflow.controller.ts:766) - one
  // synchronous row for the person who clicked Test. Title/body arrive fully
  // rendered from that caller; object_type mirrors the trigger's entity so
  // filterRecipientsByAccess row-scopes on the right resource.
  'automation.message': (data) => ({
    category: 'TEAM',
    object_type: s(data, 'object_type', 'JOB'),
    priority: 'INTERRUPT',
    action_type: null,
    needs_action: false,
    title: s(data, 'title', 'Automation'),
    body: s(data, 'body') || undefined,
  }),
} satisfies Record<string, TemplateFactory>;

// ── verb rules ───────────────────────────────────────────────────────────────

/**
 * Who a notification is for, and why.
 *
 *   involvement - you are attached to the record: assignee, watcher, owner, performer,
 *                 participant, thread holder, the person who raised it.
 *   duty        - acting on it is your job, by role: dispatcher, admin, the rep who
 *                 carries the customer. Nobody had to attach you for you to be told.
 *   self        - it is about your own account, or you asked for it.
 *
 * One family per verb is lossy ON PURPOSE. Several verbs reach an attached person AND
 * role holders (most of billing reaches admins and the customer's rep; `lo.submitted`
 * reaches the approvers while `lo.approved` reaches the submitter). The family names the
 * audience the verb EXISTS to reach; role holders receiving it for awareness alone do not
 * change it. Where that judgement is close the rule carries an `exception` string, so the
 * caveat is recorded rather than lost.
 */
export type NotificationFamily = 'involvement' | 'duty' | 'self';

/**
 * When a notification fires. Orthogonal to family, and deliberately NOT a fourth family:
 * arriving via a sweep changed nothing about WHO was told, so a "reminder" family would be
 * answering a different question from the other three.
 *
 *   event - emitted at a call site. It carries an actor when a signed-in person caused it,
 *           and null when a webhook, a public door or a system detector did. Both are
 *           normal, and the same verb can do both: `estimate.approved` is actor-bearing
 *           from the staff door (estimate.controller.ts:2879, :3458) and actorless from
 *           the Stripe webhook (webhook.controller.ts:660).
 *   time  - emitted by a sweep. Structurally never carries an actor.
 *
 * Rule 0 ("never tell someone about their own action") therefore reads "drop the actor when
 * there is one" - vacuous for every `time` verb and for every actorless `event` path alike,
 * with no branch either way.
 */
export type NotificationTiming = 'event' | 'time';

export interface VerbRule {
  family: NotificationFamily;
  timing: NotificationTiming;
  /**
   * Why this rule deviates from what its family and timing would otherwise lead a reader to
   * expect. A string rather than a boolean, so every deviation states its own justification
   * in source instead of being an unexplained flag. Never an empty string.
   */
  exception?: string;
}

/** Every verb the registry knows: a 61-member literal union, not `string`. */
export type KnownVerb = keyof typeof registry;

/**
 * The classification, declared over the registry's OWN keys. A missing verb and a stray verb
 * are both `tsc -b` failures, so the 62nd registry entry cannot be added without being
 * classified, and a verb cannot be classified without being registered.
 *
 * Twelve `event` verbs have no actor-bearing path at all: every emit site passes null,
 * because the cause is a Stripe/CTM/Resend webhook or a system detector. Each says so in its
 * exception, so the fact is recorded instead of being re-derived from the call sites every
 * time somebody wonders. (Spec A's draft listed eleven and named three verbs that do have an
 * actor-bearing door - `estimate.approved`, `estimate.deposit_paid`, `billing.payment_received`
 * - while missing the four Stripe account-lifecycle verbs. The list below was re-derived from
 * the emit sites.) The two `time` verbs are actorless too, but `timing: 'time'` already says
 * that structurally, so they carry no exception.
 */
export const VERB_RULES: Record<KnownVerb, VerbRule> = {

  // ── LEAD ───────────────────────────────────────────────────────────────────
  // The owner is attached to the lead; an unowned one has nobody attached yet, which is
  // exactly why claiming it falls to whoever holds Assign people to leads (M6's chain, S06.26).
  'lead.assigned': { family: 'involvement', timing: 'event' },
  'lead.unassigned_created': { family: 'duty', timing: 'event' },
  'lead.reassigned_away': { family: 'involvement', timing: 'event' },
  'lead.walkthrough_scheduled': {
    family: 'involvement',
    timing: 'event',
    exception: 'The lead\'s Dispatcher, who must act, and the holders of Alert me about every lead receive this one too, '
      + 'through M6\'s chain (S06.26). The family names the owner and the performers, who are attached to the lead and '
      + 'to the walkthrough.',
  },

  // ── ESTIMATE ───────────────────────────────────────────────────────────────
  // Every estimate verb reaches the commission owner, who is attached to the record, and the rest of M6's chain (S06.26): the
  // record's people, who must act, and the copy holders. Two verbs add a real dispatch duty, noted where they do.
  'estimate.approved': {
    family: 'involvement',
    timing: 'event',
    exception: 'The people who must act (the record\'s Dispatcher, else the Assign people to jobs holders) carry a genuine '
      + 'duty - needs_action = SCHEDULE_JOB. The family names the commission owner, who is the reason the '
      + 'notification exists at all.',
  },
  'estimate.declined': { family: 'involvement', timing: 'event' },
  'estimate.deposit_paid': {
    family: 'involvement',
    timing: 'event',
    exception: 'Same split as estimate.approved: the people who must act carry needs_action '
      + '= SCHEDULE_JOB, and the family names the attached commission owner.',
  },
  'estimate.cancelled': { family: 'involvement', timing: 'event' },
  'estimate.deposit_waived': { family: 'involvement', timing: 'event' },
  'estimate.approval_voided': { family: 'involvement', timing: 'event' },
  'estimate.status_corrected': { family: 'involvement', timing: 'event' },

  // ── DISPATCH ───────────────────────────────────────────────────────────────
  'dispatch.job_assigned': { family: 'involvement', timing: 'event' },
  'dispatch.job_unassigned': { family: 'involvement', timing: 'event' },
  'dispatch.job_rescheduled': { family: 'involvement', timing: 'event' },
  'dispatch.job_created': {
    family: 'duty',
    timing: 'event',
    exception: 'Assignees named at creation time also receive it, through their attachment. '
      + 'The family names dispatch because a job created with nobody on it still has to be '
      + 'placed, and that INTERRUPT is the point of the verb.',
  },

  // ── JOB ────────────────────────────────────────────────────────────────────
  // `duty`, and this is the one classification worth reading twice. The assignees and the
  // selling rep ARE attached and receive it that way, but the constant across all four
  // verbs is the dispatcher, whose board these events exist to keep true. That is the
  // declared difference from `task.*`, which pushes only the people the task itself names:
  // a job carries a dispatch duty, a task does not. The difference is real, and making the
  // two reach the same people would be a product change, not a classification.
  'job.started': { family: 'duty', timing: 'event' },
  'job.completed': {
    family: 'involvement',
    timing: 'event',
    exception: 'Lane 1 is the people attached to the job (stored Sold By, crew, Dispatcher). Lane 2 and the copy are found '
      + 'by switch, never by role name, so the family names the attachment and the fallback people are recorded here.',
  },
  'job.ready_to_close': {
    family: 'involvement',
    timing: 'event',
    exception: 'Lane 1 is the people attached to the job (stored Sold By, crew, Dispatcher). Lane 2 is every Close jobs holder, found '
      + 'by switch and never by role name, so the family names the attachment and the closers are recorded here.',
  },
  'job.review_attention': {
    family: 'involvement',
    timing: 'event',
    exception: 'Lane 1 is the people attached to the job (stored Sold By, crew, Dispatcher). Lane 2 and the copy are found by '
      + 'switch, never by role name, so the family names the attachment and the fallback people are recorded here.',
  },
  'job.cancelled': { family: 'duty', timing: 'event' },
  'job.reopened': { family: 'duty', timing: 'event' },
  'job.visit_finished': {
    family: 'involvement',
    timing: 'event',
    exception: 'Lane 1 is the people attached to the job (Sold By, crew, Dispatcher). Lane 2 and the copy are found by '
      + 'switch, never by role name, so the family names the attachment and the fallback people are recorded here.',
  },

  // ── TASK ───────────────────────────────────────────────────────────────────
  // Pure attachment: assignees, watchers, and the deltas of those two lists. No role is
  // consulted for any task verb, which is what makes the family unambiguous here.
  'task.assigned': { family: 'involvement', timing: 'event' },
  'task.watching': { family: 'involvement', timing: 'event' },
  'task.completed': { family: 'involvement', timing: 'event' },
  'task.cancelled': { family: 'involvement', timing: 'event' },
  'task.removed': { family: 'involvement', timing: 'event' },
  // Spec B slice 3. `involvement` for the same reason as the other six - it reaches the
  // people the task names and consults no role - and `event` because a comment is a moment,
  // not a sweep. Rule 0 applies unmodified, which is what keeps a commenter from being told
  // about their own comment without the emit site knowing anything about it.
  'task.commented': { family: 'involvement', timing: 'event' },
  'task.deleted': { family: 'involvement', timing: 'event' },

  // ── BILLING ────────────────────────────────────────────────────────────────
  // Money is the books' business. Even where the customer's rep is a recipient, they are
  // there because collecting is their job, not because they are attached to the invoice -
  // which is why the two reminders below are `duty` despite also reaching admins.
  'billing.payment_received': { family: 'duty', timing: 'event' },
  'billing.partial_payment': { family: 'duty', timing: 'event' },
  // Spider's sweep (services/spider/sweep.ts) - the third `time` verb.
  'spider.alert': {
    family: 'duty',
    timing: 'time',
    exception: 'The recipients arrive pre-resolved in entity.recipient_ids, by Spider\'s one '
      + 'recipient rule (services/spider/recipients.ts): the roles, users and lead owner an Admin '
      + 'configured, else the Admins. Duty because acting on a stalled lead is the job of whoever '
      + 'the company put on watch, even when the lead owner is among them. ADR 0005 addendum.',
  },
  // Spider's starting summary (services/spider/summary.ts), emitted by the same sweep.
  'spider.starting_summary': {
    family: 'duty',
    timing: 'time',
    exception: 'One per person, emitted as a personal alert: the recipient arrives pre-resolved in '
      + 'entity.recipient_ids, one of the people Spider\'s one recipient rule (services/spider/recipients.ts) '
      + 'returned for the summarized leads - the roles, users and lead owner an Admin configured, else the '
      + 'Admins - already limited to people who can open each lead. Duty, as spider.alert. ADR 0005 addendum.',
  },
  'billing.invoice_overdue': { family: 'duty', timing: 'time' },
  'billing.invoice_due_soon': { family: 'duty', timing: 'time' },
  'billing.refunded': { family: 'duty', timing: 'event' },
  'billing.disputed': {
    family: 'duty',
    timing: 'event',
    exception: 'Its only path is the payment event reconciler (services/payment-reconciler, disputes), '
      + 'which passes a null actor. Rule 0 is vacuous here.',
  },
  'billing.chargeback': {
    family: 'duty',
    timing: 'event',
    exception: 'Its only path is the payment event reconciler (services/payment-reconciler, a lost '
      + 'dispute or bank return), which passes a null actor. Rule 0 is vacuous here.',
  },
  'billing.dispute_closed': {
    family: 'duty',
    timing: 'event',
    exception: 'Its only path is the payment event reconciler (services/payment-reconciler, a dispute that '
      + 'closed without a chargeback), which passes a null actor. Rule 0 is vacuous here.',
  },
  'billing.bank_payment_started': {
    family: 'duty',
    timing: 'event',
    exception: 'Its only path is the payment event reconciler (services/payment-reconciler, a bank payment '
      + 'that started), which passes a null actor. Rule 0 is vacuous here.',
  },
  'billing.bank_payment_cleared': {
    family: 'duty',
    timing: 'event',
    exception: 'Its only path is the payment event reconciler (services/payment-reconciler, a bank payment '
      + 'that cleared), which passes a null actor. Rule 0 is vacuous here.',
  },
  'billing.bank_payment_failed': {
    family: 'duty',
    timing: 'event',
    exception: 'Its only path is the payment event reconciler (services/payment-reconciler, a bank payment '
      + 'that failed), which passes a null actor. Rule 0 is vacuous here.',
  },
  'billing.refund_failed': {
    family: 'duty',
    timing: 'event',
    exception: 'Its only path is the payment event reconciler (services/payment-reconciler, a refund the '
      + 'processor reported as failed), which passes a null actor. Rule 0 is vacuous here.',
  },
  'billing.payment_unrecorded': {
    family: 'duty',
    timing: 'event',
    exception: 'Its paths are the card-capture webhook (webhook.controller.ts) and the ledger\'s '
      + 'settlePayment (lib/payment-ledger.ts), both of which pass a null actor. Rule 0 is vacuous here.',
  },
  'billing.voided': { family: 'duty', timing: 'event' },
  'billing.credit_applied': { family: 'duty', timing: 'event' },
  'billing.payments_activated': {
    family: 'duty',
    timing: 'event',
    exception: 'Its only path is sendAccountNotices (lib/payments-notifications.ts), fed by the payment event '
      + 'reconciler\'s account decision (account.updated and the status refresh), which passes a null actor. '
      + 'Rule 0 is vacuous here.',
  },
  'billing.payouts_activated': {
    family: 'duty',
    timing: 'event',
    exception: 'Its only path is sendAccountNotices (lib/payments-notifications.ts), fed by the payment event '
      + 'reconciler\'s account decision (account.updated and the status refresh), which passes a null actor. '
      + 'Rule 0 is vacuous here.',
  },
  'billing.payments_action_needed': {
    family: 'duty',
    timing: 'event',
    exception: 'Its only path is sendAccountNotices (lib/payments-notifications.ts), fed by the payment event '
      + 'reconciler\'s account decision (account.updated and the status refresh), which passes a null actor. '
      + 'Rule 0 is vacuous here.',
  },
  'billing.payments_paused': {
    family: 'duty',
    timing: 'event',
    exception: 'Its only path is sendAccountNotices (lib/payments-notifications.ts), fed by the payment event '
      + 'reconciler\'s account decision (account.updated and the status refresh), which passes a null actor. '
      + 'Rule 0 is vacuous here.',
  },
  'billing.payments_disconnected': {
    family: 'duty',
    timing: 'event',
    exception: 'Its only path is sendAccountNotices (lib/payments-notifications.ts) off the processor\'s '
      + 'account.application.deauthorized, which passes a null actor. Rule 0 is vacuous here.',
  },
  'billing.payouts_pending_first_payment': {
    family: 'duty',
    timing: 'event',
    exception: 'Its only path is the payment webhook (webhook.controller.ts:609), '
      + 'which passes a null actor. Rule 0 is vacuous here.',
  },

  // ── TEAM ───────────────────────────────────────────────────────────────────
  'team.invite_accepted': { family: 'duty', timing: 'event' },
  'mailbox.address_needed': {
    family: 'self',
    timing: 'event',
    exception: 'About the new user\'s own account: the one recipient arrives pre-resolved in entity.recipient_ids. The '
      + 'mailbox is created by the system (the invite or create that made the user), so the alert carries no actor.',
  },
  'mailbox.address_needed_admin': {
    family: 'duty',
    timing: 'event',
    exception: 'The recipients are the active holders of Edit users, found by the switch-holder lookup (never a role '
      + 'name) and handed over in entity.recipient_ids. The alert carries no actor: the person who created the user '
      + 'did not know the name was taken, so they are told too.',
  },

  // ── CALENDAR ENTRY ─────────────────────────────────────────────────────────
  // Participants only, never a role: an event concerns the people attached to it.
  'calendar_entry.scheduled': { family: 'involvement', timing: 'event' },
  'calendar_entry.moved': { family: 'involvement', timing: 'event' },
  'calendar_entry.cancelled': { family: 'involvement', timing: 'event' },

  // ── INVENTORY ──────────────────────────────────────────────────────────────
  // Stock is the stockroom's to keep straight, so every inventory verb is a role's job.
  'inventory.stock_approval_requested': { family: 'duty', timing: 'event' },
  'inventory.low_stock': {
    family: 'duty',
    timing: 'event',
    exception: 'Its only path is the system detector in inventoryEmit.ts:76, which passes a '
      + 'null actor because a stock level crossing its minimum is nobody\'s action. Rule 0 '
      + 'is vacuous here.',
  },
  'inventory.backorder': { family: 'duty', timing: 'event' },
  'inventory.staging_ready': {
    family: 'duty',
    timing: 'event',
    exception: 'The assigned tech gets the INTERRUPT because the pickup is theirs, which is '
      + 'an attachment. The family names admins and dispatch, who receive it whether or not '
      + 'anyone is assigned.',
  },
  'inventory.staging_no_area': { family: 'duty', timing: 'event' },
  'inventory.po_partial': { family: 'duty', timing: 'event' },

  // ── LOGISTIC ORDERS ────────────────────────────────────────────────────────
  // The two halves split cleanly: approving is a granted job, being told your own order
  // cleared is an attachment.
  'lo.submitted': { family: 'duty', timing: 'event' },
  'lo.approved': { family: 'involvement', timing: 'event' },

  // ── SECURITY ───────────────────────────────────────────────────────────────
  // The one named exception to Rule 0, and the reason it is a mechanism rather than a
  // convention: the resolver reads `self` and skips the actor drop. Until now these alerts
  // reached their owner only because all five emit sites happen to hardcode actorId null.
  'security.new_signin': {
    family: 'self',
    timing: 'event',
    exception: 'Rule 0 must not drop this recipient. The sign-in an attacker made while '
      + 'holding your session is precisely the one you still have to see, so the alert '
      + 'cannot be silenced by the session that triggered it.',
  },
  'security.password_changed': {
    family: 'self',
    timing: 'event',
    exception: 'Rule 0 must not drop this recipient. A password changed by somebody else on '
      + 'your account looks exactly like a password you changed yourself, and only you can '
      + 'tell the difference.',
  },
  'security.mfa_enabled': {
    family: 'self',
    timing: 'event',
    exception: 'Rule 0 must not drop this recipient. An MFA factor added to your account is '
      + 'yours to recognise or dispute, whoever appears to have added it.',
  },
  'security.mfa_disabled': {
    family: 'self',
    timing: 'event',
    exception: 'Rule 0 must not drop this recipient. MFA being turned off is the single '
      + 'alert an attacker most wants suppressed, so it must survive appearing self-inflicted.',
  },

  // ── COMMUNICATION ──────────────────────────────────────────────────────────
  'communication.call_missed': {
    family: 'duty',
    timing: 'event',
    exception: 'Its only path is the CTM call webhook (lib/ctm/ingest.ts:737), which passes '
      + 'a null actor - a caller is not a user of ours. Rule 0 is vacuous here.',
  },
  'communication.sms_inbound': {
    family: 'duty',
    timing: 'event',
    exception: 'Its only path is the CTM message webhook (lib/ctm/ingest.ts:968), which '
      + 'passes a null actor - a texter is not a user of ours. Rule 0 is vacuous here.',
  },
  'communication.email_inbound': {
    family: 'involvement',
    timing: 'event',
    exception: 'Its only path is the inbound email webhook (emailReplyAlerts.ts via resend-webhook.controller.ts), which passes a '
      + 'null actor. The family names the people the reply is theirs to answer (the sender, the record\'s people); when none of '
      + 'them can take it the covering people are a duty audience told why, and nobody is addressed by a role.',
  },

  // ── AUTOMATION CENTER ──────────────────────────────────────────────────────
  'automation.message': {
    family: 'self',
    timing: 'event',
    exception: 'Not involvement (nothing is attached) and not duty (no role is consulted): '
      + 'the recipients arrive pre-resolved in entity.recipient_ids. `self` because its one '
      + 'and only emit site is the Test dialog (workflow.controller.ts:766), whose sole '
      + 'recipient is the person who clicked Test and therefore asked for the receipt - the '
      + 'same shape as security.*, where the recipient must be told regardless of who appears '
      + 'to have acted. That single door is the whole of the Automation Center in the bell '
      + 'since the in-app step was retired; ADR 0005 is where that ownership is decided, not '
      + 'this map. It passes a null actor, so `self` costs nothing at runtime today.',
  },
};

// The other half of the exhaustiveness guarantee, demonstrated rather than described: a key
// that is NOT a registered verb does not compile either. `task.due_soon` is deliberately
// unregistered (it needs a cron that does not exist), so there is nothing for it to classify.
// Delete the suppression and `tsc -b` reports the excess property; delete the bogus key and
// the suppression itself becomes the error.
const _strayVerbIsACompileError: Partial<Record<KnownVerb, VerbRule>> = {
  // @ts-expect-error - 'task.due_soon' is not in the registry, so it is not a KnownVerb.
  'task.due_soon': { family: 'involvement', timing: 'time' },
};
void _strayVerbIsACompileError;

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Render a notification template for the given verb + data bag.
 * Throws if the verb is unknown or deferred — the caller should log and skip.
 */
export function renderTemplate(verb: string, data: Record<string, any>): RenderedTemplate {
  // The guard narrows `verb` to KnownVerb so the registry can be indexed now that its keys
  // are literals rather than an index signature. Behaviour is unchanged: every registry
  // value is a function, so the old `!factory` test only ever caught an absent key.
  if (!isKnownVerb(verb)) {
    throw new Error(`Unknown or deferred notification verb: "${verb}"`);
  }
  return registry[verb](data);
}

/**
 * Returns true if verb is registered (v1 verbs only).
 *
 * A type guard rather than a plain boolean, so a caller holding a `string` can narrow it to
 * `KnownVerb` and index VERB_RULES. Backwards compatible: every existing
 * `expect(isKnownVerb(x)).toBe(...)` assertion still reads the same value.
 */
export function isKnownVerb(verb: string): verb is KnownVerb {
  return verb in registry;
}

/**
 * The family/timing rule for a verb, or undefined for an unregistered one.
 *
 * This is the accessor the bell's resolver uses, and the reason `renderTemplate`,
 * `EmitArgs.verb` and `ResolveContext.verb` all stay `string`: six call sites build the verb
 * dynamically (lib/calendar-entries/notify.ts:250, invoiceDueCron.ts:65, task.controller.ts:115,
 * webhook.controller.ts:229, estimate.controller.ts:3306, invoice.controller.ts:2275), so
 * narrowing the parameter would turn a one-line change into a cross-controller refactor.
 */
export function ruleForVerb(verb: string): VerbRule | undefined {
  return isKnownVerb(verb) ? VERB_RULES[verb] : undefined;
}
