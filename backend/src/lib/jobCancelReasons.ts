/**
 * The built-in job cancel reasons, and the rules that govern the per-org list (Roles & Permissions, PRD 6, M7).
 *
 * The job twin of `lostReasonOptions.ts` (the estimate decline reasons), with the same mechanics and a list of its own:
 * editing one never changes the other. An org that never edited the list has no rows and resolves to the six built-ins
 * below; its first edit writes all six as the org's own copy. A reason is addressed by a stable CODE, which a cancelled
 * job stores (S06.15); the LABEL is the renameable half, and renaming rewrites no job. Nothing is deleted - a reason is
 * turned off, and a job that used it keeps showing it.
 *
 * The code shape, the derivation from a label and the label and size caps are the estimate list's own, shared on
 * purpose: one rule for what a reason code looks like, whichever list it belongs to.
 */

import { prisma } from './prisma';
import {
  LOST_REASON_CODE_PATTERN,
  LOST_REASON_LABEL_MAX,
  MAX_LOST_REASON_OPTIONS,
  deriveLostReasonCode,
} from './lostReasonOptions';

export interface BuiltInJobCancelReason {
  code: string;
  label: string;
}

/** The six built-ins, in the order the cancel dialogs offer them. */
export const BUILT_IN_JOB_CANCEL_REASONS: readonly BuiltInJobCancelReason[] = [
  { code: 'CUSTOMER_BACKED_OUT', label: 'Customer backed out' },
  { code: 'WENT_WITH_A_COMPETITOR', label: 'Went with a competitor' },
  { code: 'PRICE', label: 'Price' },
  { code: 'COULD_NOT_DO_THE_WORK', label: 'Could not do the work' },
  { code: 'DUPLICATE_JOB', label: 'Duplicate job' },
  { code: 'OTHER', label: 'Other' },
] as const;

export const BUILT_IN_JOB_CANCEL_REASON_CODES: ReadonlySet<string> = new Set(
  BUILT_IN_JOB_CANCEL_REASONS.map((r) => r.code),
);

/** "Other" can be renamed like any built-in but never turned off, so a reason always fits. */
export const UNDEACTIVATABLE_JOB_CANCEL_REASON_CODE = 'OTHER';

export const MAX_JOB_CANCEL_REASONS = MAX_LOST_REASON_OPTIONS;
export const JOB_CANCEL_REASON_LABEL_MAX = LOST_REASON_LABEL_MAX;
export const JOB_CANCEL_REASON_CODE_PATTERN = LOST_REASON_CODE_PATTERN;
export const deriveJobCancelReasonCode = deriveLostReasonCode;

/** One reason as a cancel dialog needs it: the stored value and the words to show. */
export interface OfferedJobCancelReason {
  code: string;
  label: string;
}

/**
 * The reasons an organisation offers a cancel dialog today.
 *
 * The org's OWN rows if it has any, else the six built-ins. The fallback is keyed on whether the org has ANY rows, not on
 * whether it has any ACTIVE ones: an org that edited its list and switched most of it off has curated it, and answering
 * with the built-ins would re-offer words the admin retired. Ordered as the settings list is (sort_order, then code).
 */
export async function resolveOfferedJobCancelReasons(organizationId: string): Promise<OfferedJobCancelReason[]> {
  const rows = await prisma.jobCancelReasonOption.findMany({
    where: { organization_id: organizationId },
    orderBy: [{ sort_order: 'asc' }, { code: 'asc' }],
  });
  if (rows.length === 0) {
    return BUILT_IN_JOB_CANCEL_REASONS.map((r) => ({ code: r.code, label: r.label }));
  }
  return rows.filter((r) => r.is_active).map((r) => ({ code: r.code, label: r.label }));
}

/**
 * Is this code one the organisation currently offers? The check the cancel move runs on a new cancel (S06.15): an unknown
 * code, another org's code and a turned-off reason all answer no. Jobs already cancelled under a since-retired reason keep
 * it; this governs new writes only.
 */
export async function isOfferedJobCancelReason(organizationId: string, code: string): Promise<boolean> {
  const offered = await resolveOfferedJobCancelReasons(organizationId);
  return offered.some((o) => o.code === code);
}

/** A job's cancel reason as the job page shows it: the code it stores and the words that code has today. */
export interface JobCancelReasonView {
  code: string;
  label: string;
  /** False when the reason has since been turned off: the job that used it still shows it. */
  is_active: boolean;
}

/**
 * Every reason the organisation has, turned-off ones included, keyed by code: the lookup behind "a reason renamed later
 * shows its current label; a turned-off reason still shows on the jobs that used it". The org's own rows if it has any,
 * else the six built-ins (an org that never edited the list has no rows, and its first edit writes all six). One query.
 */
export async function resolveJobCancelReasonViews(organizationId: string): Promise<Map<string, JobCancelReasonView>> {
  const rows = await prisma.jobCancelReasonOption.findMany({ where: { organization_id: organizationId } });
  const views = rows.length > 0
    ? rows.map((r) => ({ code: r.code, label: r.label, is_active: r.is_active }))
    : BUILT_IN_JOB_CANCEL_REASONS.map((r) => ({ code: r.code, label: r.label, is_active: true }));
  return new Map(views.map((v) => [v.code, v]));
}

/** The reason a job holds, with its current label, or null when the job holds none (cancelled before the list existed, or not cancelled). */
export async function jobCancelReasonFor(organizationId: string, code: string | null | undefined): Promise<JobCancelReasonView | null> {
  if (!code) return null;
  return (await resolveJobCancelReasonViews(organizationId)).get(code) ?? null;
}

/**
 * The job history shows a cancel reason by its CURRENT label. A cancel (and a later change of reason) writes the label it
 * had then into the entry's text and its code and that label into the entry's metadata; this puts the code's label today
 * in the text's place. An entry with no code (every entry written before the list existed) is returned as it is, and so is
 * one whose code the org no longer lists.
 */
export async function withCurrentCancelReasonLabels<E extends { description: string | null; metadata: unknown }>(
  organizationId: string,
  events: E[],
): Promise<E[]> {
  const coded = (e: E) => {
    const m = e.metadata as { reason_code?: unknown; reason_label?: unknown } | null;
    return m && typeof m === 'object' && typeof m.reason_code === 'string' && typeof m.reason_label === 'string' ? { code: m.reason_code, label: m.reason_label } : null;
  };
  if (!events.some((e) => coded(e))) return events;
  const views = await resolveJobCancelReasonViews(organizationId);
  return events.map((e) => {
    const was = coded(e);
    const now = was ? views.get(was.code) : undefined;
    if (!was || !now || !e.description || now.label === was.label || !e.description.endsWith(`: ${was.label}`)) return e;
    return { ...e, description: `${e.description.slice(0, e.description.length - was.label.length)}${now.label}` };
  });
}
