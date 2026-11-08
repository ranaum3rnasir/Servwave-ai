/**
 * mergeFieldFallbacks - "If empty, fill with", the per-step text a merge field renders when it
 * has no value.
 *
 * Spec: md_files/specs/scheduling/2026-09-13-customer-scheduling-notifications-and-visit-milestones.md
 * (Implementation Decisions > Merge-field fallbacks).
 *
 * A send step's config carries `fallbacks: { [field]: text }`, stored with the step and frozen
 * into the workflow version like its body. The context builders inject no words of their own - a
 * crewless job resolves `technician.names` to '', a job with no address on file resolves
 * `job.address` to '' - and this module is what keeps an untouched template rendering exactly as
 * it did before.
 *
 * The wording is the wording the context builders used to inject, capitalised as they had it,
 * because the seeded copy ("Who's coming: {{technician.names}}.") has been sending it that way.
 * The two address and phone phrases are IMPORTED rather than restated, for the reason they were
 * shared in the first place: an email that renders {{lead.address}} beside
 * {{lead.walkthrough_location}} must not offer two different phrases for one absent thing.
 *
 * ── WHY THE DEFAULTS ARE MERGED UNDER A STORED MAP, AND NOT READ "AS-IS" ──────────────────────
 *
 * This module used to read a PRESENT `fallbacks` key as the author's whole map, and only an
 * ABSENT key as these defaults. That looks like the careful reading and it is the bug that made
 * this box a dead control (Ran, 2026-09-15).
 *
 * Every stored map is a SNAPSHOT of these defaults as they stood when it was written.
 * `seedDefaultAutomations.ts` writes `fallbacks: { ...DEFAULT_MERGE_FIELD_FALLBACKS }` into every
 * seeded step, so EVERY automation in EVERY organisation already carries one; and the builder
 * emits the whole displayed map on the author's first edit, so any step whose author has ever
 * touched one carries one too. Under as-is semantics, a key added here would reach none of them -
 * the field would resolve '' with no fallback declared, and `renderMergeFields` would put a HOLE
 * in a customer's email. The nine fields added below would have regressed every existing send in
 * exactly the way D7 exists to forbid.
 *
 * Merging costs nothing an author can see. CLEARING a fallback stores the key with '', it does
 * not delete it (see `displayedFallbacks` in frontend/src/lib/workflows/fallbacks.ts), so a
 * deliberate clear still wins over the default - `{ ...DEFAULTS, ...stored }` keeps the ''. The
 * only maps a merge changes are the ones missing a key they never had the chance to carry.
 */

import { SERVICE_ADDRESS_FALLBACK } from '../visitLocation';
import { MAIN_LINE_FALLBACK } from '../performerPhone';

export const DEFAULT_MERGE_FIELD_FALLBACKS: Readonly<Record<string, string>> = Object.freeze({
  'technician.names': 'Our team',
  'technician.first_name': 'Our technician',
  'lead.performer_names': 'Our team',
  'customer.first_name': 'there',

  /*
   * THE NINE FIELDS WHOSE WORDS USED TO BE UNREACHABLE (Ran, 2026-09-15).
   *
   * Each of these resolved through a formatter that substituted a phrase of its own BEFORE the
   * renderer ever consulted this map, so `renderMergeFields`'s "empty -> the author's text" rule
   * could not fire: the value was never empty. An author typing into "If empty, fill with" on any
   * of them was typing into a control that did nothing, with no warning and no indication.
   *
   * THEY MOVE AS TWO FAMILIES, NOT AS NINE FIELDS, and that is the reason all nine are here
   * rather than the four that were reported. Within each family the value is deliberately
   * resolved ONCE and used several times - `lead.address` IS what `lead.walkthrough_location`
   * falls back to; `org.phone` IS what both phone fields fall back to - precisely so one email
   * cannot offer two answers for one absent thing. Moving half a family would break the invariant
   * the shared resolution exists to hold.
   *
   * The text is identical within each family, so nothing renders differently today. What changes
   * is that it is now the author's, editable and clearable, like every other fallback. Two fields
   * in one family CAN now be given different words - that is the author's own doing, made in a
   * form that shows them both, and it is the price of the control being real.
   */
  'lead.address': SERVICE_ADDRESS_FALLBACK,
  'job.address': SERVICE_ADDRESS_FALLBACK,
  'lead.walkthrough_location': SERVICE_ADDRESS_FALLBACK,
  'job.visit_location': SERVICE_ADDRESS_FALLBACK,

  'org.phone': MAIN_LINE_FALLBACK,
  'technician.phones': MAIN_LINE_FALLBACK,
  'technician.servwave_phones': MAIN_LINE_FALLBACK,
  'lead.performer_phones': MAIN_LINE_FALLBACK,
  'lead.performer_servwave_phones': MAIN_LINE_FALLBACK,

  /*
   * THE TWO STAFF-FACING WORDS THAT MOVED WITH THEM (Ran, 2026-09-14/15).
   *
   * `context.ts` substituted both of these itself until now, with the same consequence as the
   * nine above: a field the builder has already filled is never empty, so `renderMergeFields`'s
   * "empty -> the author's text" rule could not fire and the box did nothing. The strings are the
   * ones that ship today (`SCOPE_NOTES_FALLBACK` and `TASK_ASSIGNEES_FALLBACK` as they stood),
   * moved verbatim, so the three seeded staff messages that carry them - `default-tech-assigned`
   * ends "Scope: {{job.scope_notes}}", and `default-task-created` and `default-task-assigned`
   * both carry "Everyone on it: {{task.assignee_names}}." - read exactly as their readers
   * already receive them. Dropping the words instead of moving them would have been the
   * behaviour change, and it would have been a hole in copy we ship ourselves.
   *
   * THEY REPORT THE ABSENCE RATHER THAN NAMING THE THING, which is a defensible default only
   * because the audience is the OFFICE. "Scope: not specified" is the honest answer to a
   * colleague. That is also why `lead.job_type` and `job.type` are deliberately NOT here: the
   * same shape in a customer's inbox leaks the CRM's own data-completeness, a customer-facing
   * field has to name the appointment or say nothing, and neither seeded body uses them - so the
   * wording is the author's to choose rather than ours to guess.
   */
  'job.scope_notes': 'not specified',
  'task.assignee_names': 'nobody yet',

  /*
   * THE OWNER SIGN-OFF (SRVW-303).
   *
   * An unsigned email is worse than one signed by the team, so an unowned lead signs as the team
   * rather than as a hole - the same family wording as `technician.names`. NOT the org name, which
   * the ticket first reached for: this map is static text and `renderMergeFields` does not render
   * tokens inside a fallback, so the only way to sign with {{org.name}} would be a value-level
   * substitution in context.ts - which is precisely what made this box a dead control for nine
   * fields until 2026-09-15. An author who wants the company name types it here, once, per step.
   */
  'lead.owner_name': 'Our team',
  'lead.owner_first_name': 'Our team',
  'job.owner_name': 'Our team',
  'job.owner_first_name': 'Our team',
  'estimate.owner_name': 'Our team',
  'estimate.owner_first_name': 'Our team',
});

/** Reads the fallback map off a stored send-step config. See the module note for the rules. */
export function fallbacksFor(config: unknown): Record<string, string> {
  const defaults = { ...DEFAULT_MERGE_FIELD_FALLBACKS };
  if (!config || typeof config !== 'object' || Array.isArray(config)) return defaults;
  const raw = (config as Record<string, unknown>).fallbacks;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaults;
  const out: Record<string, string> = defaults;
  for (const [field, text] of Object.entries(raw as Record<string, unknown>)) {
    // Non-strings are dropped rather than coerced, and a dropped key falls back to the default
    // above rather than to nothing: a config carrying `fallbacks: { 'job.address': 42 }` is
    // malformed, and answering it with a hole in a customer's email is the worse of the two
    // readings.
    if (typeof text === 'string') out[field] = text;
  }
  return out;
}
