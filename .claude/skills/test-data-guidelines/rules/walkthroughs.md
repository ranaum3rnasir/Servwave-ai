# Walkthrough Test Data Rules

Walkthroughs exist in two independent contexts: **lead walkthroughs** (pre-sale site inspection) and **job walkthroughs** (urgent job documentation). They share field names but have different lifecycles, constraints, and purposes.

---

## 1. Lead Walkthrough — Status State Machine

Lead walkthroughs are embedded in the Lead status machine:

```
CONTACTED → WALKTHROUGH_SCHEDULED → WALKTHROUGH_COMPLETED → (continue to ESTIMATED)
                     ↓
              CANCELLED (reverts to CONTACTED)
                     ↓
              Can reschedule → WALKTHROUGH_SCHEDULED again
```

WALKTHROUGH_COMPLETED can also reschedule (back to WALKTHROUGH_SCHEDULED).

---

## 2. Lead Walkthrough — Required Fields Per Status

| Lead Status | Required Walkthrough Fields | Must Be Null |
|------------|---------------------------|-------------|
| NEW | (none) | All walkthrough fields |
| CONTACTED | (none, walkthrough not yet scheduled) | walkthrough_scheduled_at, walkthrough_completed_at |
| WALKTHROUGH_SCHEDULED | `walkthrough_scheduled_at`, `walkthrough_assigned_to` (SALES or TECHNICIAN), `walkthrough_duration_minutes` (15-480, default 60) | `walkthrough_completed_at` |
| WALKTHROUGH_COMPLETED | `walkthrough_completed_at` | (schedule fields remain as history) |

After cancellation (reverts to CONTACTED):

| Field | Value |
|-------|-------|
| `walkthrough_scheduled_at` | null (cleared) |
| `walkthrough_assigned_to` | remains (historical) |
| `walkthrough_duration_minutes` | remains (historical) |
| `walkthrough_cancelled_at` | set |
| `walkthrough_cancelled_reason` | set (1-2000 chars) |
| `walkthrough_cancelled_by` | set (user who cancelled) |
| `walkthrough_needed` | reset to true |

On reschedule, the cancelled fields are cleared.

---

## 3. Lead Walkthrough — Duration Constraints

| Constraint | Value | Source |
|-----------|-------|--------|
| Minimum | **15 minutes** | `lead.controller.ts:175` |
| Maximum | **480 minutes** (8 hours) | `lead.controller.ts:175` |
| Default | **60 minutes** | `lead.controller.ts:190` |

Realistic durations by scenario:
- Quick residential inspection: 30-60 min
- Standard residential walkthrough: 60-90 min
- Large residential (multi-system): 90-120 min
- Small commercial: 60-120 min
- Large commercial / multi-unit: 120-240 min
- Full building survey: 240-480 min

---

## 4. Lead Walkthrough — Performer Rules

| Constraint | Rule | Source |
|-----------|------|--------|
| Valid performer roles | **SALES** or **TECHNICIAN** only | `lead.controller.ts:696` |
| DISPATCHER as performer | NOT allowed | `lead.controller.ts:696` |
| ADMIN as performer | NOT allowed | `lead.controller.ts:696` |
| Performer must be active | `is_active: true` | `lead.controller.ts:692` |

---

## 5. Lead Walkthrough — Scheduling Permissions

| Action | ADMIN | SALES | DISPATCHER | TECHNICIAN |
|--------|:-----:|:-----:|:----------:|:----------:|
| Schedule walkthrough | x | x (own leads) | x | |
| Complete walkthrough | x | x (if performer) | x | x (if performer) |
| Cancel walkthrough | x | x (own leads) | x | |
| Update notes/duration | x | x (owner or performer) | x | x (if performer) |
| Be assigned as performer | | x | | x |

---

## 6. Lead Walkthrough — Conflict Detection

When scheduling, the system checks the performer's existing commitments:

1. **Job conflicts:** All SCHEDULED or IN_PROGRESS jobs assigned to the performer
2. **Walkthrough conflicts:** All WALKTHROUGH_SCHEDULED walkthroughs on other leads assigned to the performer

**Overlap formula:** `existingStart < newEnd AND existingEnd > newStart`

Where:
- `newStart` = `walkthrough_scheduled_at`
- `newEnd` = `walkthrough_scheduled_at + walkthrough_duration_minutes`
- For existing walkthroughs without explicit end: uses `(walkthrough_duration_minutes || 60) * 60_000`

**Force override:** `force: true` bypasses all conflict checks.

**Test data implications:**
- Two walkthroughs for the same performer must NOT overlap (unless `force` was used)
- A walkthrough and a job for the same tech must NOT overlap
- When testing conflicts, create overlapping time windows; when testing normal flow, ensure gaps

---

## 7. Lead Walkthrough — Status Guards

| Action | Allowed From Status | Source |
|--------|-------------------|--------|
| Schedule | CONTACTED, WALKTHROUGH_COMPLETED, WALKTHROUGH_SCHEDULED (reschedule) | `lead.controller.ts:680` |
| Complete | WALKTHROUGH_SCHEDULED only | `lead.controller.ts:805` |
| Cancel | WALKTHROUGH_SCHEDULED only | `lead.controller.ts:856` |

**Cannot schedule from:** NEW (must contact first), ESTIMATED, WON, LOST, CANCELLED

---

## 8. Lead Walkthrough — Estimate Send Guard

An estimate **cannot be sent** while the lead is in WALKTHROUGH_SCHEDULED status. The walkthrough must be completed or cancelled first.

**Source:** `estimate.controller.ts` (walkthrough guard on send)

**Test data implication:** If creating a SENT estimate, the lead must NOT be WALKTHROUGH_SCHEDULED at the time of sending. It must be at least WALKTHROUGH_COMPLETED or CONTACTED (with `walkthrough_needed: false`).

---

## 9. Lead Walkthrough — Cascade on Lead Cancellation

When a lead is cancelled while in WALKTHROUGH_SCHEDULED status:
- `walkthrough_scheduled_at` → null
- `walkthrough_cancelled_at` → current time
- `walkthrough_cancelled_reason` → "Lead cancelled"
- `walkthrough_needed` → true
- Status reverts logic is skipped (lead goes straight to CANCELLED)

---

## 10. Job Walkthrough — Rules

Job walkthroughs are **completion-only** — there is no scheduling step. They exist only for **urgent jobs** as on-site documentation.

| Constraint | Rule | Source |
|-----------|------|--------|
| Only for urgent jobs | `is_urgent: true` required | `job.controller.ts:1325` |
| Notes required | 1-5000 characters | `job.controller.ts:1309` |
| Performer | Auto-set to current user | `job.controller.ts:1344` |
| Completion time | Auto-set to `new Date()` | `job.controller.ts:1343` |
| Role access | ADMIN, DISPATCHER, TECHNICIAN (not SALES) | `job.routes.ts:39` |
| TECHNICIAN guard | Must be assigned to the job | `job.controller.ts:1332` |

**Standard jobs do NOT have job-level walkthroughs.** Their walkthrough data comes from the lead.

### Job Walkthrough Fields

| Field | Type | When Set |
|-------|------|----------|
| `walkthrough_notes` | string (1-5000) | On completion |
| `walkthrough_completed_at` | DateTime | Auto-set on completion |
| `walkthrough_assigned_to` | UUID | Auto-set to current user |

---

## 11. Invalid Data for Testing

| # | Violation | Description | Expected Result |
|---|-----------|------------|-----------------|
| W-01 | WALKTHROUGH_SCHEDULED without walkthrough_scheduled_at | Missing schedule time | Impossible state |
| W-02 | WALKTHROUGH_SCHEDULED without walkthrough_assigned_to | No performer assigned | Impossible state |
| W-03 | WALKTHROUGH_SCHEDULED with DISPATCHER as performer | Invalid performer role | Should fail |
| W-04 | WALKTHROUGH_SCHEDULED with ADMIN as performer | Invalid performer role | Should fail |
| W-05 | walkthrough_duration_minutes: 10 | Below minimum (15) | Should fail validation |
| W-06 | walkthrough_duration_minutes: 500 | Above maximum (480) | Should fail validation |
| W-07 | walkthrough_completed_at < walkthrough_scheduled_at | Completed before scheduled | Temporal violation |
| W-08 | Complete from status NEW | Wrong starting status | Should fail guard |
| W-09 | Complete from status CONTACTED | Not yet scheduled | Should fail guard |
| W-10 | Schedule from status NEW | Must contact first | Should fail guard |
| W-11 | Schedule from status WON | Terminal-adjacent status | Should fail guard |
| W-12 | Cancel from status CONTACTED | Not currently scheduled | Should fail guard |
| W-13 | Overlapping walkthroughs for same performer | Time conflict | Should fail (409) unless force |
| W-14 | Walkthrough overlapping with scheduled job for same performer | Cross-entity conflict | Should fail (409) unless force |
| W-15 | TECHNICIAN scheduling a walkthrough | Role not allowed to schedule | Should fail authorization |
| W-16 | SALES scheduling on another sales rep's lead | Not lead owner | Should fail permission |
| W-17 | Job walkthrough on non-urgent job | Standard jobs use lead walkthrough | Should fail (400) |
| W-18 | Job walkthrough with empty notes | Notes required (min 1 char) | Should fail validation |
| W-19 | Job walkthrough notes > 5000 chars | Exceeds max length | Should fail validation |
| W-20 | SALES recording job walkthrough | Role not allowed | Should fail authorization |
| W-21 | Send estimate while lead is WALKTHROUGH_SCHEDULED | Estimate send guard | Should fail (400) |
| W-22 | Inactive user as walkthrough performer | Must be active | Should fail |
| W-23 | walkthrough_cancelled_reason empty string | Must be 1-2000 chars | Should fail validation |
| W-24 | walkthrough_cancelled_reason > 2000 chars | Exceeds max | Should fail validation |
