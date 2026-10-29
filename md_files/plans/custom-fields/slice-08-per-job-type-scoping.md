# Slice 8 - Per-job-type field scoping

**Parent:** SRVW-115 · **Type:** HITL · **Blocked by:** Slice 6
**Not approved to start.** Needs an architectural decision from Ran before any code.

## Why this is HITL

Workiz scopes custom fields per job type, so an HVAC install job shows different fields than a
plumbing repair. ServWave cannot do that safely today, because **job types are not a model**. They
are a JSON string array on `Organization` (`job_type_options`, with a hardcoded default list), and
jobs and leads store the type as a free string. There is no `JobType` table and no referential
integrity anywhere.

So scoping a field to a job type means storing a **string** in the definition. Rename "HVAC Install"
to "HVAC Installation" in Settings and every field scoped to it silently stops appearing. No error,
no migration, no trace. Which is the same class of silent-wrongness as the SRVW-89 sort bug.

## The decision Ran owns

**Option A - promote job types to a real table.** Add a `JobType` model, org-scoped, migrate the
existing string arrays, repoint the readers. Scoping then has referential integrity and rename is
safe. Real blast radius: leads, jobs, both form pages, list filters, the settings editor and reports
all read the string today. This is its own body of work, plausibly larger than the scoping feature.

**Option B - scope on the string, accept rename breakage.** Cheapest path. Mitigate by warning on
rename, or by rewriting scoped definitions when a job type is renamed through the settings UI, which
covers the UI path but not direct data edits.

**Option C - drop per-job-type scoping.** SRVW-115 lists it as one criterion among five. If the other
four carry the card's value, this one can be consciously declined the way the custom report builder
was in SRVW-179.

## Acceptance criteria

- [ ] Ran picks A, B or C, and the decision is recorded on SRVW-115 with its reasoning
- [ ] If A: `JobType` model exists, string arrays migrated with no data loss, every reader repointed, no free-string job type left in leads or jobs
- [ ] If B: rename either warns or rewrites scoped definitions, and the residual breakage is documented in the card
- [ ] If A or B: a field scoped to a job type appears only on records of that type, and unscoped fields appear on all of them
- [ ] If A or B: changing a record's job type re-evaluates which fields render, without destroying values already stored for the previous type
- [ ] If C: SRVW-115 is updated to record the declined criterion, and no code is written

## Blocked by

- Slice 6 (MVP complete)
- A decision from Ran on the three options above
