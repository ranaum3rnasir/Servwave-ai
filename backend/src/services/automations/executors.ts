/**
 * executors.ts — dispatch one automation action to its channel.
 *
 * The engine hands over a fully-loaded ExecutionBundle (entity refs, customer,
 * assignees, merge context); this module renders the copy and routes it:
 *   SEND_EMAIL  → lib/email sendAutomationEmail (Resend, branded, esc()-safe)
 *   SEND_SMS    → smsRecord (Communication-module thread; provider-pending)
 *
 * There is no in-app action. The bell is hardcoded and the Automation Center owns
 * email and text (docs/adr/0005) - a run cannot notify in-app. The engine skips a
 * published-but-retired in-app step before it ever reaches this module.
 *
 * Every outcome is an ExecutionResult with a plain-English detail — SKIPPED
 * reasons are product copy, not log lines (they render in the Activity tab).
 * Throwing is allowed; the engine maps a throw to a FAILED run.
 */

import { AutomationActionType } from '@prisma/client';
import { sendAutomationEmail, esc, type EmailDispatchResult } from '../../lib/email';
import type { AutomationEntity } from './automationEntity';
import { renderMergeFields } from './renderMergeFields';
import { fallbacksFor } from './mergeFieldFallbacks';
import { recordOutboundSms, type OutboundSmsCounterparty } from './smsRecord';
import type { CtmSmsFailureReason, CtmSmsSendResult } from '../../lib/ctm/sendSms';
import {
  audienceLabel,
  resolveAudience,
  type AudienceContext,
  type RecipientKey,
  type ResolvedAudience,
} from './recipients';

export interface RecipientUser {
  id: string;
  email: string | null;
  first_name: string;
  last_name: string | null;
  /**
   * Spec C: the person's own mobile number, for the SEND_SMS audiences.
   *
   * REQUIRED, not optional, and deliberately so: every construction site of this shape -
   * the typed Prisma selects, the hand-built dispatch payloads, and the two crew/performer
   * projections they drag in through EventPayload.recipient - is a compile error until it
   * selects the column. An optional field would have made this a manual hunt whose failure
   * mode is a silent "nobody has a phone".
   *
   * Null is a legitimate value and NOT a skip on its own: the resolver still returns a
   * person with no number and no skip reason, and the executor is the single place that
   * decides what to do about it (see sendSmsAction). Email steps ignore it entirely.
   */
  phone: string | null;
}

export interface ExecutionBundle {
  /** Typed by the ONE named entity union (automationEntity.ts), never a hand-written copy. */
  entityRef: { type: AutomationEntity; id: string; label?: string | null };
  organizationId: string;
  org: { name: string; timezone: string; logo_url?: string | null; brand_color?: string };
  customer?: {
    id: string;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    phone: string | null;
    /**
     * Secondary addresses opted in to automated mail, pre-filtered by context.ts's
     * CUSTOMER_INCLUDE (`receives_emails: true`). The `customer` audience mails these
     * alongside the primary — see recipients.ts.
     */
    extra_emails?: { email: string }[];
  } | null;
  /** Job crew (empty for non-job entities); for leads, the walkthrough performers;
   *  for tasks, the people the work is assigned to. */
  assignees: RecipientUser[];
  /**
   * Task watchers - the people FOLLOWING the record rather than doing it. Structurally
   * empty for the other four entities, which have no notion of following one.
   *
   * REQUIRED, not optional, and defaulted once in context.ts's shared `base`: an optional
   * field would let a future loader arm silently resolve the `watchers` audience to nobody
   * while every resolver-level test stayed green - the trap `extra_emails` and `actorId`
   * are each commented for below.
   */
  watchers: RecipientUser[];
  /** Job dispatcher (job only — jobs.dispatcher_id). */
  dispatcher?: RecipientUser | null;
  /** Prefers the entity's own salesperson (job.salesperson_id); falls back to the
   *  linked lead's commission owner (job → estimate → lead, or estimate → lead directly).
   *  Invoices don't resolve one (dropped per Ran — no direct lead path). */
  salesperson?: RecipientUser | null;
  /** Estimate creator (estimate.created_by; estimate only). */
  creator?: RecipientUser | null;
  /** The person the triggering event removed — from event_payload, not the live entity (context.ts). */
  eventRecipient?: RecipientUser | null;
  /**
   * Rule 0: the person whose request caused this run. Rides event_payload (not
   * memory) so it survives a WAIT of any length, and is dropped from every
   * resolved audience by recipients.ts. Null for the actorless paths - the cron
   * sweeps, the Stripe webhook, the public doors.
   */
  actorId?: string | null;
  /** Fully-resolved merge-field values for this entity. */
  mergeCtx: Record<string, string>;
  /** Job reference for SMS/email inbox attribution, when the entity has one. */
  jobRef?: { id: string; label: string | null } | null;
  /** The run's dedupe key — mirrored into the notification dedup key. */
  dedupeKey: string;
}

/**
 * What happened to ONE audience of a send step. The step-level status (below) is derived
 * from these exactly as before: any sent audience means the step is SENT. What this adds
 * is the answer to "was the CUSTOMER reached?", which one status per step cannot give.
 */
// A type alias, not an interface, on purpose: the engine writes the list straight into a
// Json column, and Prisma's InputJsonValue wants an index signature an interface never has.
export type AudienceOutcome = {
  /** The configured audience key, as stored on the step. */
  audience: RecipientKey;
  /** Plain-English name for that audience on THIS entity (audienceLabel). */
  label: string;
  outcome: 'sent' | 'skipped' | 'failed';
  /** One short line an admin reads: who was reached, or why nobody was. */
  summary: string;
};

export interface ExecutionResult {
  status: 'SENT' | 'SKIPPED' | 'FAILED';
  recipientSummary?: string;
  detail?: string;
  /** One row per resolved audience, in configured order. Empty for actions that have no audiences. */
  audienceOutcomes?: AudienceOutcome[];
}

/** A messaging action's config, normalized to the v2.1 multi-select shape. */
interface NormalizedConfig {
  recipients: RecipientKey[];
  subject?: string;
  body: string;
  custom_emails: string[];
  user_ids: string[];
  /** "If empty, fill with" per merge field; the seeded defaults for a config stored without one. */
  fallbacks: Record<string, string>;
}

interface RuleLike {
  id: string;
  name: string;
  action_type: AutomationActionType;
  action_config: unknown;
  organization_id: string;
}

/**
 * Read the stored config into the canonical multi-select shape. Back-compat is
 * mandatory: legacy singular configs (`recipient`/`custom_email`/`user_id`) are
 * folded to their array forms, and the legacy `assigned_techs` key is folded to
 * `assigned_team` (the resolver honors the alias too, but folding here keeps the
 * whole executor on canonical keys).
 */
function normalizeActionConfig(raw: unknown): NormalizedConfig {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const recipientsRaw = Array.isArray(c.recipients)
    ? c.recipients
    : c.recipient != null
      ? [c.recipient]
      : [];
  const recipients = recipientsRaw
    .filter((r): r is string => typeof r === 'string')
    .map((r) => (r === 'assigned_techs' ? 'assigned_team' : r)) as RecipientKey[];

  const customEmailsRaw = Array.isArray(c.custom_emails)
    ? c.custom_emails
    : c.custom_email != null
      ? [c.custom_email]
      : [];
  const userIdsRaw = Array.isArray(c.user_ids) ? c.user_ids : c.user_id != null ? [c.user_id] : [];

  return {
    recipients,
    subject: typeof c.subject === 'string' ? c.subject : undefined,
    body: typeof c.body === 'string' ? c.body : '',
    custom_emails: customEmailsRaw.filter((e): e is string => typeof e === 'string' && e.trim().length > 0),
    user_ids: userIdsRaw.filter((u): u is string => typeof u === 'string' && u.trim().length > 0),
    fallbacks: fallbacksFor(c),
  };
}

export async function executeAction(rule: RuleLike, bundle: ExecutionBundle): Promise<ExecutionResult> {
  const config = normalizeActionConfig(rule.action_config);
  switch (rule.action_type) {
    case 'SEND_EMAIL':
      return sendEmailAction(config, bundle);
    case 'SEND_SMS':
      return sendSmsAction(config, bundle);
    default:
      // Includes the retired in-app action: a legacy rule naming it is skipped, never
      // sent. The engine intercepts a retired STEP earlier, with copy an admin reads.
      return { status: 'SKIPPED', detail: `Unknown action type ${rule.action_type}` };
  }
}

// ── recipient resolution (Task 17 audience resolver) ───────────────────────────

/** Build the resolver context once from the execution bundle. */
function audienceContext(config: NormalizedConfig, bundle: ExecutionBundle): AudienceContext {
  return {
    organizationId: bundle.organizationId,
    entity: bundle.entityRef.type,
    customer: bundle.customer
      ? {
          id: bundle.customer.id,
          email: bundle.customer.email,
          // Carry the opted-in extras through; this rebuild is field-by-field, so
          // omitting them here would silently reduce the audience to the primary.
          extra_emails: bundle.customer.extra_emails ?? [],
        }
      : null,
    assignees: bundle.assignees,
    watchers: bundle.watchers,
    dispatcher: bundle.dispatcher ?? null,
    salesperson: bundle.salesperson ?? null,
    creator: bundle.creator ?? null,
    eventRecipient: bundle.eventRecipient ?? null,
    // Rule 0. This rebuild is field-by-field, so omitting the actor here would
    // silently keep emailing the person who acted while every resolver-level
    // test stayed green - see the extra_emails comment above, same trap.
    actorId: bundle.actorId ?? null,
    customEmails: config.custom_emails,
  };
}

/**
 * Resolve EVERY selected audience to its concrete users/emails. `specific_user`
 * expands to one resolver call per chosen id (so a multi-select of two people
 * resolves both); every other key resolves once. Never throws — an unresolvable
 * audience returns a plain-English `skipReason` (product copy) instead.
 */
async function resolveAll(config: NormalizedConfig, ctx: AudienceContext): Promise<KeyedAudience[]> {
  const out: KeyedAudience[] = [];
  for (const key of config.recipients) {
    if (key === 'specific_user') {
      if (config.user_ids.length === 0) {
        out.push({ key, ...(await resolveAudience('specific_user', ctx)) });
      } else {
        for (const userId of config.user_ids) {
          out.push({ key, ...(await resolveAudience('specific_user', { ...ctx, userId })) });
        }
      }
    } else {
      out.push({ key, ...(await resolveAudience(key, ctx)) });
    }
  }
  return out;
}

/** A resolved audience that still remembers which configured key it answers for. */
type KeyedAudience = ResolvedAudience & { key: RecipientKey };

/** "Sent to a@x.com, Ann Lee": the reached-list phrasing shared by both channels. */
function sentSummary(reached: string[]): string {
  return `Sent to ${reached.join(', ')}`;
}

/** Distinct, order-preserving skip reasons across the resolved audiences. */
function skipReasons(resolved: ResolvedAudience[]): string[] {
  return [...new Set(resolved.map((r) => r.skipReason).filter((s): s is string => Boolean(s)))];
}

/**
 * Plain body → branded-shell HTML fragment. The body is authored as plain text
 * (a <textarea>) and merge values are customer-controlled, so escape the WHOLE
 * rendered string — not just the substituted values — then re-introduce only
 * our own <br> line breaks. Mirrors lib/email.ts customMessageBlock.
 */
function toHtmlFragment(body: string, ctx: Record<string, string>, fallbacks: Record<string, string>): string {
  const rendered = renderMergeFields(body, ctx, { html: false, fallbacks });
  return `<p style="margin:0 0 16px;">${esc(rendered).replace(/\n/g, '<br>')}</p>`;
}

// ── SEND_EMAIL ────────────────────────────────────────────────────────────────

async function sendEmailAction(config: NormalizedConfig, bundle: ExecutionBundle): Promise<ExecutionResult> {
  const ctx = audienceContext(config, bundle);
  const resolved = await resolveAll(config, ctx);
  const customerEmail = bundle.customer?.email?.toLowerCase();

  // Union of every resolved address: the explicit `emails` (customer/custom) plus
  // each resolved user's own email. Dedupe case-insensitively, first-seen casing.
  // The map carries the address ALONE: no copy of this send differs from another
  // by so much as a word any more, since the one merge field that named the
  // person being written to was removed (see `BASE` in catalog.ts). The loop
  // below is still per-address, because the ADDRESSING is per-address - one
  // message, one recipient, one attribution - not because the text varies.
  const byAddress = new Map<string, string>();
  for (const r of resolved) {
    for (const email of r.emails) {
      const k = email.toLowerCase();
      if (!byAddress.has(k)) byAddress.set(k, email);
    }
    for (const u of r.users) {
      if (!u.email) continue;
      const k = u.email.toLowerCase();
      if (!byAddress.has(k)) byAddress.set(k, u.email);
    }
  }

  const recipients = [...byAddress.values()];
  const reasons = skipReasons(resolved);
  if (recipients.length === 0) {
    // Never email nobody: SKIPPED, with the plain-English reasons joined. Each
    // audience still gets its own row, so "the customer was not told" is on record.
    return {
      status: 'SKIPPED',
      detail: reasons.join(' · ') || 'No one to email',
      audienceOutcomes: emailAudienceOutcomes(resolved, [], bundle.entityRef.type),
    };
  }

  const dispatched: { address: string; result: EmailDispatchResult }[] = [];
  for (const to of recipients) {
    const result = await sendAutomationEmail({
      organizationId: bundle.organizationId,
      to,
      subject: renderMergeFields(config.subject ?? '', bundle.mergeCtx, { html: false, fallbacks: config.fallbacks }),
      text: renderMergeFields(config.body, bundle.mergeCtx, { html: false, fallbacks: config.fallbacks }),
      html: toHtmlFragment(config.body, bundle.mergeCtx, config.fallbacks),
      org: {
        id: bundle.organizationId,
        name: bundle.org.name,
        logo_url: bundle.org.logo_url ?? null,
        brand_color: bundle.org.brand_color ?? '#0C2D3A',
      },
      record: {
        organizationId: bundle.organizationId,
        // Attribute the send to the customer only for the customer's own address.
        customerId: customerEmail && to.toLowerCase() === customerEmail ? bundle.customer?.id ?? null : null,
        jobId: bundle.jobRef?.id ?? null,
        jobLabel: bundle.jobRef?.label ?? null,
      },
    });
    dispatched.push({ address: to, result });
  }

  const dispatchReasons = [...new Set(dispatched.map(emailDispatchProblem).filter((p): p is string => p !== null))];
  const allReasons = [...reasons, ...dispatchReasons];

  const sent = dispatched.filter((d) => d.result.status === 'sent');
  const audienceOutcomes = emailAudienceOutcomes(resolved, dispatched, bundle.entityRef.type);
  if (sent.length > 0) {
    // The same subject every address received: nothing in a rendered send varies
    // by recipient any more, so this is a re-render of the identical string
    // rather than a separate, blanked one.
    const summarySubject = renderMergeFields(
      config.subject ?? '',
      bundle.mergeCtx,
      { html: false, fallbacks: config.fallbacks },
    );
    return {
      status: 'SENT',
      recipientSummary: recipients.join(', '),
      detail: allReasons.length
        ? `Sent to ${sent.length} · skipped: ${allReasons.join('; ')}`
        : summarySubject,
      audienceOutcomes,
    };
  }

  const allSkipped = dispatched.every((d) => d.result.status === 'skipped');
  return {
    status: allSkipped ? 'SKIPPED' : 'FAILED',
    detail: allReasons.join(' · '),
    audienceOutcomes,
  };
}

/** One address's dispatch result, as the plain-English problem it reports (null when it went). */
type EmailDispatch = { address: string; result: EmailDispatchResult };

// dispatchEmail's org-level checks (org_disabled / no_api_key) read the same
// org row on every call in a step's loop, so they are always all-or-nothing across
// recipients; only a provider rejection can vary per address. See
// md_files/plans/automations/2026-07-30-task-112-step-run-send-honesty.md.
function emailDispatchProblem({ address, result }: EmailDispatch): string | null {
  switch (result.status) {
    case 'sent':
      return null;
    case 'skipped':
      return result.reason === 'org_disabled'
        ? 'Email sending is turned off for this organization'
        : 'Email sending is not available right now';
    case 'failed':
      return `delivery to ${address} failed: ${result.error}`;
  }
}

/**
 * Fold the per-address dispatch results back onto the audiences they came from. An
 * address named by two audiences (the customer who is also the salesperson) was mailed
 * once, and both audiences read that one result - which is the truth of what reached them.
 */
function emailAudienceOutcomes(
  resolved: KeyedAudience[],
  dispatched: EmailDispatch[],
  entity: AutomationEntity,
): AudienceOutcome[] {
  const byAddress = new Map(dispatched.map((d) => [d.address.toLowerCase(), d]));
  return resolved.map((r) => {
    const base = { audience: r.key, label: audienceLabel(r.key, entity) };
    if (r.skipReason) return { ...base, outcome: 'skipped', summary: r.skipReason };
    const own = [...r.emails, ...r.users.map((u) => u.email).filter((e): e is string => Boolean(e))]
      .map((a) => byAddress.get(a.toLowerCase()))
      .filter((d): d is EmailDispatch => d !== undefined);
    const sent = own.filter((d) => d.result.status === 'sent');
    if (sent.length > 0) return { ...base, outcome: 'sent', summary: sentSummary(sent.map((d) => d.address)) };
    const problems = [...new Set(own.map(emailDispatchProblem).filter((p): p is string => p !== null))];
    // Same split as the step status: a provider rejection is a failure, a gate is a skip.
    const outcome = own.some((d) => d.result.status === 'failed') ? 'failed' : 'skipped';
    return { ...base, outcome, summary: problems.join(' · ') || 'No one to email' };
  });
}

// ── SEND_SMS ──────────────────────────────────────────────────────────────────
// The audience half mirrors sendEmailAction above, step for step (build the context,
// resolve every configured audience, dedupe, collect distinct skip reasons, compose
// ONE result) - the resolver helpers are channel-agnostic and shared verbatim. What
// differs is the destination (a phone number, not an address), the counterparty a
// message row is filed under, and that a step status must reflect whether the text
// actually left the building (SERV10X-70, same defect class as #1068 for email).

// Gate-failure reasons a delivery attempt can come back with, mapped to plain-
// English Activity-tab copy. CTM_ERROR is handled separately as FAILED.
const SMS_SKIP_COPY: Record<Exclude<CtmSmsFailureReason, 'CTM_ERROR'>, string> = {
  NOT_CONNECTED: 'Text messaging is not connected for this organization',
  SMS_NOT_READY: 'Text messaging is not active yet — A2P registration is pending approval',
  ORG_SMS_DISABLED: 'Text messaging is turned off for this organization',
  NOT_ENTITLED: 'Text messaging is not available on this plan',
  NO_SMS_NUMBER: 'No SMS-capable phone number is available for this conversation',
  NOT_IN_TEST_ALLOWLIST: 'This number is not reachable in the current environment',
  RECIPIENT_OPTED_OUT: 'This recipient has opted out of text messages',
  DUPLICATE_SEND: 'An identical text was just sent to this conversation',
};

/** "Ann Lee", or just "Ann" when the row carries no surname. */
function fullName(u: RecipientUser): string {
  return [u.first_name, u.last_name].filter(Boolean).join(' ');
}

/** One addressed handset: what to call them, and where to file the record. */
interface TextTarget {
  /** 'customer', or `user:<id>`: how a delivery is matched back to the audiences that named it. */
  key: string;
  /** For the Activity-tab summary: NAMES for staff, the number for the customer (unchanged). */
  summary: string;
  /**
   * What a provider rejection is allowed to SAY about this handset in run history.
   * Staff are named, because in a fan-out "text delivery failed" alone does not say which
   * handset was lost. The customer branch keeps the number-free string it has always
   * written: the Activity feed is readable by anyone with read access to Automations, and
   * a customer mobile number does not belong there any more than a staff one does - the
   * same reason the staff summary is names and not numbers.
   */
  failureDetail: string;
  /** How the recorder files the row - the discriminated counterparty. */
  to: OutboundSmsCounterparty;
}

async function sendSmsAction(config: NormalizedConfig, bundle: ExecutionBundle): Promise<ExecutionResult> {
  const ctx = audienceContext(config, bundle);

  // `customer` is handled as a bespoke branch BELOW, and is deliberately kept out of the
  // resolver pass. Two reasons, both load-bearing:
  //   * the resolver's customer/custom arms speak about EMAIL ("The customer has no email
  //     address on file", "No email address was configured"), and that copy must never
  //     surface on a text step; and
  //   * the two customer conditions must NOT be early returns. Returning here is what made
  //     a text step addressed only to the assigned crew abort on a record with no customer.
  //     They contribute a collected reason instead, and the run reaches the staff.
  // `custom` is a bare email address with no handset behind it; publish-time validation
  // already refuses it on a text step, so it is dropped rather than given copy nobody
  // can reach.
  const resolverKeys = config.recipients.filter((k) => k !== 'customer' && k !== 'custom');
  const resolved = await resolveAll({ ...config, recipients: resolverKeys }, ctx);
  const reasons = skipReasons(resolved);

  const targets: TextTarget[] = [];
  const seen = new Set<string>();

  // The customer as a keyed audience of its own, so the per-audience ledger can place it in
  // configured order beside the resolver's staff audiences. Its skip reason (if any) is the
  // same string pushed onto `reasons` just below.
  let customerAudience: KeyedAudience | null = null;
  if (config.recipients.includes('customer')) {
    // Both strings verbatim - they are the two pre-delivery skips the customer path has
    // always reported, and an admin reads them in the Activity tab.
    if (!bundle.customer) {
      reasons.push('This record has no customer to text');
      customerAudience = { key: 'customer', users: [], emails: [], skipReason: 'This record has no customer to text' };
    } else if (!bundle.customer.phone) {
      reasons.push('Customer has no phone number on file');
      customerAudience = { key: 'customer', users: [], emails: [], skipReason: 'Customer has no phone number on file' };
    } else {
      customerAudience = { key: 'customer', users: [], emails: [] };
      targets.push({
        key: 'customer',
        // The customer summary stays the phone number it has always been.
        summary: bundle.customer.phone,
        // Verbatim, and deliberately number-free: what a failed customer text has always read.
        failureDetail: 'Text delivery failed',
        to: { type: 'customer', customerId: bundle.customer.id, job: bundle.jobRef ?? null },
      });
    }
  }

  for (const r of resolved) {
    for (const u of r.users) {
      const key = `user:${u.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!u.phone) {
        // NOT a short-circuit: the person is named, the reason is collected, and the loop
        // carries on to everyone else the step is addressed to.
        reasons.push(`No phone number on file for ${fullName(u)}`);
        continue;
      }
      targets.push({
        key,
        summary: fullName(u),
        failureDetail: `Text delivery to ${fullName(u)} failed`,
        to: { type: 'user', userId: u.id, name: fullName(u), toE164: u.phone },
      });
    }
  }

  // Configured order, the customer included where the admin placed it; `custom` is dropped
  // above and has no row here either.
  const audiences: KeyedAudience[] = [];
  let staffCursor = 0;
  for (const key of config.recipients) {
    if (key === 'customer') {
      if (customerAudience) audiences.push(customerAudience);
    } else if (key !== 'custom') {
      // resolveAll expands specific_user to one entry per chosen id and every other key
      // to exactly one, in configured order, so the staff entries can be walked in step.
      const count = key === 'specific_user' ? Math.max(config.user_ids.length, 1) : 1;
      audiences.push(...resolved.slice(staffCursor, staffCursor + count));
      staffCursor += count;
    }
  }

  if (targets.length === 0) {
    // Never text nobody: SKIPPED, with the plain-English reasons joined. A skipped step
    // does not halt the run - the engine advances the cursor unconditionally, so the
    // requirement here is simply not to throw.
    return {
      status: 'SKIPPED',
      detail: [...new Set(reasons)].join(' · ') || 'No one to text',
      audienceOutcomes: textAudienceOutcomes(audiences, [], bundle.entityRef.type),
    };
  }

  const dispatched: TextDispatch[] = [];
  for (const target of targets) {
    // Rendered inside the loop though every handset now receives the SAME string: the one
    // merge field whose value differed per recipient was removed on 2026-09-15 (see `BASE`
    // in catalog.ts). Kept here rather than hoisted because the loop is a DISPATCH loop -
    // one delivery row, one counterparty, one provider result per handset - and the text a
    // given handset received is recorded from `dispatched` below. A hoist would save one
    // string substitution per recipient and would have to be undone by the first merge
    // field that varies again.
    const body = renderMergeFields(
      config.body,
      bundle.mergeCtx,
      { html: false, fallbacks: config.fallbacks },
    );
    const { delivery } = await recordOutboundSms({
      organizationId: bundle.organizationId,
      to: target.to,
      body,
    });
    dispatched.push({ target, body, delivery });
  }

  const sent = dispatched.filter((d) => d.delivery.delivered);
  const failed = dispatched.filter((d) => !d.delivery.delivered && d.delivery.reason === 'CTM_ERROR');
  for (const d of dispatched) {
    if (d.delivery.delivered) continue;
    // A provider rejection names WHO it lost, the way the email path names the address it
    // lost - in a fan-out, "text delivery failed" alone does not say which handset. The
    // copy is per-target (see TextTarget.failureDetail), so naming a staff member never
    // costs the customer their number.
    reasons.push(
      d.delivery.reason === 'CTM_ERROR' ? d.target.failureDetail : SMS_SKIP_COPY[d.delivery.reason],
    );
  }
  const allReasons = [...new Set(reasons)];
  const recipientSummary = targets.map((t) => t.summary).join(', ');
  const audienceOutcomes = textAudienceOutcomes(audiences, dispatched, bundle.entityRef.type);

  if (sent.length > 0) {
    // Run history previews the message that ACTUALLY left the building, so this is a body
    // some handset really received - never a re-render nobody got. Every body in a fan-out
    // is now identical, so the choice of representative no longer matters; `targets` is
    // still built in a fixed order - the customer first, then staff in resolution order -
    // so the first DELIVERED one is stable rather than arbitrary if that ever changes
    // again. On a customer-addressed step this is exactly the text the customer read,
    // which is what this line has always shown.
    const preview = sent[0].body;
    return {
      status: 'SENT',
      recipientSummary,
      detail: allReasons.length
        ? `Sent to ${sent.length} · skipped: ${allReasons.join('; ')}`
        : preview.length > 120
          ? `${preview.slice(0, 117)}…`
          : preview,
      audienceOutcomes,
    };
  }

  // A FAILED step names who the send was lost to; a SKIPPED one does not carry a summary
  // at all. Both match what the customer path has always written to run history, and the
  // email path makes the same split.
  if (failed.length > 0) {
    return { status: 'FAILED', recipientSummary, detail: allReasons.join(' · '), audienceOutcomes };
  }
  return { status: 'SKIPPED', detail: allReasons.join(' · '), audienceOutcomes };
}

type TextDispatch = { target: TextTarget; body: string; delivery: CtmSmsSendResult };

/**
 * The text twin of emailAudienceOutcomes: fold each handset's delivery back onto the
 * audiences that named it. A person named by two audiences was texted once, and both
 * audiences read that one delivery. A person with no number never reached `dispatched`,
 * so their audience carries the same "No phone number on file" line the step detail does.
 */
function textAudienceOutcomes(
  audiences: KeyedAudience[],
  dispatched: TextDispatch[],
  entity: AutomationEntity,
): AudienceOutcome[] {
  const byKey = new Map(dispatched.map((d) => [d.target.key, d]));
  return audiences.map((r) => {
    const base = { audience: r.key, label: audienceLabel(r.key, entity) };
    if (r.skipReason) return { ...base, outcome: 'skipped', summary: r.skipReason };
    const own: TextDispatch[] = [];
    const unreachable: string[] = [];
    if (r.key === 'customer') {
      const d = byKey.get('customer');
      if (d) own.push(d);
    } else {
      for (const u of r.users) {
        const d = byKey.get(`user:${u.id}`);
        if (d) own.push(d);
        else unreachable.push(`No phone number on file for ${fullName(u)}`);
      }
    }
    const sent = own.filter((d) => d.delivery.delivered);
    if (sent.length > 0) return { ...base, outcome: 'sent', summary: sentSummary(sent.map((d) => d.target.summary)) };
    const problems = [
      ...unreachable,
      ...own.map((d) =>
        d.delivery.delivered
          ? null
          : d.delivery.reason === 'CTM_ERROR'
            ? d.target.failureDetail
            : SMS_SKIP_COPY[d.delivery.reason],
      ),
    ].filter((p): p is string => p !== null);
    const outcome = own.some((d) => !d.delivery.delivered && d.delivery.reason === 'CTM_ERROR') ? 'failed' : 'skipped';
    return { ...base, outcome, summary: [...new Set(problems)].join(' · ') || 'No one to text' };
  });
}
