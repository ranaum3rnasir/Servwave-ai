# Rollback note - the in-app step retirement is code-only

Spec A, slice 6. Ships with the branch `feat/notification-ground-rules`.

Slice 6 asks for this property to be recorded in the PR description. The wording that goes
into the PR body now lives in [2026-08-27-spec-a-pr-body.md](2026-08-27-spec-a-pr-body.md),
under "The rollback property", so there is one copy of it rather than two to drift apart.
That file is the entire PR body, paste-ready:

```sh
gh pr create --base staging --head feat/notification-ground-rules \
  --title "feat(automations): in-app notifications become rule-governed (Spec A slices 1-7)" \
  --body-file md_files/plans/automations/2026-08-27-spec-a-pr-body.md
```

This note is why the property is worth recording at all, which the PR body cannot carry
without turning into an essay. Keeping it in the repo also means the property survives the
PR being squashed and forgotten, which is exactly the failure it is meant to prevent: right
now the safety property is implicit, and it would be lost the first time someone proposes the
enum rebuild.

## The property in one line

A code-only rollback of the in-app step retirement is possible, because no slice in the
sequence carries a migration. Reverting the branch and redeploying the previous build
restores the previous behaviour exactly. There is no data step to undo and no forward-only
fence to cross.

The one-command check, which should print nothing:

```sh
git diff --name-only "$(git merge-base origin/main HEAD)..HEAD" -- backend/prisma/
```

Use the merge base, not a literal SHA and not `origin/main` itself. `main` moves: diffing
against its tip reports migrations `main` gained *after* the branch point as deletions this
branch made, which reads as though the branch had ripped a migration out. Measured on
2026-08-27, `origin/main` had already moved one migration past the branch point, so the
literal-SHA form this note first carried was one merge away from lying.

## Why it holds, and what it costs

The Postgres enum keeps all five labels, `NOTIFY_TEAM` included, because storage outlives
authoring. The retirement narrows a hand-written *authorable* step type in TypeScript only,
so every stored row keeps the label it already carries: the mutable `workflow_steps` rows,
the historical `workflow_step_runs.step_type` ledger, and the frozen
`workflow_versions.definition` JSON that stores the label as a plain string. Nothing the new
build writes is unreadable to the old one either: no column, no enum value and no rewritten
row is added.

The cost is that the retirement is a behaviour change for an organization still holding a
legacy in-app step, not only a type change, and the PR body says so plainly rather than
implying it. That paragraph is the one a reviewer is most likely to want, which is another
reason it lives in the body and not here.

Two standing checks keep this a checked property rather than a claim in a PR body. The
`WorkflowStepType is exactly the five step kinds` assertion in `workflowSchema.test.ts` is
carried over untouched, so dropping the storage label goes red; the branch adds its
authorable-union counterpart beside it rather than editing it. And the empty
`backend/prisma/` diff above is a one-command check any reviewer can repeat.

What a rollback does not undo, said plainly so nobody expects it to: messages sent or
withheld while the new build was running. That is behaviour already delivered, not a shape a
rollback can reach.

## What would end this property

Narrowing the Postgres enum - the literal reading of "removed from the step-type union" that
the A/06 decision deliberately did not take. That is an enum rebuild on the
`20260819220000_jobstatus_retire_en_route_on_site` precedent: it has to rewrite two dependent
columns plus the frozen version JSON, in one destructive migration no code rollback can undo.
It also breaks the step-run claim insert in `advanceEnrollment`, which writes
`step.step_type` into the enum column *before* the step is dispatched, so a dropped label
strands the enrollment in a loop with no ledger row - destroying the neutralisation behaviour
user story 23 asks for.

The property is therefore not an accident of how the slices happened to be sequenced. It is
the direct consequence of keeping the storage label, and it is the thing to weigh against the
enum rebuild the first time one is proposed.
