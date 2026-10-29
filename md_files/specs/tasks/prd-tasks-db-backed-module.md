# PRD: Tasks module — complete the lean wiring into a full-rich, scoped, Job-integrated module

> **Baseline note (verified against branch HEAD `2d99c884`, 2026-06-17).** This branch is being actively developed in parallel — five commits landed mid-session. The front-end Tasks store was just wired to the real API (`2a70e494`, `fc819c4c`) and a Job command center is taking shape (`5f912951`, `ffab84b9`, `2d99c884`). This PRD reflects that real baseline, not the older "everything is mock" state. Work proceeds on a dedicated worktree/branch `feat/tasks-db-backed` based off `2d99c884`.

## Problem Statement

The Tasks module is now *partly* real but incomplete. As of the current branch HEAD, the front-end Tasks store has been wired to the real `/api/tasks` endpoints (list / create / update / delete) on both the standalone `/tasks` hub and the Job/Lead **Tasks** tab — so basic tasks persist to the organization's database. But the wiring is deliberately **lean** (the code marks the rich fields *"deferred to Phase D"*), and several things still make the module feel unreal:

- **Subtasks, comments, the activity feed, watchers, and AI risk are stubbed to empty** and not persisted — the detail drawer's activity/comments and the History view have nothing real to show.
- **Assignees, watchers, the command bar, the filters, and the suggestion panels still run on mock people/entities** (`MOCK_PEOPLE` / `MOCK_ENTITIES` / `MOCK_DEPARTMENTS`) across six components — so a task's real owner doesn't resolve to a name, and you can't assign a real teammate.
- **Linked-entity labels come back empty**, so a task linked to a job shows no human-readable context.
- **Visibility isn't scoped** — anyone with the read grant sees every task in the organization.
- The **Job command center** (its header, lifecycle bar, and financials were just built) has **no task signals** — a job doesn't show its open/overdue task health.

From the user's perspective: *"Tasks save now, but I still can't assign them to my real people, the job tab doesn't show whose tasks they are or surface what's slipping, and the comments / checklists / history are empty."*

## Solution

Complete the just-landed lean wiring into a fully real, multi-user module. Every task — plus its subtasks, comments, assignment/status changes, and completion — is stored in the organization's database, scoped per tenant, visible to the right people, assigned to real users, and linked to real entities with human-readable labels. Tasks become a first-class panel of the **Job command center**: a Job shows its open/overdue task counts and an at-risk strip, and a user can spin up a task for a Job in one click. The AI command bar and "Generate tasks" keep working, now over real people and real entities.

**Visibility:** an **Admin** sees all of the organization's tasks; every other role (Dispatcher, Sales, Technician) sees the tasks they **own or watch**. On a Job/Lead/Customer/Estimate detail page, the Tasks tab shows **every** task linked to that entity — access is already gated by reaching the entity page.

## User Stories

**Capture & assignment**
1. As any user, I want to create a task with a title, description, priority, due date, and assignee, so that work is captured and owned.
2. As a dispatcher, I want to assign a task to a **real** technician (picked from my organization's users), so that the right person is accountable and their name shows on the task.
3. As any user, I want to set a due date, so that time-sensitive work surfaces before it slips.
4. As any user, I want to set a priority (Low/Medium/High/Urgent), so that the team knows what matters most.
5. As any user, I want to link a task to a real Job, Lead, Customer, or Estimate and see its human-readable label, so that the work has context.
6. As any user, I want to tag a task (e.g. "parts", "follow-up"), so that I can group related work.
7. As any user, I want to add real teammates as watchers, so that interested people can follow it without owning it.
8. As any user, I want to type a natural-language request ("remind Hazal to order glass for the Limon job by Friday") into the command bar and have it match my real users and resolve the linked entity in the create modal, so that capturing work is fast.
9. As any user, I want to break a task into subtasks/checklist items that persist, so that multi-step work is trackable.
10. As any user creating a task, I want to remain a watcher by default, so that I keep visibility even after assigning it to someone else.

**Work & update**
11. As an owner, I want to move a task through TODO → IN_PROGRESS → BLOCKED → DONE, so that status reflects reality.
12. As any user, I want completing a task to record when it was completed, so that history is accurate.
13. As any user, I want to reopen a completed task (move it off DONE) and have the completion timestamp clear, so that mistakes can be corrected.
14. As any user, I want to check off subtasks independently and have it persist, so that partial progress is visible to everyone.
15. As any user, I want to comment on a task and have it persist with my name, so that context and updates live with the work.
16. As any user, I want every change (created, assigned, status change, priority change, due change, comment, completion, nudge) recorded in a persisted activity feed with who/when, so that there's an audit trail.
17. As a watcher or owner, I want to nudge a task, so that I can prompt action (recorded in the activity feed).
18. As any user, I want to edit a task's fields inline from its detail, so that corrections are quick.

**View & scope**
19. As an admin, I want to see all tasks across the organization, so that I have full operational oversight.
20. As a non-admin (sales/dispatcher/technician), I want to see only the tasks I own or watch in the hub, so that my workspace stays focused on my responsibilities.
21. As a technician, I want a "My Day" view of my own tasks for today/overdue, so that I know what to do next.
22. As any user, I want to filter tasks by status, priority, **real** owner, linked entity, due window, and tags, so that I can find what I need.
23. As any user, I want to search tasks by title, owner, or linked entity, so that I can locate a task quickly.
24. As any user, I want a board (kanban) grouped by status, so that I can see flow at a glance.
25. As any user, I want a calendar of tasks by due date, so that I can plan around deadlines.
26. As an admin/dispatcher, I want a history view of completed/closed tasks driven by the real activity feed, so that I can review what's been done.
27. As any user, I want a dashboard of task insights (counts by status, overdue, by priority/owner), so that I understand the workload.
28. As any user, I want my task list to stay in sync across devices and teammates, so that everyone sees the same truth.

**Job / entity integration**
29. As a dispatcher viewing a Job, I want to see every task linked to that Job regardless of owner, so that I have the complete picture for that Job.
30. As a dispatcher, I want the Job's Tasks tab to show a live count, so that I can gauge task volume without opening it.
31. As a dispatcher, I want open/overdue task counts and the next due date on the Job command-center header/overview, so that task health is visible at a glance.
32. As a dispatcher, I want overdue/at-risk tasks for a Job surfaced prominently (a strip/alert), so that slipping work gets attention.
33. As any user on a Job, I want a one-click "new task for this job" action that pre-links the entity, so that capturing job work is frictionless.
34. As any user, I want the "Generate tasks" template to suggest a checklist based on the Job type, so that I don't start from scratch.
35. As a sales rep on a Lead, I want to attach follow-up tasks to the Lead, so that my pipeline work stays organized.

**Risk, provenance, tenancy & permissions**
36. As any user, I want a task's risk to reflect priority, overdue status, and being blocked, so that the riskiest work stands out.
37. As any user, I want to know whether a task was created manually or via the AI command bar/template, so that provenance is clear.
38. As an organization, I want every task scoped to my organization, so that no other tenant can see or touch our tasks.
39. As an admin, I want per-organization task numbering (T00001…), so that tasks are referenceable.
40. As an admin, I want role-based control over who can create/edit/delete tasks via the existing permission system, so that access stays governed (technicians cannot delete).

## Implementation Decisions

### Current baseline (already on the branch — extend, don't rebuild)
- **Backend (lean, done):** `Task` model + 3 enums + idempotent migration; tenant-scoped CRUD controller; `/api/tasks` routes gated by CASL `canDo(...,'Task')`; per-org `task_number`. No subtasks/comments/activity/watchers/AI, no `GET /:id`, no row-level scoping, no label resolution.
- **Front-end (lean, done):** `lib/api/tasks.ts` (`listTasks`/`createTask`/`updateTaskApi`/`deleteTaskApi` + `mapRowToTask` that empty-fills the rich fields, marked *"deferred to Phase D"*); `tasksStore.ts` is a **Zustand API store** (`fetchTasks`/`addTask`/`updateTask`/`deleteTask`); `CreateTaskModal` + `JobLeadTasksTab` call it. Pickers/filters still mock.
- **Job command center (jobs-only, done):** command-center header, summary strip, action cluster, financials hook (`lib/api/jobs.ts`), and a lifecycle progress bar (`JobLifecycleBar`, `lib/jobs/lifecycle.ts`) on `JobDetailPage`. **No task signals yet.**

### Persistence model — "full rich" (the remaining backend build)
- New columns on the task: `watcher_ids` (array of user IDs), `ai_source` (enum: `MANUAL` | `AI_NL` | `AI_TEMPLATE` | `AI_EXTRACT`), and `ai_suggested_by`.
- Three new child tables, each cascade-deleted from the task: **subtasks** (text, done, order), **comments** (author, body, timestamp), and an append-only **activity** feed (type, actor, optional metadata, timestamp).
- Two new enums: a task activity type (`CREATED`, `ASSIGNED`, `STATUS_CHANGED`, `PRIORITY_CHANGED`, `DUE_CHANGED`, `COMMENTED`, `NUDGED`, `COMPLETED`) and the AI source above.
- Migration remains **idempotent** (shared staging DB).

### Risk is computed on read, not stored
Risk depends on "now" (overdue), so it is derived on every read from priority + overdue + BLOCKED status and returned as `{ score, reason }` per task. Only AI provenance is persisted.

### Visibility policy (deep, isolated module)
A pure function maps `(requesting user, filters) → query scope`: ADMIN → all org tasks; every other role → tasks where the user is **owner OR watcher**; when filtered by a linked entity (the entity-detail tab) → **all** tasks for that entity within the tenant; always composed with existing tenant scoping. `GET /api/tasks` is personal-scoped (hub) when no linked-entity filter is present and entity-wide when `linked_entity_type` + `linked_entity_id` are supplied.

### Detail & list shapes; label/name resolution (deep module)
- `GET /api/tasks/:id` (new) → task with subtasks, comments (author display names), activity (actor display names), resolved watcher names, the linked-entity label, and computed risk.
- The list response carries owner display name, entity label, computed risk, and subtask done/total + comment counts — not full bodies.
- A server-side batch resolver looks up display strings across Job/Lead/Customer/Estimate so the front-end stops hardcoding/empty-filling labels.

### Activity emission (deep module)
Create → `CREATED`; a PATCH derives `ASSIGNED` / `STATUS_CHANGED` / `PRIORITY_CHANGED` / `DUE_CHANGED` via a before/after diff; status → DONE → `COMPLETED` + sets `completed_at`; status off DONE clears `completed_at`; comment → `COMMENTED`; nudge → `NUDGED`.

### API contracts (shapes, not paths-as-contract)
- `GET /api/tasks?[linked_entity_type, linked_entity_id, status, priority, owner_id, due_before, tag, q]` → `{ tasks: TaskSummary[] }`
- `GET /api/tasks/:id` → `{ task: TaskDetail }`
- `POST /api/tasks` (+ `CREATED`; creator auto-added as watcher); `PATCH /api/tasks/:id` (+ diff-derived activity; supports owner, watchers, status, priority, title, description, due, tags); `DELETE /api/tasks/:id` → `204`
- `POST /api/tasks/:id/comments`; `POST|PATCH|DELETE /api/tasks/:id/subtasks[/:subtaskId]`; `POST /api/tasks/:id/nudge`
- A per-entity **task summary** (open / overdue / next-due) for the Job command-center signals — a small dedicated endpoint or a `summary` flag on the list query.

### Front-end (extend the existing pieces)
- **Server state:** **extend the just-committed Zustand store** (`tasksStore` + `lib/api/tasks`) rather than migrate to TanStack Query — migrating would discard fresh work for no functional gain. *(Project nominal standard is TanStack Query; this is a deliberate reconciliation — confirm if you'd rather migrate.)* Add the rich endpoints (subtasks/comments/activity/watchers/nudge, `GET /:id`) to the client + store; the store stops empty-filling rich fields once they're real. Keep UI-only stores (`taskFilterStore`, `taskDetailStore`).
- **Real users/entities replace mock** across the six components that still import `MOCK_PEOPLE`/`MOCK_ENTITIES`/`MOCK_DEPARTMENTS` (`AiCommandBar`, `CreateTaskModal`, `SuggestedTasksPanel`, `TaskDetailDrawer`, `TaskFilterBar`, `useFilteredTasks`). Owner/actor/watcher names resolve from real org users (fixing the current "owner UUID doesn't resolve to a name" gap).
- **AI stays heuristic, re-pointed at real data:** the command bar's client-side parser matches real users; the linked entity is resolved/confirmed in the create modal; "Generate tasks" stays a client-side template keyed on Job type; `ai_source` records provenance.
- **Job command-center surfaces (net-new):** task signals (open/overdue + next-due) on the command-center header + a live count badge on the Tasks tab (from the per-entity summary); an overdue/at-risk strip driven by computed risk; a "new task for this job" quick action. Reuse the existing command-center header/lifecycle scaffolding from `5f912951`/`ffab84b9`.

### Reused without change
Tenant scoping (`tenantWhere`), per-org numbering (`task` entry exists), CASL `Task` subject + role grants (SALES/DISPATCHER full CRUD; TECHNICIAN read/create/update, no delete; ADMIN immune), and the existing pure FE logic (`tasks-logic`, `useFilteredTasks`, `taskAI`).

## Testing Decisions

**What makes a good test here:** assert *external behavior* — HTTP status + response shape, database effects, and emitted activity — not private function calls or internal structure. Pure modules are tested as pure functions over inputs/outputs.

**Scope: all modules, TDD throughout.**

**Backend (test-first; prior art: `backend/src/__tests__/tasks.test.ts` supertest-style + the broader controller suite):** visibility policy (admin-all / non-admin own+watched / entity-wide when filtered / always tenant-bound); each endpoint (list both modes, detail with includes, create + number + `CREATED` + creator-as-watcher, patch + diff-activity, complete/reopen timestamps, comments, subtasks add/toggle/delete, watcher set, nudge); risk evaluator (pure unit across priority × overdue × BLOCKED); activity diff (before/after → exact event set); linked-entity label resolver (batch across all four types); tenancy isolation + CASL gating (technician delete → 403; sales/dispatcher CRUD paths).

**Front-end:** tasks API client + `mapRowToTask` (extend existing `tasks-store-api.test.ts`); store actions for the new rich endpoints; real-user/entity pickers and name resolution (replacing the mock-driven assertions); `taskAI.parse`/`suggestTasks` re-pointed at real users/entities (update `taskAI.test.ts`); `tasks-logic`/`useFilteredTasks` fed real users (update `tasks-logic.test.ts`, `task-filter-history.test.ts`); workspace render test (update `tasks-workspace-redesign.test.tsx`); Job-surface rendering — counts, at-risk strip, quick action — against mocked queries.

All existing front-end task tests that assume mock people/entities are **updated** to the real-data world, not deleted.

## Out of Scope

- Real LLM-powered AI (command-bar parsing, task generation, risk). Stays heuristic/deterministic; an LLM via Servy / AI Center is a follow-up.
- Notifications (email/SMS/push) on assignment, nudge, due, or mention. Assignment makes a task appear in the assignee's workspace; no external notification is sent.
- Auto-generating a task checklist on Job creation (explicitly deferred).
- Recurring tasks and a task-template management UI.
- Task dependencies (blocked-by relationships beyond the BLOCKED status).
- Attachments on tasks.
- Pagination/virtualization of the task list (org volumes are small in Phase 0; revisit if needed).
- Cross-entity access hardening on the entity-filtered query beyond tenant scoping (noted as a hardening follow-up).
- Bulk actions (multi-select complete/assign).
- Mobile-specific task UX beyond responsive behavior.

## Further Notes

- **Verified baseline & parallel development.** As of HEAD `2d99c884`, `feat/job-command-center` is being actively developed in parallel — five commits landed during the PRD session: `2a70e494` (FE store → real API), `fc819c4c` (fetch guard + create error-handling), `5f912951` (job command-center header/summary/financials), `ffab84b9` (job lifecycle bar), `2d99c884` (lifecycle node ring). This PRD's work happens on a dedicated worktree/branch **`feat/tasks-db-backed`** based off `2d99c884`; if `feat/job-command-center` keeps moving, rebase before integrating. PRs target `servwave` per the staging-first workflow.
- **Relationship to existing issues:** supersedes/expands **#231** ("build real DB-backed Tasks module" — premise now doubly stale: the model *and* a lean FE wiring both exist). Sibling mock→DB follow-ups: **#229** (Communication), **#230** (Reports). Related Task bugs this should subsume/unblock: **#174** (inline-edit persisted), **#175** ("Plan my day" ranking + persistence), **#176** (Calendar drag-to-reschedule wired to backend), **#172** (dead view-switcher tabs).
- **Recommended sequencing** (plan detail, not scope): backend full-rich first (schema → scoped API + sub-resources + activity/risk/labels, TDD), then FE rich-field wiring + real-users swap + Job command-center task signals. A thin-slice alternative (real users + labels + scoping first, rich sub-resources after) is viable if an earlier visible win is preferred.
- **Design system:** ServWave "Calm Intelligence" — Ocean = interactive, Sage = business/approved only, AI lavender = AI moments only (the command bar), status danger/warning for overdue/at-risk (never the notification red).
