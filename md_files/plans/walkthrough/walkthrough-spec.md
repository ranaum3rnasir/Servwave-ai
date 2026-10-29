# Walkthrough Module — Complete Specification

## Overview
Walkthroughs are site visits conducted by Sales reps or Technicians before creating estimates. They are attached to Leads and carry photos, notes, and documentation that flow through to Estimates and Jobs.

---

## 1. Data Model Changes

### 1.1 LeadStatus Enum (Before → After)
**Before:** NEW, CONTACTED, ESTIMATING, WON, LOST, WALKTHROUGH_SCHEDULED, ESTIMATED, APPROVED, CANCELLED
**After:** NEW, CONTACTED, WALKTHROUGH_SCHEDULED, WALKTHROUGH_COMPLETED, ESTIMATED, WON, LOST, CANCELLED
- Removed: ESTIMATING (migrate to WALKTHROUGH_COMPLETED), APPROVED (merge into WON)
- Added: WALKTHROUGH_COMPLETED

### 1.2 Lead Model — New Fields
| Field | Type | Default | Notes |
|-------|------|---------|-------|
| lead_number | String | Auto: LEAD-YYYY-NNNN | Generated at creation, backfill existing |
| walkthrough_assigned_to | UUID? (FK User) | null | Defaults to assigned_to when scheduling |
| walkthrough_needed | Boolean | true | Locked when scheduled, unlocked on cancel |
| walkthrough_cancelled_at | DateTime? | null | |
| walkthrough_cancelled_reason | String? | null | Required when cancelling |
| walkthrough_cancelled_by | UUID? (FK User) | null | |
| contacted_at | DateTime? | null | Set via Mark as Contacted |
| contacted_note | String? | null | Optional note |

### 1.3 Job Model — New Fields (for urgent job walkthroughs)
| Field | Type | Notes |
|-------|------|-------|
| walkthrough_notes | String? | Separate from scope_notes |
| walkthrough_completed_at | DateTime? | Set server-side on save |
| walkthrough_assigned_to | UUID? (FK User) | Who documented the walkthrough |

### 1.4 Attachment Model — New Fields
| Field | Type | Default | Notes |
|-------|------|---------|-------|
| display_name | String (required) | — | User-provided name |
| description | String (required) | — | User-provided description |
| context | Enum | OTHER | WALKTHROUGH, JOB_WORK, ESTIMATE, OTHER |

**Migration for existing attachments:** display_name = filename, description = '', context = OTHER

### 1.5 New Prisma Enum: AttachmentContext
```
enum AttachmentContext {
  WALKTHROUGH
  JOB_WORK
  ESTIMATE
  OTHER
}
```

---

## 2. Status Lifecycle

### 2.1 Complete Transition Map
```
NEW → CONTACTED                    (manual: "Mark as Contacted" button)
CONTACTED → WALKTHROUGH_SCHEDULED  (auto: when walkthrough_scheduled_at is set)
CONTACTED → ESTIMATED              (auto: when estimate is SENT — skip-walkthrough path)
CONTACTED → LOST                   (manual: "Mark Lost")
CONTACTED → CANCELLED              (manual: "Cancel Lead")

WALKTHROUGH_SCHEDULED → WALKTHROUGH_COMPLETED  (explicit: "Complete Walkthrough" click)
WALKTHROUGH_SCHEDULED → CONTACTED              (walkthrough cancelled: clears schedule, sends emails)
WALKTHROUGH_SCHEDULED → LOST                   (auto-cancels walkthrough + emails)
WALKTHROUGH_SCHEDULED → CANCELLED              (auto-cancels walkthrough + emails)

WALKTHROUGH_COMPLETED → ESTIMATED              (auto: when estimate is SENT)
WALKTHROUGH_COMPLETED → WALKTHROUGH_SCHEDULED  (re-schedule another visit)
WALKTHROUGH_COMPLETED → LOST                   (manual)
WALKTHROUGH_COMPLETED → CANCELLED              (manual)

ESTIMATED → WON                    (auto: when estimate APPROVED by customer)
ESTIMATED → LOST                   (manual: estimate declined / no opportunity)
ESTIMATED → CANCELLED              (manual)

WON → (terminal, no transitions out)
LOST → (terminal, no transitions out)
CANCELLED → (terminal, no transitions out)
```

### 2.2 Invalid Transitions
- NEW → WALKTHROUGH_SCHEDULED (must contact first)
- WALKTHROUGH_SCHEDULED → ESTIMATED (must complete or cancel walkthrough first)
- WON → anything
- LOST → anything
- CANCELLED → anything

### 2.3 Key Auto-Transition Rules
- Sending an estimate: transitions lead to ESTIMATED (from CONTACTED or WALKTHROUGH_COMPLETED only)
- Estimate approved (public page): transitions lead to WON
- Scheduling walkthrough: transitions to WALKTHROUGH_SCHEDULED
- Marking LOST/CANCELLED with active walkthrough: auto-cancels walkthrough + sends cancellation emails (with popup warning)

---

## 3. API Endpoints

### 3.1 New Endpoints

**POST /api/leads/:id/contact**
- Body: `{ contacted_at: DateTime, contacted_note?: string }`
- Guard: status = NEW
- Effect: Sets contacted_at + contacted_note, transitions NEW → CONTACTED

**POST /api/leads/:id/walkthrough/schedule**
- Body: `{ walkthrough_scheduled_at: DateTime, walkthrough_assigned_to: UUID, walkthrough_duration_minutes: number, send_email?: boolean }`
- Guard: status = CONTACTED or WALKTHROUGH_COMPLETED
- Effect: Sets fields, transitions to WALKTHROUGH_SCHEDULED, sends emails (unless send_email=false for past dates)
- Conflict detection: checks performer's calendar (jobs + walkthroughs) for overlaps, returns conflict info if found, accepts `force: true` to override

**POST /api/leads/:id/walkthrough/complete**
- Body: `{}` (timestamp set server-side)
- Guard: status = WALKTHROUGH_SCHEDULED
- Effect: Sets walkthrough_completed_at = now, transitions to WALKTHROUGH_COMPLETED, sends completion emails

**POST /api/leads/:id/walkthrough/cancel**
- Body: `{ cancelled_reason: string }`
- Guard: status = WALKTHROUGH_SCHEDULED
- Effect: Sets cancelled fields, clears schedule, reverts to CONTACTED, unlocks walkthrough_needed, sends cancellation emails

### 3.2 Modified Endpoints

**POST /api/leads (create)**
- Add: lead_number auto-generation (LEAD-YYYY-NNNN)
- Add: walkthrough_needed field (default true)

**POST /api/leads/:id/walkthrough (existing — repurpose)**
- Now handles general walkthrough field updates (notes, duration changes)
- Does NOT handle scheduling/completion/cancellation (those have dedicated endpoints)

**POST /api/estimates/:id/send**
- Add: block if lead status = WALKTHROUGH_SCHEDULED (return 400 with message)
- Add: auto-transition lead to ESTIMATED (from CONTACTED or WALKTHROUGH_COMPLETED)

**PATCH /api/leads/:id**
- Add: walkthrough_needed toggle (blocked if walkthrough is scheduled)

**POST /api/leads/:id/mark-lost**
- Add: if walkthrough is scheduled, auto-cancel walkthrough + send cancellation emails

**GET /api/leads (list)**
- Add: walkthrough status filter
- Add: contacted_at filter
- Include: walkthrough_assigned_to in select
- Repurpose: "Scheduled" column data → "Walkthrough" column (4 states)

### 3.3 New Job Endpoints

**POST /api/jobs/:id/walkthrough**
- Body: `{ walkthrough_notes: string }` + attachments handled separately
- Guard: job must be urgent (is_urgent = true)
- Effect: Sets walkthrough_notes + walkthrough_completed_at + walkthrough_assigned_to

### 3.4 Attachment Endpoints (New — Shared)

**POST /api/:entityType/:entityId/attachments**
- Body: multipart form — file + display_name + description + context (auto-set by frontend)
- Uploads to Supabase Storage
- Creates Attachment record with all fields
- Logs TimelineEvent

**DELETE /api/:entityType/:entityId/attachments/:attachmentId**
- Guard: edit access required
- Deletes from Supabase Storage + Attachment record
- Logs TimelineEvent

**PATCH /api/:entityType/:entityId/attachments/:attachmentId**
- Body: `{ display_name?, description? }`
- Logs TimelineEvent

---

## 4. Email Notifications (4 for MVP)

### 4.1 Email Types
| # | Type | Recipients | Content Summary |
|---|------|-----------|----------------|
| 1 | Scheduled | Customer + performer + lead owner | "Your walkthrough is scheduled for [date] at [time]. [Performer name] ([phone]) will visit [address]." |
| 2 | Rescheduled | Customer + performer + lead owner | "Your walkthrough has been rescheduled to [new date/time]." |
| 3 | Cancelled | Customer + performer + lead owner | "Your walkthrough scheduled for [date] has been cancelled. Reason: [reason]." |
| 4 | Completed (customer) | Customer | "We've completed our site visit at [address]. Your representative [lead owner name] will follow up with an estimate shortly." |
| 4b | Completed (internal) | Lead owner | "Walkthrough for [customer] has been completed by [performer]. Notes and photos are available." |

### 4.2 Email Configuration
- Format: Plain text, formatted
- From: Company Name from AppSetting (fallback: "Alpha Doors & Security")
- Reply-to: Lead owner's email
- Delivery: Fire-and-forget with logging (same as estimate emails)
- Past scheduling: popup asks dispatcher if email should be sent; `send_email` flag in API

---

## 5. Permissions Matrix

| Action | Admin | Dispatcher | Sales | Technician |
|--------|-------|------------|-------|------------|
| Create lead | Yes | Yes | Yes (own) | No |
| Mark as Contacted | Yes | Yes | Own leads | No |
| Schedule walkthrough | Yes | Yes | Own leads | No |
| Reschedule walkthrough | Yes | Yes | Own leads | No |
| Cancel walkthrough | Yes | Yes | Own leads | No |
| Complete walkthrough | Yes | Yes | If performer | If performer |
| Add notes/photos | Yes | Yes | Own leads or performer | If performer |
| Edit after completion | Yes | Yes | Own leads or performer | If performer |
| Delete attachments | Yes | Yes | Own leads or performer | If performer |
| Toggle walkthrough_needed | Yes | Yes | Own leads | No |
| Send estimate (blocked if WT scheduled) | Yes | Yes | Own leads | No |
| Cancel lead (with WT auto-cancel) | Yes | Yes | Own leads | No |
| Drag on calendar | Yes | Yes | No | No |
| Plan mode | Yes | Yes | No | No |
| View schedule | Yes | Yes | Yes (all, read-only) | Yes (own events) |
| Click popup on non-owned events | Yes | Yes | Yes (info only, no nav) | No |
| Enter non-owned detail page | Yes | Yes | No | No |

---

## 6. Frontend Components

### 6.1 UI Layout Restructure (Lead + Job pages)
- Full-width horizontal underline tabs (HubSpot pattern)
- 3px bottom border on active tab, primary blue
- Tabs inside card, below KPI strip, separated by border-t
- Sidebar content moves INTO Overview tab (right column ~35%)
- Lead tabs: Overview | Walkthrough (● status dot) | Estimates (count)
- Job tabs: Overview | Walkthrough (● status dot) | Work Items | Estimates (count)
- Notes tab removed (merged into Activity panel)

### 6.2 Icon Rail (Right Side — Detail Pages Only)
- 40px rail, always visible
- Panels: Activity (notes + timeline) + Attachments (grouped by context with color badges)
- Push content on xl+ screens, overlay on smaller
- Page-level (persists across tab switches)
- Activity panel: note input at top, reverse-chronological timeline below
- Attachments panel: collapsible sections by context, upload zone per section

### 6.3 Walkthrough Tab (Lead Detail)
- Single consistent layout across all states (no layout shifts)
- Sections always present: Schedule Info → Notes → Attachments → Action Button
- Schedule section (inline): date/time picker, duration dropdown (30/60/90/120/180, default 60), performer dropdown
- Performer dropdown: Sales + Technician users only, auto-filled with lead owner
- Notes: plain text textarea, always editable (before/during/after completion)
- Attachments: shared AttachmentSection, context=WALKTHROUGH auto-set
- Action button states:
  - No schedule: "Schedule Walkthrough" (enabled when date + performer filled)
  - Scheduled: "Complete Walkthrough" (disabled until notes + 1 photo uploaded)
  - Completed: badge "Completed on [date] by [person]" — can still edit notes/upload
- walkthrough_needed = false: "Walkthrough not required for this lead" + toggle to enable

### 6.4 Walkthrough Tab (Job Detail)
- Standard jobs: read-only view of lead's walkthrough data + "View Walkthrough →" link (navigates to lead Walkthrough tab)
- Urgent jobs: "Create Walkthrough" button → popup with notes + attachment upload + "Complete Walkthrough" button (same gate: notes + 1 photo)
- Standard job with no walkthrough on lead: "Create Walkthrough" button → redirects to lead's Walkthrough tab

### 6.5 Walkthrough on Estimate Pages
- EstimateFormPage: hybrid side Sheet — "Walkthrough" button in header. Shows notes + photo gallery. Overlay on <1920px.
- EstimateDetailPage: compact card — walkthrough date, performer, note preview, photo thumbnails (first 3-4), "View Walkthrough →" link

### 6.6 Shared AttachmentSection Component
- Works for any entity (polymorphic)
- Upload: drag-and-drop zone + file picker. Accepts JPG/PNG/HEIC, MP4, PDF
- Per-file: inline form for display_name + description (both required). Upload starts immediately with progress bar.
- Gallery: grid of thumbnails with color-coded context badges (amber=walkthrough, blue=job, violet=estimate, gray=other)
- Actions: click to preview/enlarge (lightbox for images, inline play for video), download link for all types, delete (X button)
- Limits: 25MB per file, 200MB per entity, unlimited count
- Error handling: red border + "Retry" per file, doesn't block others
- All events logged to TimelineEvent

### 6.7 Leads List Page Changes
- Repurpose "Scheduled" column → "Walkthrough" column:
  - NEW / walkthrough_needed=false: `—` (muted dash)
  - CONTACTED + no schedule: `Needs Sched.` (amber-600, font-medium — most prominent)
  - Scheduled: `Mar 22` (blue text)
  - Completed: `✓ Done` (muted green)
- Add "Mark as Contacted" button/icon per row (only when status = NEW)
- Add walkthrough status filter to filter dropdown
- Update status filter with new enum values

### 6.8 Mark as Contacted Dialog
- Simple dialog: date picker (default: now, adjustable) + optional note textarea
- Sets contacted_at + contacted_note, transitions NEW → CONTACTED

### 6.9 Cancel Walkthrough Dialog
- In dropdown menu on Lead detail page
- Requires reason (textarea)
- Available to: Admin, Dispatcher, assigned Sales

### 6.10 Cancel Lead with Active Walkthrough
- When marking LOST or CANCELLED on a lead with WALKTHROUGH_SCHEDULED status
- Popup warns: "This lead has a walkthrough scheduled. Cancelling will also cancel the walkthrough and notify the customer. Continue?"
- On confirm: auto-cancel walkthrough + send cancellation emails + proceed with LOST/CANCELLED

---

## 7. Calendar / Scheduler

### 7.1 Standard View (Existing — Minor Updates)
- Day view: time Y-axis, events positioned by time
- Week view: time Y-axis, day columns, events positioned by time
- Month view: calendar grid
- All events always visible (including completed — dimmed/muted)
- Filter toggle: "Open only" / "All" (to hide completed)
- Full address always visible on event blocks
- Drag from sidebar: time from drop position + assignee picker dialog

### 7.2 Member View (Renamed from "By Technician")
- Toggle label: `Standard | Member View`
- Shows ALL employees (Sales + Technicians), filterable by role dropdown
- All columns visible including empty ones (shows availability)
- **Day view:** Time Y-axis (Google Calendar style). Drag sets time + assignee from position. No dialog needed.
- **Week view:** Jira board grouped by day sections. Day headers: "Tuesday, Mar 17 — 3 jobs · 6.5 hrs". Cards stacked under each day. Drag sets assignee + day section, time picker dialog pops up.
- **Monthly view:** REMOVED
- All 7 days shown, no weekend hiding
- Empty day sections visible (shows availability)
- Each column scrolls vertically on overflow

### 7.3 Event Cards
**Job card:** job_number, customer name, time (day view only), full address, status badge, urgent indicator
**Walkthrough card:** lead_number, "Walkthrough", customer name, time (day view only), full address
- No duration text on cards (inferred from block height in day view)
- Walkthroughs: amber (#F59E0B) styling
- Jobs: blue-toned (by status)
- Completed events: dimmed/muted but visible

### 7.4 Event Interactions
- **Left-click:** Quick-view popup (Google Calendar style), read-only
  - Job: job#, status, customer, address, time, assigned tech, phone, "View Job →"
  - Walkthrough: "Walkthrough", lead#, customer, address, time, performer, lead owner (always both), phone, "View Walkthrough →"
  - "View" link hidden for Sales viewing non-owned items
- **Hover:** Tooltip with full details (same content as popup, subtle styling)
- **Right-click (Normal mode):** View Details, Reassign, Cancel
- **Right-click (Plan mode — confirmed event):** View Details, Move to Draft (becomes ghost)
- **Right-click (Plan mode — ghost event):** Confirm, Remove, Reassign
- **Drag (Normal mode):** Always shows confirmation popup listing who gets emailed

### 7.5 Sidebar
- Split: "Unscheduled Walkthroughs" + "Unassigned Jobs"
- Walkthrough cards: customer name, LEAD-YYYY-NNNN, full service address
- Job cards: customer name, JOB-YYYY-NNNN, full service address
- Draggable to calendar
- Right-click: "View Lead/Job", "No Walkthrough Needed" (walkthroughs only — toggles off, card disappears)
- Collapsible/expandable
- Unscheduled walkthroughs: leads with status=CONTACTED + walkthrough_needed=true + no walkthrough_scheduled_at

### 7.6 Plan Mode
- **Toggle:** "Plan Mode" button between view toggles and search bar. Outlined normally, filled primary blue + pulsing dot when active ("Planning").
- **Banner:** Blue info strip below toolbar: "Plan Mode — N unconfirmed changes" + [Discard All] + [Confirm All]
- **Calendar indicator:** Thin dashed blue border frame around calendar area
- **Ghost events:** Dashed left border, 50% opacity background, small "draft" label
- **Moved confirmed events:** Ghost at new position + faint origin ghost at original position
- **Confirm All:** Only affects ghosts in current calendar view (not other weeks/dates)
- **Sidebar in plan mode:** Cards removed from sidebar when dragged (plan mode mirrors real behavior). Discarding plan mode returns cards to sidebar.
- **Individual ghost removal:** Right-click → "Remove". Card returns to sidebar if it came from there.
- **Exit with ghosts:** Dialog: "You have N unconfirmed changes" → Discard & Exit / Confirm All & Exit / Cancel
- **Navigate away with ghosts:** Warning dialog
- **Persistence:** localStorage with tab-specific key (survives refresh, not shared across tabs/browsers)
- **Confirm dialog:** "Schedule [type] for [date/time], assign [Tech]. Emails will be sent to [customer], [tech], [owner]. Confirm?"
- **Conflict check:** At confirm time (not drag time). Conflict dialog appears before scheduling confirmation.

### 7.7 Deactivated Tech Events
- Events stay on board in both views (consistency)
- Red coloring in Standard view
- Red column header/tint in Member View
- Column stays visible until all events reassigned

### 7.8 Conflict Detection
- Applies to both jobs and walkthroughs
- Cross-entity query: checks Job.scheduled_start/end + Lead.walkthrough_scheduled_at/duration for the performer
- Only checks performer's calendar (not lead owner)
- Overridable warning (not hard block): shows conflict details, dispatcher can force-confirm

### 7.9 Calendar Search
- Returns any job/walkthrough that logically belongs on the calendar or sidebar
- Schedule scope includes: jobs (UNASSIGNED/SCHEDULED/IN_PROGRESS) + leads with walkthrough_scheduled_at
- Also includes COMPLETED jobs/walkthroughs when "All" filter is active

### 7.10 Calendar Time Range
- 12 AM – 12 AM (full day with scroll)
- Auto-scroll focus: 6 AM – 8 PM

---

## 8. Carry-Forward Pattern (Option C — Linked Display)

- Lead attachments (walkthrough photos) displayed read-only on Estimate and Job pages
- Labeled "Site Visit" section in Attachments panel (amber badges)
- Each entity can have its own attachments (context=JOB_WORK, ESTIMATE, etc.)
- No duplication — single source of truth on the Lead
- Job → Estimate → Lead chain for data traversal
- "View Walkthrough →" link on Job/Estimate navigates to Lead's Walkthrough tab

---

## 9. Edge Cases (All Resolved)

| Edge Case | Resolution |
|-----------|-----------|
| Lead deleted with scheduled walkthrough | Block deletion — force cancel walkthrough first |
| Lead marked LOST/CANCELLED with walkthrough | Popup warns, auto-cancel walkthrough on confirm + emails |
| Inactive tech with scheduled events | Warn admin, events stay on board in RED, become unassigned |
| Customer has no email | Warn dispatcher, proceed without customer email |
| Past date scheduling | Allowed. Popup asks "Send email?" (send_email flag in API) |
| Multiple estimates from one lead | Decline doesn't change lead status. Approve → WON. |
| Re-visit needed after completion | WALKTHROUGH_COMPLETED → WALKTHROUGH_SCHEDULED (valid) |
| Two dispatchers scheduling simultaneously | Supabase Realtime for live sync (normal mode). Plan mode is local per browser tab. |
| Plan mode: navigate away with ghosts | Warning dialog |
| Plan mode: confirm one ghost | Others unaffected. Sidebar card removed only for confirmed item. |
| Plan mode: remove ghost from sidebar drag | Card returns to sidebar |
| Estimate send with walkthrough scheduled | Blocked. Must cancel walkthrough first. |
| Walkthrough cancelled | Unlocks walkthrough_needed, reverts to CONTACTED, lead returns to sidebar |
| Walkthrough_needed toggled off from sidebar | Right-click → "No Walkthrough Needed". Card disappears from sidebar. |

---

## 10. Deferred Items (NOT in MVP)

| Item | Target |
|------|--------|
| Reminder emails (24h before walkthrough) | Automations module |
| Customer self-service reschedule/cancel | Customer Portal |
| Real-time shared plan mode | Post-MVP iteration |
| Rich text notes | Future enhancement |
| Attachment reordering | Future enhancement |
| Color-by-technician calendar mode | Future enhancement |
| Travel time buffers | Future enhancement |
| Business hours enforcement | Not needed |
| Overdue walkthrough alerts | Future consideration |
| Reassigned email notification | Fast follow after MVP |
| Customer + Estimate page tab restructure | Follow-up after Lead + Job pages |

---

## 11. Migration Strategy

### 11.1 Database Migration
1. Add new fields to Lead model (lead_number, walkthrough_assigned_to, walkthrough_needed, contacted fields, cancelled fields)
2. Add new fields to Job model (walkthrough_notes, walkthrough_completed_at, walkthrough_assigned_to)
3. Add new fields to Attachment model (display_name, description, context)
4. Add AttachmentContext enum
5. Modify LeadStatus enum (remove ESTIMATING + APPROVED, add WALKTHROUGH_COMPLETED)

### 11.2 Data Migration
- Existing leads with ESTIMATING → WALKTHROUGH_COMPLETED
- Existing leads with APPROVED → WON
- Existing attachments: display_name = filename, description = '', context = OTHER
- Backfill lead_number: LEAD-{created_year}-{sequence} ordered by created_at

### 11.3 Code Migration
- Update all references to ESTIMATING → new logic
- Update all references to APPROVED → WON
- Update estimate send to auto-transition lead to ESTIMATED
- Update estimate send to block if walkthrough is scheduled
- Remove auto-transition NEW → CONTACTED from updateWalkthrough
- Update stats queries with new status values
