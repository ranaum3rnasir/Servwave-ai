# Slice 4 - Values survive lead to job conversion

**Parent:** SRVW-114 · **Type:** AFK · **Blocked by:** Slice 3

## What to build

The SRVW-114 acceptance criterion "values survive lead -> job conversion". When a job is created from
a lead, every custom-field value on that lead whose definition **also** lists JOB is copied onto the
new job.

**The structural fact this slice turns on:** `Job` has no `lead_id`. The lead link runs through
`estimate.lead_id`, and the only Convert-to-Job path in the UI requires a WON estimate. So the copy
happens inside the create-job-from-estimate transaction, at the point where the lead is already being
resolved for the existing email-attribution backfill. There is no direct lead-to-job edge to hook.

Rules:

* Copy only definitions scoped to both LEAD and JOB. A lead-only field does not leak onto the job.
* Never overwrite a value already present on the job.
* Copy inside the transaction, so a job never exists without its inherited values.
* Multi-estimate conversion resolves to one lead already (the controller rejects a mixed set), so
  there is exactly one source lead or none.
* A leadless conversion is a no-op, not an error.

## Acceptance criteria

- [ ] Converting a lead with custom-field values produces a job carrying every value whose definition lists both LEAD and JOB
- [ ] Lead-only definitions are not copied
- [ ] A value already set on the job is not overwritten by the lead's value
- [ ] Conversion from an estimate with no lead succeeds and writes nothing
- [ ] The copy is inside the creating transaction: a forced failure after the copy leaves no job and no partial values
- [ ] Multi-estimate conversion copies from the single shared lead exactly once
- [ ] Backend written test-first; `npx tsc --noEmit` and `npm test --workspace=backend` both clean

## Notes

Distinct from the neighbouring email backfill, which is deliberately fire-and-forget outside the
transaction. Custom-field carry-over is **not** fire-and-forget: a job that silently loses the gate
code the customer gave at lead intake is exactly the failure this feature exists to prevent.

## Blocked by

- Slice 3 (Lead and Customer entities)
