/**
 * defaultAutomations.ts — the built-in automations seeded into every org,
 * each one standing in for a hard-coded email (backend/src/lib/email.ts).
 * Content is a straight port of that sender's real subject/body, rewritten
 * with merge-field tokens — not new copy. See
 * md_files/plans/automations/2026-07-21-hardcoded-to-automation-center-migration.md
 * for which built-in sender each entry retires. This registry only supplies
 * what the seeder (seedDefaultAutomations.ts) writes — nothing here deletes a
 * hard-coded sender. That cutover is a separate, later change per event.
 *
 * True of the first thirteen entries, and NOT of the five `default-task-*` ones
 * Spec B added at the bottom. Those stand in for nothing: a task has never had a
 * hard-coded sender, so their copy is genuinely new and they are net-new email
 * rather than a cut-over. The block comment above them records why they still
 * ship enabled, and what was measured before that was decided.
 *
 * NONE OF THIS COPY GREETS ANYBODY BY NAME, and that is a rule rather than an
 * oversight. Nine of these bodies opened "Hi {{recipient.first_name}}," until
 * Ran had that merge field removed outright on 2026-09-15 (the reasoning is on
 * `BASE` in catalog.ts). Each one lost the greeting and kept every word of its
 * payload - a staff notice is a notice, not a letter, and "You have been
 * assigned to job {{job.number}}" tells the technician everything the greeting
 * did not. Adding a salutation back to a STAFF body means re-introducing the
 * field, which is a migration over every organisation's saved copy, not an edit
 * here; a CUSTOMER body may greet with {{customer.first_name}}, which carries a
 * fallback and is what the customer-facing entries above already use.
 *
 * builtin_key is prefixed `default-` to stay visually distinct from the
 * unrelated gallery `template_key` namespace: template_key records
 * PROVENANCE ("copied from this gallery template", and a template may be
 * copied more than once), builtin_key records IDENTITY ("is the org's one
 * copy of built-in X") — see the schema comment on Workflow.builtin_key.
 */
import type { AutomationTriggerType } from '@prisma/client';
import type { RecipientKey } from './recipients';
import type { DateAnchorTriggerConfig } from './workflowValidation';

export interface DefaultAutomation {
  builtin_key: string;
  name: string;
  description: string;
  trigger_type: AutomationTriggerType;
  recipients: RecipientKey[];
  subject: string;
  body: string;
  /**
   * Timing, for the one default whose trigger is a date anchor rather than an event.
   *
   * Added by Spec B slice 7, and NOT an optional nicety. Every one of the first thirteen
   * defaults is an event trigger, so `buildDefinition` hardcoded `trigger_config: null` and
   * the seeder wrote `Prisma.DbNull` unconditionally. A date-anchored workflow seeded that way
   * publishes, enables and reads back correctly in the builder - and then cron.ts's
   * `dateAnchorConfigOf` returns null on every tick, logs "date-anchored workflow has an
   * invalid trigger_config - skipping", and the reminder never fires for any org, ever, with
   * nothing red anywhere.
   *
   * Absent for an event trigger, where the validator refuses a config outright ("this trigger
   * fires on the event itself - remove the timing offset").
   */
  trigger_config?: DateAnchorTriggerConfig;
  /**
   * Whether this default lands switched ON when seeded.
   *
   * The seeder is idempotent by SKIP — an existing (organization_id, builtin_key)
   * row is left completely alone — so a workflow seeded disabled can never be
   * enabled by re-running it. Seeding an entry in its final state is therefore
   * the only honest option, and the no-double-send rule holds a different way:
   * an entry may only flip to `true` in the same change that DELETES the
   * hard-coded sender it replaces. Enabling one while its built-in still fires
   * double-emails every customer of every org.
   *
   * Enforced by a test (defaultAutomations.test.ts) that pins the cut-over set.
   */
  seed_enabled: boolean;
}

export const DEFAULT_AUTOMATIONS: DefaultAutomation[] = [
  {
    builtin_key: 'default-job-scheduled',
    name: 'Job scheduled confirmation',
    description:
      'Tells the customer their job has a date on the calendar. Replaces the built-in "Service Scheduled" email.',
    trigger_type: 'JOB_SCHEDULED',
    recipients: ['customer'],
    subject: 'Service Scheduled: {{job.number}}',
    // "Who's coming:" rather than "Technician:" — technician.names renders the
    // whole crew, so a singular label (or using the list as a sentence subject)
    // breaks the moment a job has more than one person on it.
    body: "Hi {{customer.first_name}}, your service {{job.number}} has been scheduled for {{job.scheduled_date}} at {{job.scheduled_time}}. Who's coming: {{technician.names}}. Address: {{job.address}}.",
    seed_enabled: true,
  },
  {
    builtin_key: 'default-job-rescheduled',
    name: 'Job rescheduled notice',
    description:
      'Tells the customer their job moved to a new time. Replaces the built-in "Job Rescheduled" email.',
    trigger_type: 'JOB_RESCHEDULED',
    recipients: ['customer'],
    subject: 'Job {{job.number}} Rescheduled',
    body: "Hi {{customer.first_name}}, your job {{job.number}} has been rescheduled to {{job.scheduled_date}} at {{job.scheduled_time}}. Who's coming: {{technician.names}}. Address: {{job.address}}.",
    seed_enabled: true,
  },
  {
    builtin_key: 'default-estimate-approved-notify-creator',
    name: 'Estimate approved — notify creator',
    description:
      "Tells the estimate's creator the customer approved it. Replaces the built-in creator-notification email.",
    trigger_type: 'ESTIMATE_APPROVED',
    recipients: ['creator'],
    subject: 'Estimate {{estimate.number}} — Approved',
    body: '{{customer.full_name}} approved estimate {{estimate.number}} ({{estimate.total}}).',
    seed_enabled: true,
  },
  {
    builtin_key: 'default-estimate-declined-notify-creator',
    name: 'Estimate declined — notify creator',
    description:
      "Tells the estimate's creator the customer declined it. Replaces the built-in creator-notification email.",
    trigger_type: 'ESTIMATE_DECLINED',
    recipients: ['creator'],
    subject: 'Estimate {{estimate.number}} — Declined',
    body: '{{customer.full_name}} declined estimate {{estimate.number}} ({{estimate.total}}).',
    seed_enabled: true,
  },
  {
    builtin_key: 'default-tech-assigned',
    name: 'Technician assigned',
    description:
      'Tells a technician they were added to a job. Replaces the built-in "New Job Assignment" email.',
    trigger_type: 'TECH_ASSIGNED',
    // assigned_user, not assigned_team: this dispatches once per newly-added
    // technician, and assigned_team would resolve to the whole live crew — see
    // the 2026-07-27 correction in the phase 3 cutover plan.
    recipients: ['assigned_user'],
    subject: 'New Job Assignment: {{job.number}}',
    body: 'You have been assigned to job {{job.number}} for {{customer.full_name}} at {{job.address}}, scheduled for {{job.scheduled_date}} at {{job.scheduled_time}}. Scope: {{job.scope_notes}}',
    seed_enabled: true,
  },
  {
    builtin_key: 'default-tech-unassigned',
    name: 'Technician unassigned',
    description:
      'Tells a technician they were removed from a job. Replaces the built-in "Removed from Job" email.',
    trigger_type: 'TECH_UNASSIGNED',
    recipients: ['removed_user'],
    subject: 'Removed from Job: {{job.number}}',
    body: 'You have been removed from job {{job.number}} for {{customer.full_name}}. No further action is required.',
    seed_enabled: true,
  },
  {
    builtin_key: 'default-job-en-route',
    name: 'Technician on the way',
    description:
      'Tells the customer the technician is on the way. Replaces the built-in "on the way" email.',
    trigger_type: 'JOB_EN_ROUTE',
    recipients: ['customer'],
    // Subject and body both stay count-neutral: the retired sender named one
    // technician, this names the whole crew, and neither line may assume a size.
    subject: "We're on the way",
    body: "Hi {{customer.first_name}}, we're on the way to {{job.address}} now. Who's coming: {{technician.names}}.",
    seed_enabled: true,
  },
  {
    builtin_key: 'default-walkthrough-scheduled',
    name: 'Walkthrough scheduled confirmation',
    description:
      'Tells the customer their site visit has a date. Replaces the built-in "Site Visit Scheduled" email.',
    trigger_type: 'WALKTHROUGH_SCHEDULED',
    recipients: ['customer'],
    subject: 'Site Visit Scheduled — {{lead.walkthrough_date}}',
    body: 'Hi {{customer.first_name}}, your site visit has been scheduled for {{lead.walkthrough_date}} at {{lead.walkthrough_time}}. {{lead.performer_names}} will visit {{lead.address}}.',
    seed_enabled: true,
  },
  {
    builtin_key: 'default-walkthrough-rescheduled',
    name: 'Walkthrough rescheduled notice',
    description:
      'Tells the customer their site visit moved. Replaces the built-in "Site Visit Rescheduled" email.',
    trigger_type: 'WALKTHROUGH_RESCHEDULED',
    recipients: ['customer'],
    subject: 'Site Visit Rescheduled — {{lead.walkthrough_date}}',
    body: 'Your site visit has been rescheduled to {{lead.walkthrough_date}} at {{lead.walkthrough_time}}. {{lead.performer_names}} will visit {{lead.address}}.',
    seed_enabled: true,
  },
  {
    builtin_key: 'default-walkthrough-performer-assigned',
    name: 'Walkthrough performer assigned',
    description:
      'Tells a performer they were added to a walkthrough. Replaces the built-in "Walkthrough Assigned" email.',
    trigger_type: 'WALKTHROUGH_PERFORMER_ASSIGNED',
    // assigned_user, not assigned_team — same reasoning as default-tech-assigned above.
    recipients: ['assigned_user'],
    subject: 'Walkthrough Assigned — {{customer.full_name}}',
    body: 'You have been assigned a walkthrough for {{customer.full_name}} ({{lead.number}}) at {{lead.address}} on {{lead.walkthrough_date}} at {{lead.walkthrough_time}}.',
    seed_enabled: true,
  },
  {
    builtin_key: 'default-walkthrough-performer-removed',
    name: 'Walkthrough performer removed',
    description:
      'Tells a performer they were removed from a walkthrough. Replaces the built-in "Removed from Walkthrough" email.',
    trigger_type: 'WALKTHROUGH_PERFORMER_REMOVED',
    recipients: ['removed_user'],
    subject: 'Removed from Walkthrough — {{customer.full_name}}',
    body: 'You have been removed from the walkthrough for {{customer.full_name}} ({{lead.number}}). No further action is required.',
    seed_enabled: true,
  },
  {
    builtin_key: 'default-walkthrough-completed',
    name: 'Walkthrough completed',
    description:
      'Follows up with the customer and notifies the lead owner after a site visit. Replaces the built-in "Site Visit Completed" emails.',
    trigger_type: 'WALKTHROUGH_COMPLETED',
    recipients: ['customer', 'salesperson'],
    subject: 'Site Visit Completed',
    body: "We've completed our site visit at {{lead.address}}. {{org.name}} will follow up with an estimate shortly.",
    seed_enabled: true,
  },
  {
    builtin_key: 'default-walkthrough-cancelled',
    name: 'Walkthrough cancelled',
    description:
      'Tells the customer, the performer, and the lead owner a scheduled site visit was cancelled, and why. Replaces the built-in "Site Visit Cancelled" emails.',
    trigger_type: 'WALKTHROUGH_CANCELLED',
    recipients: ['customer', 'assigned_team', 'salesperson'],
    subject: 'Site Visit Cancelled',
    body: 'Your scheduled site visit for {{customer.full_name}} ({{lead.number}}) has been cancelled. Reason: {{event.reason}}',
    seed_enabled: true,
  },

  // ── Spec B: tasks, the fifth automation entity ─────────────────────────────
  //
  // THESE FIVE ARE NET-NEW EMAIL. Every entry above replaced a hard-coded sender, which made
  // it net-zero for a live org - turning one on retired a built-in that was already sending
  // the same thing to the same person. A task has never had a built-in sender: that a task
  // notifies nobody outside the app is the gap Spec B exists to close. So there is nothing
  // here to retire, nothing to double-send, and equally nothing to offset the new volume.
  //
  // Shipping them enabled was decided explicitly ("ship them on for everyone"), against a
  // MEASURED first-sweep radius rather than an assumed one. The number that matters is not
  // "five keys per org" (always five, says nothing about email) and not a total task count.
  // Day one is ZERO for the four event triggers - they fire on future actions. For the
  // reminder it is, per org, the count of open tasks whose due_at falls inside the sweep's
  // FIRST window, times recipients per task. That window is [now, now + 24h] for the
  // before-reminder seeded here. `npm run automations:seed-defaults -- --dry-run` computes
  // exactly that figure per org, off this entry's own trigger_config, so it can be re-read
  // before any real seed rather than trusted from this comment.
  //
  // Measured 2026-08-28, against both live databases: ZERO emails on the first sweep, for
  // every org in each of them. One holds 5 orgs and 79 open tasks (77 of them in a single
  // customer); the other holds 9 orgs and 48 open tasks. Not one of those tasks falls due in
  // the next 24 hours, so the reminder starts silent everywhere and only speaks about work
  // scheduled after the seed.
  //
  // The direction is a safety choice, not a preference, and the same measurement settles it.
  // dateAnchorSweep applies a fixed seven-day grace to `after`, so an overdue chase's first
  // window is [now - offset - 7 days, now - offset] and the first run after seeding chases
  // every task that went overdue in the preceding week, all at once. Seeded as an after-chase
  // instead, that same measurement returns 10 emails in the larger database (9 of them landing
  // on one org) and 1 in the other: a backlog flood in miniature, and one that scales with the
  // size of the customer rather than staying flat. A `before` window can only ever contain
  // work that has not come due yet. An org that wants the chase adds it in the builder from
  // this same trigger - one trigger covers both directions, which is why Spec B has no
  // separate overdue trigger.
  //
  // A note on reach, stated rather than left implied: there is no automatic seeding path. The
  // seeder's only non-test caller is an operator script, and nothing in organization creation
  // invokes it. An org created tomorrow gets none of these five - and none of the thirteen
  // above either - until an operator runs `npm run automations:seed-defaults`.
  //
  // The copy is held to fields that ALWAYS render. `task.due_date` is empty on a task with no
  // due date and `task.linked_record` is empty on a free-standing task; both are legal on the
  // live task triggers, so the validator cannot keep them out and an empty merge field reads
  // as a broken template rather than as a task without a due date. Only the reminder uses
  // `task.due_date`, and only because its sweep selects on due_at in the first place.
  {
    builtin_key: 'default-task-created',
    name: 'Task created',
    description:
      'Tells the people put on a new task that it exists, so task work reaches them without their opening the app.',
    trigger_type: 'TASK_CREATED',
    recipients: ['assignees'],
    subject: 'New task: {{task.title}}',
    // "Everyone on it:" for the same reason "Who's coming:" guards the crew lines above -
    // task.assignee_names renders the WHOLE roster, so it must never be a sentence subject.
    body: 'A new task has been assigned to you at {{org.name}}: {{task.number}} - {{task.title}} ({{task.priority}} priority). Everyone on it: {{task.assignee_names}}. Open it here: {{task.link}}',
    seed_enabled: true,
  },
  {
    builtin_key: 'default-task-assigned',
    name: 'Added to a task',
    description:
      'Tells the one person just added to a task that already existed. A task created WITH assignees fires "Task created" instead, so nobody is told twice about the same moment.',
    trigger_type: 'TASK_ASSIGNED',
    // assigned_user, not assignees - and this is the single highest-damage line in the whole
    // registry. `assignees` resolves to the LIVE roster, so this default built on it would
    // re-email everyone already on the task each time one more person joined: the exact bug
    // the assigned_user key was invented to prevent, with no error and nothing in the logs. A
    // single-assignee fixture cannot see the difference, because with one person on the task
    // the two audiences return the same row. Same reasoning as default-tech-assigned above.
    recipients: ['assigned_user'],
    subject: 'You have been added to: {{task.title}}',
    body: 'You have been added to task {{task.number}} - {{task.title}} ({{task.priority}} priority). Everyone on it: {{task.assignee_names}}. Open it here: {{task.link}}',
    seed_enabled: true,
  },
  {
    builtin_key: 'default-task-comment-added',
    name: 'New comment on a task',
    description:
      'Tells the assignees and the watchers when somebody comments on a task. The person who wrote the comment is never told about their own.',
    trigger_type: 'TASK_COMMENT_ADDED',
    // A comment is about the TASK, not about one person, so this takes the entity-wide
    // audiences - the opposite of the assignment default directly above.
    recipients: ['assignees', 'watchers'],
    subject: 'New comment on: {{task.title}}',
    // The comment text itself is deliberately not quoted: the catalogue offers no merge field
    // for it, so the mail carries the fact and the link and lets the app carry the thread.
    body: 'Somebody has commented on task {{task.number}} - {{task.title}}. Read it and reply here: {{task.link}}',
    seed_enabled: true,
  },
  {
    builtin_key: 'default-task-deleted',
    name: 'Task deleted',
    description:
      'Tells the people who were on a task that it has been deleted, so nobody sets out to do work that no longer exists.',
    trigger_type: 'TASK_DELETED',
    recipients: ['assignees', 'watchers'],
    // Task deletion is a HARD delete, so by the time this sends there is no row left to read a
    // due date, a status, a priority or a live roster off. The number and the title are the
    // whole of the pre-delete snapshot, and the whole of what this copy may say. No link
    // either: the task it would point at is gone.
    subject: 'Task deleted: {{task.title}}',
    body: 'Task {{task.number}} - {{task.title}} has been deleted at {{org.name}}. There is no longer any work to do on it and no further action is required.',
    seed_enabled: true,
  },
  {
    builtin_key: 'default-task-due-reminder',
    name: 'Task due soon reminder',
    description:
      'Reminds the assignees the day before a task is due. Tasks that are done or cancelled are never picked up.',
    trigger_type: 'TASK_DATE_ANCHORED',
    recipients: ['assignees'],
    // The ONE default in this registry with a trigger_config, and the reason the seeder had to
    // change at all - see DefaultAutomation.trigger_config. `before` rather than `after` is a
    // blast-radius choice, explained in the block comment above this group.
    trigger_config: { anchor: 'task.due_at', direction: 'before', offset_minutes: 24 * 60 },
    // The subject says "due soon" rather than "due tomorrow" on purpose: the offset above is
    // an admin-editable field on their own copy of this workflow, and a subject naming a
    // specific interval would start lying the moment they changed it. The body states the
    // actual date instead, which is true at every offset.
    subject: 'Task due soon: {{task.title}}',
    body: 'Task {{task.number}} - {{task.title}} is due {{task.due_date}}. Open it here: {{task.link}}',
    seed_enabled: true,
  },
];
