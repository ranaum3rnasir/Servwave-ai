# Walkthrough Module — Execution Strategy

## Dev Lead Approach

### Execution Rules

1. **One phase at a time** — never start Phase N+1 until Phase N passes all acceptance criteria
2. **Backend before frontend** — Phases 1-7 complete before Phase 8 starts
3. **Test after every phase** — run full backend suite after each backend phase, type-check after each frontend phase
4. **Commit per phase** — one feature branch per phase, conventional commit, merge to main before next phase
5. **Skills per phase** — invoke the matching skill(s) before writing code in each phase

### Branching Strategy

```
main
 └── feat/walkthrough-phase-1-migration
 └── feat/walkthrough-phase-2-lead-api
 └── feat/walkthrough-phase-3-estimate-block
 └── ... (one branch per phase, merged sequentially)
```

---

## Phase Skill Mapping

### Phase 1: Database Migration — L

**Skills:**
- `database-design` — schema design, enum strategy, indexing decisions
- `backend-dev-guidelines` — Prisma conventions, migration patterns

**Agent:** Database Admin (general-purpose)

**Tasks:**
1. Invoke `database-design` skill for enum migration strategy (PostgreSQL can't remove enum values directly)
2. Write custom SQL: create new LeadStatus type → alter column → drop old type
3. Add all new fields to Lead, Job, Attachment models
4. Create AttachmentContext enum
5. Data migration: ESTIMATING→WALKTHROUGH_COMPLETED, APPROVED→WON, backfill lead_numbers, set attachment defaults
6. Invoke `lint-and-validate` — run `npx prisma validate`

**Verification:**
- `npx prisma validate` passes
- `npx prisma studio` — visually confirm migrated data

---

### Phase 2: Lead Walkthrough API — L

**Skills:**
- `backend-dev-guidelines` — Express controller patterns, layered architecture
- `api-patterns` — REST endpoint design, response format
- `api-security-best-practices` — input validation, authorization guards
- `backend-security-coder` — secure coding patterns (Zod validation, SQL injection prevention)
- `auth-implementation-patterns` — RBAC enforcement (Sales own-leads guard, performer checks)

**Agent:** Backend Developer (general-purpose)

**Tasks:**
1. Invoke `api-patterns` for endpoint design review
2. Write Zod schemas for all 4 new endpoints
3. Implement POST /leads/:id/contact (guard: NEW only, Sales own-leads)
4. Implement POST /leads/:id/walkthrough/schedule (guard: CONTACTED/WALKTHROUGH_COMPLETED, conflict check, performer defaults)
5. Implement POST /leads/:id/walkthrough/complete (guard: WALKTHROUGH_SCHEDULED, performer check)
6. Implement POST /leads/:id/walkthrough/cancel (guard: WALKTHROUGH_SCHEDULED, reason required)
7. Modify lead create (lead_number auto-gen), list (new filters/selects), getById (new fields), markLost (auto-cancel)
8. Invoke `backend-security-coder` for security review
9. Invoke `lint-and-validate`

**Verification:**
- All endpoints return correct responses for valid/invalid inputs
- Status transitions work as specified
- Guards block unauthorized access

---

### Phase 3: Estimate Send Block + Auto-Transitions — M

**Skills:**
- `backend-dev-guidelines` — controller modification patterns
- `backend-security-coder` — guard logic review

**Agent:** Backend Developer (general-purpose)

**Tasks:**
1. Modify estimate send: block if lead status = WALKTHROUGH_SCHEDULED (400)
2. Modify estimate send: auto-transition lead to ESTIMATED (from CONTACTED or WALKTHROUGH_COMPLETED)
3. Verify approve flow transitions lead to WON (remove APPROVED reference)
4. Invoke `lint-and-validate`

**Verification:**
- Send blocked when walkthrough scheduled (400 response)
- Send transitions lead correctly
- Approve transitions lead to WON

---

### Phase 4: Walkthrough Email Notifications — M

**Skills:**
- `backend-dev-guidelines` — service layer patterns
- `backend-security-coder` — email injection prevention, input sanitization

**Agent:** Backend Developer (general-purpose)

**Tasks:**
1. Add 4 new email functions to `email.ts` following existing wrapHtml pattern
2. Add reply-to header support (lead owner email)
3. Add dynamic "from" name (Company Name from AppSetting)
4. Wire into schedule/complete/cancel handlers (fire-and-forget)
5. Handle send_email=false for past scheduling
6. Handle missing customer email (warn + skip)
7. Invoke `backend-security-coder` — review for email header injection
8. Invoke `lint-and-validate`

**Verification:**
- Each email type sends with correct recipients/content
- Past-date with send_email=false skips email
- No crash on missing customer email

---

### Phase 5: Attachment Endpoints + Supabase Storage — L

**Skills:**
- `backend-dev-guidelines` — controller patterns, dependency injection
- `api-patterns` — polymorphic REST design
- `api-security-best-practices` — file upload security (type validation, size limits, path traversal prevention)
- `backend-security-coder` — file upload attack vectors, storage security
- `database-design` — attachment model relations

**Agent:** Backend Developer + Database Admin (general-purpose)

**Tasks:**
1. Create Supabase Storage bucket via MCP/dashboard
2. `npm install multer @types/multer --workspace=backend`
3. Invoke `api-security-best-practices` for file upload security patterns
4. Create attachment.controller.ts (CRUD: upload, list, update, delete)
5. Create attachment.routes.ts (polymorphic: /api/attachments/:entityType/:entityId)
6. Implement Supabase Storage upload/delete
7. Validate file types (JPG, PNG, HEIC, MP4, PDF), sizes (25MB/file, 200MB/entity)
8. Entity access control (Admin/Dispatcher: all, Sales: own leads, Tech: own jobs)
9. Timeline event logging for all attachment operations
10. Register routes in app.ts
11. Invoke `backend-security-coder` — review for path traversal, MIME sniffing, storage security
12. Invoke `lint-and-validate`

**Verification:**
- Upload/download/delete works end-to-end
- File in Supabase Storage matches record in DB
- Size/type limits enforced
- Access control blocks unauthorized users

---

### Phase 6: Job Walkthrough API — S

**Skills:**
- `backend-dev-guidelines` — controller patterns
- `api-security-best-practices` — authorization guards

**Agent:** Backend Developer (general-purpose)

**Tasks:**
1. Add POST /api/jobs/:id/walkthrough (urgent jobs only)
2. Update jobDetailSelect with new walkthrough fields
3. Invoke `lint-and-validate`

**Verification:**
- Endpoint works for urgent jobs, returns 400 for non-urgent
- All three fields set correctly

---

### Phase 7: Backend Tests Update — XL

**Skills:**
- `test-driven-development` — test structure, coverage patterns
- `backend-dev-guidelines` — testing conventions (setup.ts mocks, helpers.ts factories)
- `e2e-testing-patterns` — integration test patterns

**Agent:** QA Engineer (general-purpose)

**Tasks:**
1. Invoke `test-driven-development` for test structure review
2. Update setup.ts: add mocks for 4 new email functions + Supabase Storage
3. Update setup.ts: add `attachment` model mock to prisma mock
4. Fix all existing tests: replace ESTIMATING/APPROVED references
5. Add ~40 new lead tests (contact, schedule, complete, cancel, markLost auto-cancel, walkthrough_needed, lead_number, filters)
6. Add ~6 new estimate tests (send block, auto-transition)
7. Add ~8 new job tests (walkthrough endpoint)
8. Create attachments.test.ts (~20 tests: CRUD, access control, file validation)
9. Run `npm test --workspace=backend` — iterate until 0 failures
10. Invoke `lint-and-validate`

**Verification:**
- `npm test --workspace=backend` — ALL tests pass (470+)

---

### Phase 8: Lead Detail Page Restructure — XL

**Skills:**
- `impeccable` - page layout design, component architecture, visual hierarchy
- `frontend-developer` — React architecture, state management, component composition
- `react-patterns` — hooks, composition, TypeScript patterns
- `react-best-practices` — performance, rendering optimization
- `tailwind-patterns` — layout, responsive design, spacing system

**Agent:** UI Expert (impeccable)

**Tasks:**
1. Invoke `impeccable` with full context (current LeadDetailPage layout + spec for new layout)
2. Restructure page: Hero + KPI → full-width underline tabs (Overview | Walkthrough | Estimates)
3. Move sidebar content (customer, locations, assigned to) into Overview tab right column
4. Build WalkthroughTab.tsx — single consistent layout (schedule info → notes → attachments placeholder → action button)
5. Build ScheduleWalkthroughForm.tsx — inline date/time/duration/performer pickers
6. Build ContactLeadDialog.tsx — date + optional note
7. Build CancelWalkthroughDialog.tsx — reason required
8. Add "Mark as Contacted" button to hero section
9. Handle cancel-lead-with-active-walkthrough warning popup
10. Update StatusBadge for new enum values
11. Invoke `react-best-practices` for performance review
12. Invoke `lint-and-validate` — `npx tsc --noEmit`

**Verification:**
- Tab navigation works
- All existing data visible (nothing lost)
- Status transitions reflect immediately
- Visual polish matches design system

---

### Phase 9: Icon Rail (Activity + Attachments Panels) — L

**Skills:**
- `impeccable` - panel design, animation, push/overlay behavior
- `frontend-developer` — shared component architecture
- `react-patterns` — composition, prop design, reusable hooks
- `tailwind-patterns` — transitions, responsive breakpoints

**Agent:** UI Expert (impeccable)

**Tasks:**
1. Invoke `impeccable` for icon rail + panel implementation
2. Build IconRail.tsx — 40px rail, icon buttons, sliding panel toggle
3. Build ActivityPanel.tsx — note input + reverse-chronological timeline
4. Build AttachmentsPanel.tsx — grouped by context, collapsible sections, upload per section
5. Build AttachmentSection.tsx — reusable upload/gallery/delete (drag-drop + progress bars + inline name/desc form)
6. Integrate into LeadDetailPage
7. Wire "Complete Walkthrough" gate (notes + 1 photo)
8. Invoke `react-best-practices` — check for unnecessary re-renders
9. Invoke `lint-and-validate`

**Verification:**
- Icon rail visible, panels open/close with animation
- Activity panel shows notes + timeline merged
- Attachments panel shows grouped files
- Upload + delete works end-to-end
- Completion gate enforced

---

### Phase 10: Leads List Page Updates — M

**Skills:**
- `impeccable` - table column design, badge styling
- `frontend-developer` — DataTable modifications, filter integration

**Agent:** UI Expert (impeccable)

**Tasks:**
1. Replace "Scheduled" column with "Walkthrough" column (4 states: dash/amber/blue/green)
2. Add "Mark as Contacted" icon button per row (status = NEW only)
3. Update status filters (remove ESTIMATING/APPROVED, add new values)
4. Add walkthrough status filter submenu
5. Add lead_number display
6. Update KPI stats references
7. Invoke `lint-and-validate`

**Verification:**
- Walkthrough column renders correctly for all 4 states
- Amber "Needs Sched." is visually prominent
- Filters work with new values

---

### Phase 11: Job Detail Page Restructure — L

**Skills:**
- `impeccable` - consistent tab pattern (matching Phase 8 Lead page)
- `frontend-developer` — data fetching across entity chain (Job → Estimate → Lead)
- `react-patterns` — component reuse (WalkthroughTab variants)

**Agent:** UI Expert (impeccable)

**Tasks:**
1. Restructure tabs: Overview | Walkthrough | Work Items | Estimates
2. Build job WalkthroughTab.tsx:
   - Standard jobs: read-only lead walkthrough data + "View Walkthrough →" link
   - Urgent jobs: "Create Walkthrough" popup (notes + photos + Complete button)
3. Integrate IconRail (Activity + Attachments)
4. Add compact walkthrough card to EstimateDetailPage (date, performer, thumbnails, "View Walkthrough" link)
5. Invoke `react-best-practices`
6. Invoke `lint-and-validate`

**Verification:**
- Standard job shows lead's walkthrough data read-only
- Urgent job walkthrough popup works with completion gate
- Consistent look and feel with Lead detail page

---

### Phase 12: Calendar — Minor Updates — M

**Skills:**
- `frontend-developer` — calendar component modification
- `impeccable` - event card design, tooltip design, address display

**Agent:** UI Expert (impeccable)

**Tasks:**
1. Ensure full address visible on all event blocks (day + week views)
2. Add completed events (dimmed, 50% opacity)
3. Build filter toggle: "Open only" / "All" in toolbar
4. Show lead_number on walkthrough cards
5. Adjust time range: 12 AM–12 AM with 6 AM–8 PM focus scroll
6. Build quick-view popup (Google Calendar style) for all events
7. Build hover tooltips (full details, subtle styling)
8. Add deactivated tech red coloring
9. Invoke `lint-and-validate`

**Verification:**
- Address visible on all cards
- Completed events dimmed when "All" active
- Popup shows correct content for jobs/walkthroughs
- Red coloring on deactivated tech events

---

### Phase 13: Calendar — Sidebar Split + Walkthrough Cards — M

**Skills:**
- `frontend-developer` — drag-and-drop integration
- `impeccable` - sidebar layout, card design, right-click menu

**Agent:** UI Expert (impeccable)

**Tasks:**
1. Split sidebar: "Unscheduled Walkthroughs" + "Unassigned Jobs"
2. Build walkthrough cards (customer name, LEAD-YYYY-NNNN, full address)
3. Wire drag-to-schedule: Standard view (time + assignee dialog), Member Day (time + tech from position), Member Week (tech + day + time dialog)
4. Build right-click menu: "View Lead", "No Walkthrough Needed"
5. Build drag confirmation popup (lists email recipients)
6. Invoke `lint-and-validate`

**Verification:**
- Sidebar correctly shows two sections
- Drag creates scheduled walkthrough
- Right-click toggle removes card
- Confirmation popup lists recipients

---

### Phase 14: Calendar — Member View Weekly Board — XL

**Skills:**
- `impeccable` - Jira-style board design, card layout, day grouping
- `frontend-developer` — complex component architecture, drag-and-drop in non-grid context
- `react-patterns` — state management for board view
- `tailwind-patterns` — responsive columns, overflow handling

**Agent:** UI Expert (impeccable)

**Tasks:**
1. Invoke `impeccable` with board spec (columns per employee, day sections, card design)
2. Rename "By Technician" → "Member View"
3. Show ALL employees (Sales + Technicians), add role filter dropdown
4. Build weekly board: columns per employee, day sections with headers ("Tuesday, Mar 17 — 3 jobs · 6.5 hrs")
5. Cards under each day section, sorted by time
6. Wire drag-and-drop: assignee from column + day from section + time picker dialog
7. Remove monthly view from Member View
8. Ensure Day view still works with time Y-axis
9. Invoke `react-best-practices` — virtualization if many employees
10. Invoke `lint-and-validate`

**Verification:**
- Board renders with all employees as columns
- Day headers show correct counts
- Drag + time picker works
- Role filter works

---

### Phase 15: Calendar — Plan Mode — XL

**Skills:**
- `frontend-developer` — complex state management, localStorage, React Router blockers
- `react-patterns` — custom hooks (usePlanMode), context providers
- `impeccable` - ghost event visual design, mode indicator, confirmation dialogs

**Agent:** UI Expert (impeccable) + Frontend Developer (frontend-developer)

**Tasks:**
1. Invoke `react-patterns` for state management architecture (usePlanMode hook)
2. Build usePlanMode hook: ghost array, localStorage persistence (tab-specific key), add/remove/confirm/discard
3. Build Plan Mode toggle button (outlined → filled blue + pulsing dot)
4. Build info banner ("Plan Mode — N changes" + Discard All + Confirm All)
5. Render ghost events (dashed border, 50% opacity, "draft" label)
6. Handle sidebar: remove card on drag, restore on discard
7. Handle confirmed event moved: ghost at new position + origin ghost
8. Build right-click menus (ghost: Confirm/Remove/Reassign, confirmed: Move to Draft)
9. Build confirmation dialog (type, date, assignee, email recipients, conflict check)
10. Build exit dialog (Discard & Exit / Confirm All & Exit / Cancel)
11. Add navigation warning (beforeunload + React Router blocker)
12. Invoke `react-best-practices` — performance with many ghosts
13. Invoke `lint-and-validate`

**If exceeding 3 days, split:**
- 15a: Ghost rendering + basic confirm/discard
- 15b: localStorage + navigation warnings + right-click menus

**Verification:**
- Toggle works, banner shows
- Ghost events render distinctly
- Confirm/discard works per-ghost and batch
- Ghosts persist across refresh
- Navigation warning appears

---

### Phase 16: Calendar — Conflict Detection (Cross-Entity) — M

**Skills:**
- `backend-dev-guidelines` — cross-entity query patterns
- `api-security-best-practices` — query safety
- `frontend-developer` — conflict dialog UI

**Agent:** Backend Developer + UI Expert

**Tasks:**
1. Backend: build cross-entity conflict query (Job.scheduled_start/end + Lead.walkthrough_scheduled_at/duration)
2. Integrate into walkthrough/schedule endpoint (already started in Phase 2)
3. Integrate into job assign endpoint (enhance existing conflict check)
4. Return conflict details (type, id, number, start, end)
5. Frontend: build conflict dialog (shows overlapping events, force-confirm option)
6. Wire into Plan Mode confirm flow (check at confirm time)
7. Invoke `backend-security-coder` — SQL injection review on raw queries
8. Invoke `lint-and-validate`

**Verification:**
- Scheduling detects both job AND walkthrough conflicts
- 409 returned with conflict details
- force=true overrides
- Frontend dialog shows conflict info

---

## Post-Phase Verification (After All 16 Phases)

**Skills:**
- `e2e-testing-patterns` — end-to-end journey verification
- `code-review-checklist` — final code quality audit
- `systematic-debugging` — any remaining issues

**Tasks:**
1. Run Journey 1: Standard flow (lead → contact → walkthrough → estimate → approve)
2. Run Journey 2: Urgent job flow (create → document → complete)
3. Run Journey 3: Plan mode flow (enter → drag → confirm → exit)
4. Run full backend test suite: `npm test --workspace=backend` (470+ tests)
5. Run TypeScript check: `npx tsc --noEmit` from frontend
6. Run Playwright E2E: `npx playwright test` from frontend (16 existing tests)
7. Invoke `code-review-checklist` for final quality audit
8. Invoke `simplify` — review all changed files for unnecessary complexity

---

## Estimated Timeline

| Block | Phases | Skills Used | Est. Days |
|-------|--------|-------------|-----------|
| Foundation | 1 | database-design, backend-dev-guidelines | 2 |
| Backend API | 2, 3, 4, 5, 6 | backend-dev-guidelines, api-patterns, api-security, backend-security-coder, auth-patterns | 5 |
| Backend Tests | 7 | test-driven-development, e2e-testing-patterns | 3 |
| Core Frontend | 8, 9, 10, 11 | impeccable, frontend-developer, react-patterns, react-best-practices, tailwind-patterns | 10 |
| Calendar | 12, 13, 14, 15, 16 | impeccable, frontend-developer, react-patterns, backend-dev-guidelines | 13 |
| **Total** | **1-16** | **18 unique skills** | **~33 days** |

---

## Risk Register

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|-----------|
| PostgreSQL enum migration fails | Medium | High | Write and test custom SQL before running |
| Supabase Storage CORS issues | Medium | Medium | Configure bucket policies early in Phase 5 |
| Plan Mode exceeds complexity estimate | High | Medium | Split into 15a/15b at first sign of delay |
| Existing Playwright tests break | Low | Medium | Run E2E suite after Phase 8 to catch early |
| lead_number race condition | Low | High | Use transaction + findFirst(orderBy desc) pattern (same as job/estimate) |
| Email delivery issues (Resend) | Low | Low | Fire-and-forget + logging; no blocking |
