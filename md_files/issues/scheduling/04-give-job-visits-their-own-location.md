# Give job visits their own location

**Type:** AFK
**User stories covered:** 5, 9, 11

## Parent

Spec: `md_files/specs/scheduling/2026-09-10-visit-location-and-performer-phone.md`

## What to build

The same capability on the job side, under its own name.

The column is already there — it is on the shared visit table, created in slice 1 — so this
slice is two more doors, one more dialog and one more merge field.

**The doors are `POST /jobs/:id/visits` and `PATCH /jobs/:id/visits/:visitId`**, using the
shared validation helper slice 3 extracted. The PATCH door is the one to be careful with: it
is a reschedule, callers routinely send only a time window, and "omitted means unchanged" has
to hold or moving a job visit by an hour silently sends the crew to the customer's address
instead of the yard.

**A fifth path creates visits and deliberately gets no change.** `POST /jobs/:id/assign`
first-books through `syncJobWindowOntoVisits`. A visit it creates leaves both columns null,
which derives to the service address, which is exactly today's behaviour. Confirm this rather
than modifying it — the goal is that first-booking is unaffected, and a test saying so is
worth more than a change.

**The UI is `frontend/src/pages/v2/jobs/components/visitScheduleDialog.tsx`**, gaining the
same control as the lead side.

**The merge field is `job.visit_location`, labelled "Job visit location".** Different wording
from the lead side's "Walkthrough location", and that is deliberate: ServWave's vocabulary
distinguishes a walkthrough from a job visit, so the field list does too. Note this departs
from the existing pair `lead.address` / `job.address`, which are *both* labelled "Service
address" because they genuinely do mean the same thing. These two do not.

The `job.` prefix puts it in the "Job" group automatically. Resolution follows slice 1
exactly, including the fallback chain — company location, else the one-off address, else **the
same service-address string `job.address` already resolves to**, never an empty string, never
`?? ''`.

## Acceptance

- A job visit booked at a company location renders that location in a job automation's email.
- Rescheduling a job visit's window with no location in the payload leaves the location alone.
- First-booking through `POST /jobs/:id/assign` produces a visit at the service address, as
  it does today.
- The job visit location merge field falls back to the job's service address, not to empty.
- The chip appears in the "Job" group of the field picker.
- Both job doors reject cross-tenant location ids and reject a location id sent together with
  a one-off address — the same helper, so the same behaviour as the lead side.
- A location referenced by a *job* visit is as undeletable as one referenced by a walkthrough:
  the 409 guard counts both.

## Out of scope for this slice

The phone fields (slice 5), the read surfaces (slice 6).
