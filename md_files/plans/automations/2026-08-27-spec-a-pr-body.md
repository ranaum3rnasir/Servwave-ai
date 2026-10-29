In-app notifications become rule-governed; the Automation Center owns email and text.

Spec A, slices 1 to 7, of https://github.com/ranro1/ALPHA_CRM/issues/1850.

The bell is now the only place in-app notifications come from, and it decides who hears
about what by rule rather than by whichever call site happened to fire. The Automation
Center keeps email and text, and stops offering the in-app step that duplicated the bell.

## What changed, slice by slice

**1. Every bell verb is classified, and the self exemption is a mechanism.** The
notification registry's 61 literal keys were being erased by a `Record<string,
TemplateFactory>` annotation, so nothing could be declared exhaustively over the verbs.
That annotation becomes a trailing `satisfies` clause and `VERB_RULES` lands beside the
registry: every verb declares a family (involvement / duty / self) and a timing (event /
time), typed `Record<KnownVerb, VerbRule>`, so a missing entry and a stray entry are both
compile errors. Rule 0 - never tell someone about their own action - keeps its single home
at `dedupe()`, but its one named exception now has a mechanism behind it:
`resolveRecipients` consults the family and passes a null actor for `self` verbs, so a
security alert still reaches the account holder even when they are the actor.

**2. The automation engine drops the actor.** An automation no longer emails the person
whose action triggered it. The actor rides in `workflow_enrollments.event_payload` as
`actorId`, which is an unknown JSON key to any older build and ignored in both directions.

**3. An unrecognised step type reports an issue instead of 500ing.** The read path for a
workflow holding a step type the current build does not know now surfaces a validation
issue against that step. The list and detail pages keep loading, which is what makes every
retirement below a reported issue rather than an outage.

**4 and 5. The in-app step stops being offered, and cannot be published.** The step picker
entry goes from both builder trees, and five prebuilt gallery templates that installed an
in-app workflow in one click are deleted (invoice-paid-office, tech-assignment-alert,
tech-day-before, estimate-approved-office, new-lead-alert). Eleven templates remain across
customer and money. Both pickers carry a note saying why there is no in-app option, so the
entry is not restored by someone reading the list as accidentally short. The dead forms and
the dead v1 home go with them, and each deleted component's test is deleted with it rather
than left green asserting a deleted feature.

`GET /api/workflows/catalog` stops serving the action too. `ACTIONS` and `AUDIENCES` were
keyed by the Prisma enum, so the retired action stayed on the builder's menu with its copy
rewritten to say it no longer sends - which is still an offer, however carefully it is
worded. Both maps, `recipientsFor`, `audiencesFor`, a template's `action_type` and the
frontend's mirror of the payload are now keyed by a hand-written *authorable* action type,
the enum minus the retired label, exactly as the step types are. The audience rule that
dropped `customer` for the retired action goes with it: nothing can reach that code any
more. Two casts stopped being able to lie in the process - `Object.keys(ACTIONS) as …` and
the `{} as Record<…>` the audience map is built through both name the authorable union now,
and the served key set is asserted per trigger rather than trusted.

And the publish door gets its own words. A draft that already holds an in-app step used to
be refused by accident, through the generic "no longer supported" message, because the step
simply had no config schema left. `validateStep` now refuses it deliberately, at the very
top, ahead of the schema lookup, so the sentence an admin reads names the step's position
and says where in-app notifications come from now. Deleting that step publishes the same
workflow on the next attempt with nothing else changed.

**6. Authoring the retired step is now a compile error.** A hand-written *authorable* step
type - the storage enum minus the retired label - spans every surface that creates,
validates or offers a step: the backend config-schema map, the frontend step-type union, the
default-config factory, the step sentence, the gallery-install fold and the frontend
`stepSchemas.ts` registry. The API write DTO is deliberately NOT one of them: the draft tier
still spans the storage enum, so a workflow that already holds a legacy step stays saveable
and duplicable, and publishing is the one door that refuses it. The paragraph under "The
rollback property" below has the argument. Rendering surfaces deliberately keep the full
union, because a historical run must still display its label and icon.

**7. The decision is written down, and the stale catalogues are repaired.** ADR 0005,
`docs/adr/0005-the-bell-is-hardcoded-the-automation-center-owns-email-and-text.md`, records the
rule the six slices above enforce: each channel has exactly one owner, the bell is hardcoded and
rule-governed by family and timing, and the Automation Center owns email and text. It comes last
on purpose - every sentence in it was false until the in-app step actually left the builder. Its
consequences are stated precisely rather than sweepingly: a workflow RUN can no longer notify
in-app, but the Test dialog's send-to-me receipt still emits `automation.message` to the person
who pressed Test, so no sentence claims the Automation Center never writes to the bell, which the
first grep for that verb would disprove. The file also states the ADR numbering convention it
applied, because the next free number is genuinely ambiguous: `0003` has never existed on any ref
and `0004` is used twice, and it deliberately does not renumber the duplicate.

Two new CONTEXT.md entries give the branch its vocabulary. **Notification family** defines the
three-way involvement / duty / self split, the orthogonal event / time timing axis, and why timing
is an axis rather than a fourth family - arriving via cron changed nothing about *who* was told.
**Rule 0** states the rule itself, never tell someone about their own action, names both places it
is enforced exactly once (the bell at `dedupe()`, the engine at `dropActingUser`), and records the
`self` family as its single named exception. The existing **Send** entry drops the retired step
from its list of senders and folds it into the "suppressed before delivery" case that copy already
used, so the glossary and the skip copy read alike.

The two notification documents are rebuilt rather than patched.
`md_files/specs/notifications/notification-scenarios-reference.md` called itself the complete
catalogue and had drifted to 40 of the 61 verbs with no family axis; the matrix is rebuilt over all
61 with family and timing columns, checked row by row against `VERB_RULES`, and rule 1 now reads
"drop the actor when there is one" instead of asserting flatly that the actor never notifies
themselves. Its scope note splits authority out loud - `VERB_RULES` classifies the verb, family and
timing, and ADR 0005 decides which systems may write to the bell at all - so the two cannot drift
back into telling opposite stories about `automation.message`. Two corrections fell out of reading
the resolver rather than the templates: the pin is per-recipient, so refund, dispute and chargeback
interrupt without pinning, and `dispatch.job_created` has not been `urgent_job_created` for some
time. `md_files/plans/notifications/qa-checklist.md` names the family each core-routing check
exercises, gives the self exception its own check (a password change you made yourself must still
reach you), and adds a Channel ownership section of five checks. Two of them sat under a Blocked
heading while the legacy-step neutralisation was still unbuilt; the run-path work later in this
branch released them, so all five are runnable and a failure on any of them is a regression rather
than unbuilt work. `md_files/specs/ui-redesign/automations-behavior-map.md` keeps all five of its
`NOTIFY_TEAM` references untouched behind one dated note: it is a design record of the v2 redesign,
not a live contract, and rewriting it would falsify a historical account.

## The rollback property

**A code-only rollback of the in-app step retirement is possible, because no slice in the
sequence carries a migration.** Reverting the branch and redeploying the previous build
restores the previous behaviour exactly. There is no data step to undo and no forward-only
fence to cross.

What makes it true:

- **`backend/prisma/` is untouched across the whole branch.** No migration file is added and
  `schema.prisma` is not edited. The check is one command, and it should print nothing:
  `git diff --name-only "$(git merge-base origin/main HEAD)..HEAD" -- backend/prisma/`.
  Use the merge base rather than a literal SHA: `main` moves, and diffing against its tip
  reports migrations `main` gained after the branch point as if this branch had deleted
  them.
- **The Postgres enum keeps all five labels**, `NOTIFY_TEAM` included. The retirement narrows
  a hand-written *authorable* step type in TypeScript only. Storage is unchanged, so every
  row keeps the label it already carries: the mutable `workflow_steps` rows, the historical
  `workflow_step_runs.step_type` ledger, and the frozen `workflow_versions.definition` JSON
  that stores the label as a plain string.
- **Rows written while the retirement is live are readable by the old build.** The sequence
  adds no column, no enum value and no rewritten row. A neutralised legacy step records an
  ordinary `SKIPPED` step run whose only new content is its `detail` string, which the
  reverted build renders like any other skipped row. The `actorId` that slice 2 adds to
  `workflow_enrollments.event_payload` is an unknown JSON key to the old build and is
  ignored in both directions.

What an organization still holding a legacy in-app step sees, said plainly because it is a
behaviour change and not only a type change, and because it lands on a page nobody asked to
have changed. `validateWorkflowDefinition` runs on every READ of a workflow, not only at
publish, so the day this ships an organisation that has not touched its automations sees a
new issue on the automations list against a workflow it did not edit. That is the right
place for it - it is where the step gets deleted - but it is unprompted, so it belongs here
rather than in a support ticket.

The issue reads `Step 2 no longer sends. In-app notifications now come from the bell, so
remove this step to publish this automation.`, with the position naming the offending step.
The automations list and detail page still load (the read-path guard from slice 3 is what
makes that a reported issue rather than a 500), publishing is blocked until the step is
removed, and opening the step shows the same message as a read-only notice in the config
drawer instead of an audience picker with nothing in it. Publishing is the ONLY blocked
action: the draft write tier still spans the storage enum, so editing another step of that
workflow saves as usual and duplicating it still copies. It has to - the builder re-sends
every step it hydrated on each autosave, so a write tier that refused the retired label
would block every save on the workflow, and would say so in the schema's words rather than
the sentence above. Already-published versions are untouched and keep running - a legacy
step in one is neutralised at run time, not rejected.
This is still a code-only rollback: the previous build reads the same rows and validates
them the old way.

Measured population: 8 draft steps across 2 organisations in production, every containing
workflow disabled and 0 published versions; 4 draft steps and 1 published version on
staging.

Two standing checks keep this a checked property rather than a claim in a PR body. The
`WorkflowStepType is exactly the five step kinds` assertion in `workflowSchema.test.ts` is
carried over untouched, so dropping the storage label goes red; the branch adds its
authorable-union counterpart beside it rather than editing it. And the empty
`backend/prisma/` diff above is a one-command check any reviewer can repeat.

What a rollback does not undo, said plainly so nobody expects it to: messages sent or
withheld while the new build was running. That is behaviour already delivered, not a shape a
rollback can reach.

**What would end this property.** Narrowing the Postgres enum - the literal reading of
"removed from the step-type union" that the A/06 decision deliberately did not take. That is
an enum rebuild on the `20260819220000_jobstatus_retire_en_route_on_site` precedent: it has
to rewrite two dependent columns plus the frozen version JSON, in one destructive migration
no code rollback can undo. It also breaks the step-run claim insert in `advanceEnrollment`,
which writes `step.step_type` into the enum column *before* the step is dispatched, so a
dropped label strands the enrollment in a loop with no ledger row. The property is not an
accident of how the slices happened to be sequenced; it is the direct consequence of keeping
the storage label, and it is the thing to weigh against the enum rebuild the first time one
is proposed. The full argument is in
`md_files/plans/automations/2026-08-27-spec-a-retirement-rollback-property.md`.

## Reviewing

- No migration: `git diff --name-only "$(git merge-base origin/main HEAD)..HEAD" -- backend/prisma/`
  prints nothing.
- Backend: `cd backend && VITEST_MAX_WORKERS=1 npx vitest run src/services/notifications src/services/automations src/controllers/__tests__` and `npx tsc --noEmit`.
- Frontend: `cd frontend && npx tsc -b --force` and `VITEST_MAX_WORKERS=1 npx vitest run src/lib/workflows src/components/workflows src/pages/v2/automations`.
- Coverage note, so nobody later reads the drop as a regression: deleting the unrouted v1
  `WorkflowsHome` took its test with it, and that test held the only component-level gallery
  coverage. Those invariants are now asserted backend-side, in
  `backend/src/services/automations/__tests__/catalog.test.ts` - the served gallery's shape and
  unique keys, that every template validates end to end against the catalog, and that no prebuilt
  template installs an in-app step.
- The retirement guards are meant to be attacked. Put the retired label back into either
  config-schema map, the frontend step-type union, the default-config factory, the step
  sentence, the gallery-install fold, `frontend/src/lib/workflows/stepSchemas.ts`, the
  `ACTIONS` record, the `AUDIENCES` map or a gallery template's `action_type`, and the
  affected package must stop compiling. The draft write DTO is deliberately not on that
  list - it spans the storage enum on purpose - and `backend/src/__tests__/workflows.test.ts`
  pins both doors: a legacy step saves, and publishing it is refused.
