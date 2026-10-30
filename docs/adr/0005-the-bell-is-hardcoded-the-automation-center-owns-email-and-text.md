# The bell is hardcoded; the Automation Center owns email and text

**Status:** accepted
**Date:** 2026-08-27

**On the number.** The next free number is genuinely ambiguous here, so this file states the
convention it applied rather than leaving the next author to re-derive it. `0003` has never
existed on any ref (`git ls-tree origin/main docs/adr/` and the same on `origin/staging` both
return four files, and no 0003 appears anywhere in history), and `0004` is used twice:
`0004-refund-never-reopens-amount-due.md` explains at its own line 6 that it was numbered around
two ADRs that were then untracked, and `0004-inventory-billing-bridge.md` landed on the same
number. The convention applied is **one past the highest number in use**, counting a duplicate
once, which gives 0005. The duplicate 0004 is deliberately not renumbered: renaming a merged ADR
breaks every inbound link for no benefit, and a reader who lands on either file still gets the
decision it records.

## Context

The bell had 61 registered verbs and no stated rule for any of them. Nothing was configurable,
most existed only as hardcoded `emit()` calls, and there was no written answer to "should this
ring the bell?", so every new verb was a fresh judgement call and the judgements had drifted.

Underneath that, two systems both claimed the in-app channel and neither owned it. The
notification service raised bell rows from call sites across the controllers. The Automation
Center offered an in-app step type, which an admin could put on the same occurrence a hardcoded
`emit()` already covered, producing two INTERRUPT rows with different categories and no shared
dedupe key. Five of the sixteen prebuilt gallery templates used that step, so the collision was
one click away and had never been confronted only because none of the thirteen seeded defaults
used it. An admin choosing between the two had no basis for the choice, because the product had
never said which one owned the channel.

## Decision

**Each channel has exactly one owner.**

The **in-app bell is hardcoded**, and rule-governed rather than ad hoc. Every verb declares a
**family** (`involvement` / `duty` / `self`), which answers who the notification is for, and a
**timing** (`event` / `time`), which answers when it fires. The declaration is `VERB_RULES` in
`backend/src/services/notifications/templates.ts`, typed over the template registry's own keys,
so it is the compiler and not a reviewer that keeps it complete. **Rule 0** - never tell someone
about their own action - is enforced once, at `dedupe()` in `resolveRecipients.ts`, and the
`self` family is its single named exception.

**Email and text are automated through the Automation Center**, configured by admins per
workflow. The in-app step type leaves the authoring surface: it is not offered by any picker or
gallery, and it is absent from the hand-written authorable step type, so putting it back is a
compile error rather than a review comment. The refusal itself lives at publish, in
`validateStep`. The draft write tier deliberately still spans the storage enum, so a workflow
that already holds a legacy in-app step stays editable and duplicable: the builder re-sends
every step it hydrated on each autosave, so a write tier that refused the label would block
every save on that workflow rather than only its publish.

This is what a mobile notification centre can be built against. There is one place that decides
who hears about what in-app, one vocabulary for saying why, and one answer to "which system sent
this".

## Consequences

- **A workflow run can no longer notify in-app.** Nothing an admin can author today reaches the
  bell through the engine: the step is not in the picker, not in the gallery, not in either
  config-schema map, and not in the authorable step type. Retiring the *authoring* surface is
  not on its own what makes this sentence true, and for a while it was the only thing that had
  happened - a version published before the retirement is immutable, so its frozen
  `workflow_versions.definition` JSON still names the step and the run path went on dispatching
  it. The decision for those versions is that the step **stops sending rather than breaking the
  workflow** (user story 23), and it is enforced on the run path rather than asserted here:
  `advanceEnrollment` skips any step type this build cannot run before dispatch
  (`backend/src/services/automations/enrollment.ts`), the retired label is out of
  `MESSAGING_STEPS` so it is skipped on arrival rather than parked until the send window, and
  `mapStepToActionType` answers null for it, so there is no action for an executor to route. The
  step records a SKIPPED run reading "In-app notifications now come from the bell - this step no
  longer sends." and the enrollment carries on to the next step.

- **The Test dialog's receipt is a deliberate exception, and stays.** `POST /api/workflows/:id/test`
  with `send_to_me` emits `automation.message` to the person who clicked Test
  (`backend/src/controllers/workflow.controller.ts:766`). That is a receipt the actor asked for,
  not a workflow run, and it is classified `self` in `VERB_RULES` with an `exception` string
  saying exactly that. **No sentence here says the Automation Center never writes to the bell**,
  because that would be a documented lie the first time somebody greps for `automation.message`.
  What is true is narrower and worth keeping precise: a *run* cannot notify in-app; one
  synchronous, actor-requested receipt can.

- **There is exactly one such door, and the count is pinned by a test.** The engine used to hold
  a second one: the in-app step's executor emitted the same verb, so for the length of the
  retirement `automation.message` had two call sites and any document claiming a single door was
  wrong. That executor is deleted, and the Test receipt is now the only emit site of that verb in
  the codebase. A number in prose rots silently, so this one is asserted rather than written
  down - `backend/src/services/automations/__tests__/retired-in-app-step-references.test.ts`
  greps the emit sites and fails if a second appears. This bullet is the one place the count is
  decided: `VERB_RULES` names the door and defers here, the scenarios reference says "one path,
  not two" and points at the same call site, so a reader arriving from any of the three lands on
  the same story.

- **The automation engine has no exception vocabulary, and that asymmetry is a decision.** The
  bell records a per-verb `exception` string because a family is a developer's classification of
  a hardcoded verb, and a reviewer can check it against the emit sites. The engine's audiences
  are admin configuration, chosen per workflow at runtime, so a named exception there would have
  no reviewer and no fixed set to be exhaustive over. The product's one deliberate
  notify-yourself path is the Test receipt above, which does not pass through the engine's
  audience resolver at all. Rule 0 therefore lands in the engine as one unconditional drop at
  `resolveAudience`, with nothing to except it.

- **The 62nd verb cannot be added unclassified.** `VERB_RULES` is
  `Record<KnownVerb, VerbRule>` over `keyof typeof registry`, so a registered verb with no rule
  and a rule with no registered verb are both `tsc -b` failures. The cost is that the template
  registry has to keep its literal keys: annotating it `Record<string, TemplateFactory>` again
  would silently turn the exhaustive map back into a free-for-all, which is why that annotation
  is now a trailing `satisfies` clause with a comment saying so.

- **Historical published versions keep referencing a step type that no longer sends.** The
  Postgres `WorkflowStepType` enum retains the `NOTIFY_TEAM` label for exactly that reason:
  storage outlives authoring. Legacy `workflow_steps` rows, the `workflow_step_runs.step_type`
  ledger and frozen version JSON all still resolve, the Activity tab still renders a past run's
  label and icon, and the step-run claim insert in `advanceEnrollment` - which writes the label
  *before* the step is dispatched - keeps working, which is what lets a legacy step be skipped
  rather than strand its enrollment. The narrowing is a hand-written *authorable* type in
  TypeScript only.

- **No slice in the sequence carried a migration, so a code-only rollback is possible.**
  `backend/prisma/` is untouched across the whole branch; reverting the code and redeploying the
  previous build restores the previous behaviour with no data step to undo. The full argument,
  including the one-command check and what would end the property, is in
  `md_files/plans/automations/2026-08-27-spec-a-retirement-rollback-property.md`.

## Alternatives rejected

**Per-user notification preferences.** The obvious answer to "why did I get this" is to let each
person choose. It answers a different question from the one that was actually open: with no
stated rule, a preference screen would have been 61 unexplained switches, and the drift it was
meant to fix would have moved into the defaults. A rule that can be stated in three families is
a precondition for preferences, not a substitute for them, and this decision does not foreclose
them.

**A user-facing catalogue of the 61 rows.** Rejected because a hand-maintained catalogue beside
an authoritative `VERB_RULES` is two registries, and two registries drift - which is the same
argument that put the classification next to the template registry rather than in a parallel
file. What ships instead is the maintained internal reference,
`md_files/specs/notifications/notification-scenarios-reference.md`, which carries the family
column and is the document a support engineer reads to answer an admin in one sentence (user
story 25). No product surface answers the admin directly, and the reference says so in its own
scope note rather than implying otherwise.

**Rebuilding the Postgres enum without the retired label.** This is the literal reading of
"removed from the step-type union" and it was deliberately not taken. It would have to rewrite
two dependent columns plus the frozen version JSON in one destructive migration that no code
rollback can undo, and it breaks the claim insert that the skip behaviour depends on, stranding
enrollments in a loop with no ledger row. That is a larger and more dangerous change than the
rest of this work combined, in exchange for a type the authorable narrowing already gives.

## Addendum (2026-10-10): Spider sends its own email and text

**Decided by:** Ran, 2026-10-10 (issue #2619).

Spider, the AI Center's lead watcher, is a **named exception** to "email and text are automated
through the Automation Center". When the Spider sweep claims a new alert (a lead stayed in an open
status longer than the company's limit), it sends its own email and text to the alerted staff,
alongside its in-app alert (the Spider button, panel and red frame; never the bell, Ran 2026-10-20).
It does not go through a workflow.

What keeps the exception narrow:

- **Staff only.** Spider emails and texts go to the company's own users (the configured roles,
  users and lead owner, falling back to the Admins), never to a customer, and never write into a
  customer conversation. The text path creates no conversation thread or message row.
- **One fixed sender.** Spider email always goes out as "ServWave Spider Alerts"
  `<alerts@spider.servwave.com>`. No caller can choose the sender, and no other email changes.
- **The company's own switches still apply.** The company email switch, the email suppression
  list, the company text switch and the phone-plan gate are all respected, and Spider texts count
  toward texting usage.
- **Admin-configured, per company.** The channels are switched on and off on Spider's settings,
  not in the Automation Center, so an admin who wants Spider quiet on email or text turns that
  channel off there.

The same exception covers Spider's starting summary (#2794, 17 Oct 2026): when Spider starts
watching something new, the sweep reports the backlog already past its limit once per person,
through the same delivery module, senders, brakes and texting-usage count, alongside a
`spider.starting_summary` bell row (duty, time-driven, classified beside `spider.alert`).

The code is `backend/src/services/spider/`. Nothing else in the product gains a second path to
email or text through this addendum.

## See also

- [0001 - Gate the automation engine at the point of effect](0001-gate-automation-engine-at-point-of-effect.md),
  the other automation-engine ADR. The two are complementary: 0001 says the engine must check
  entitlement where the effect happens rather than where the request arrives; this one says which
  effects are the engine's to have in the first place.
- [[CONTEXT.md#notification-family-of-an-in-app-verb]] and [[CONTEXT.md#rule-0-of-notifications]]
  for the vocabulary, and [[CONTEXT.md#send-of-a-workflow-step]] for what a step's delivery
  outcome now means.
- `md_files/specs/notifications/notification-scenarios-reference.md` for the per-verb matrix.
