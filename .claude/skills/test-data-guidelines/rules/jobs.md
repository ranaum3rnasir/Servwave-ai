# Job & JobCharge — Test Data Rules

## 1. Status State Machine

```
UNASSIGNED → SCHEDULED → IN_PROGRESS → COMPLETED
                                     \→ CANCELLED
UNASSIGNED → CANCELLED
SCHEDULED → UNASSIGNED (via unassign)
SCHEDULED → CANCELLED
```

## 2. Required Fields Per Status

| Status | Required Fields | Must Be Null |
|--------|----------------|-------------|
| UNASSIGNED | customer_id, service_location_id | assigned_to, scheduled_start, scheduled_end, started_at, completed_at, completion_notes, cancelled_at, cancelled_reason |
| SCHEDULED | +assigned_to (TECHNICIAN role), +scheduled_start, +scheduled_end | started_at, completed_at, completion_notes, cancelled_at, cancelled_reason |
| IN_PROGRESS | +started_at | completed_at, completion_notes, cancelled_at, cancelled_reason |
| COMPLETED | +completed_at, +completion_notes (1-5000 chars) | cancelled_at, cancelled_reason |
| CANCELLED | +cancelled_at, +cancelled_reason | completed_at, completion_notes (if cancelled before starting) |

**CRITICAL: A COMPLETED job MUST have assigned_to populated. Someone must have done the work.**

**CRITICAL: A COMPLETED job MUST have completion_notes. The tech must document what was done.**

## 3. Job Source Rules

**Standard flow** (from estimate):
- `estimate_id`: Set (must be an APPROVED estimate)
- `is_urgent`: false
- `urgency_reason`: null
- Estimate's deposit must be PAID or VOIDED before job can be created
- Scope comes from estimate line items

**Urgent flow** (no estimate):
- `estimate_id`: null
- `is_urgent`: true
- `urgency_reason`: Required (e.g., "Pipe burst flooding basement", "No heat with elderly resident")
- Scope described in `scope_notes`
- May have `charges[]` (JobCharge) instead of estimate line items

**NEVER combine**: `is_urgent: true` with `estimate_id` set, or `is_urgent: false` with `estimate_id: null` (for non-urgent jobs).

## 4. Scheduling Constraints

- `scheduled_start` < `scheduled_end` (always)
- Typical duration: 1-8 hours for standard jobs
- `is_all_day: true`: scheduled_start/end span a full day
- `estimated_duration`: in minutes, reflects expected work time
- `assigned_to` MUST reference a user with role TECHNICIAN — never SALES or DISPATCHER
- Calendar conflict detection: API checks for overlapping schedules on same technician (SCHEDULED/IN_PROGRESS jobs + walkthroughs). Use `force=true` to bypass in tests when needed.

Realistic scheduling patterns:
- Standard residential: 2-4 hour window (e.g., 09:00-13:00)
- Commercial maintenance: 4-8 hours (e.g., 07:00-15:00)
- Urgent repair: 1-3 hours
- All-day: Full day projects, installations

## 5. JobCharge Rules (Urgent Jobs Only)

Only relevant for urgent jobs (no estimate → no pre-defined line items).

| Field | Required | Constraints |
|-------|----------|-------------|
| sequence | Yes | Sequential starting at 1 |
| description | Yes | Realistic work description |
| quantity | Yes | Positive number |
| unit_price | Yes | >= 0, Decimal(12,2) |
| is_taxable | Yes | boolean |
| line_total | Calculated | quantity x unit_price |

At least 1 charge should exist before creating an invoice from an urgent job.

## 6. Completion Notes Patterns

Completion notes should document what was actually done. Realistic examples:
- "Replaced evaporator coil (Trane XR15 compatible). Recharged system with 3 lbs R-410A. Tested cooling — output delta now 18F. System running normally."
- "Cleared kitchen drain blockage. Root intrusion found at main line junction. Recommended annual root treatment. Left camera inspection report with customer."
- "Replaced 40-gallon electric water heater with 50-gallon Rheem Performance Plus. Installed new expansion tank and updated supply lines. Tested hot water at all fixtures."
- "Diagnosed intermittent tripping on 20A kitchen circuit. Found loose neutral at panel bus. Tightened all connections, tested under load for 30 min. No further trips."

## 7. Walkthrough on Job

Jobs can have their own walkthrough data (independent of the lead walkthrough):
- `walkthrough_notes`: Observations during pre-job inspection
- `walkthrough_completed_at`: When job-level walkthrough was done
- `walkthrough_assigned_to`: Who performed it (SALES or TECHNICIAN)

## 8. Invalid Data for Testing

| # | Violation | Description | Expected Result |
|---|-----------|------------|-----------------|
| J-01 | COMPLETED without assigned_to | Who did the work? | Impossible state |
| J-02 | COMPLETED without completion_notes | Must document work | Should fail |
| J-03 | COMPLETED without completed_at | When did it finish? | Impossible state |
| J-04 | COMPLETED without started_at | Never started but completed? | Impossible state |
| J-05 | SCHEDULED with assigned_to → SALES user | Wrong role | Should fail |
| J-06 | SCHEDULED with assigned_to → DISPATCHER | Wrong role | Should fail |
| J-07 | IN_PROGRESS without started_at | When did work begin? | Impossible state |
| J-08 | scheduled_end < scheduled_start | End before start | Temporal violation |
| J-09 | started_at before scheduled_start by > 30 min | Suspicious early start | Edge case to test |
| J-10 | UNASSIGNED with scheduled_start set | Can't schedule without tech | Impossible state |
| J-11 | is_urgent=true with estimate_id set | Urgent jobs don't have estimates | Invalid combination |
| J-12 | is_urgent=false with estimate_id=null | Non-urgent without scope source | Invalid combination |
| J-13 | is_urgent=true without urgency_reason | Must explain urgency | Should fail |
| J-14 | completion_notes empty string or < 1 char | Too short | Should fail |
| J-15 | completion_notes > 5000 chars | Too long | Should fail |
| J-16 | Delete job that has an invoice | Cannot delete | Should fail |
| J-17 | Update COMPLETED job fields | Status is terminal for edits | Should fail |
| J-18 | completed_at < started_at | Completed before starting | Temporal violation |
