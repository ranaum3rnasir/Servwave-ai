# Tasks Module — Frontend Real-Data Wiring (Plan 2 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`). Builds on Plan 1 (backend full-rich, merged on this branch). Branch `feat/tasks-db-backed`, worktree `../alpha_crm-worktrees/tasks-module`.

**Goal:** Make the Tasks frontend consume the now-real backend — replace mock people/entities with real org users/entities, fetch & render real subtasks/comments/activity/watchers, and wire the new mutation endpoints — so every Tasks surface (hub views, Job/Lead tab, detail drawer, command bar) runs on the DB.

**Architecture:** Keep the existing **Zustand** store (`tasksStore`) + thin axios client (`lib/api/tasks.ts`) — extend, don't migrate to TanStack Query. Display names/labels come from backend fields (`owner_name`, `linked_entity_label`, detail `author_name`/`actor_name`/watcher names); the user *list* for pickers comes from the existing `useAssignableUsers()` + `<AssigneeSelect>`/`<MultiAssigneeSelect>`. The drawer fetches `GET /:id` on open for rich fields.

**Tech Stack:** React 18 + TS + Vite, Zustand, axios, vitest + @testing-library/react. Frontend tests: `npm test --workspace=frontend -- <pattern>` (vitest); types: `cd frontend && npx tsc --noEmit`.

## Global Constraints
- **No mock data in shipped paths** — remove all `@/lib/tasks/tasks-mock` imports from the 6 components + views (the mock file may remain for tests only).
- **Keep Zustand** (extend `tasksStore` + `lib/api/tasks`); keep UI-only stores `taskFilterStore`/`taskDetailStore`.
- **Reuse existing components:** `AssigneeSelect`, `MultiAssigneeSelect` (`components/common/`), `useAssignableUsers`/`useUsers` (`lib/api/users.ts`), `useDepartments` (`lib/api/departments.ts`), `CustomerSelect` pattern (`components/common/CustomerSelect.tsx`) as the template for the new entity picker.
- **Backend response contract (from Plan 1):** list item = task fields + `owner_name`, `linked_entity_label`, `risk:{score,reason}`, `_count:{subtasks}`. `GET /:id` = + `subtasks[]` (`{id,text,done,position}`), `comments[]` (`{id,body,author_id,author_name,at}`), `activity[]` (`{id,type,description,actor_id,actor_name,at,metadata}`, `type` is UPPERCASE: CREATED/ASSIGNED/STATUS_CHANGED/PRIORITY_CHANGED/DUE_CHANGED/COMMENTED/NUDGED/COMPLETED), `watchers[]` (`{id,name}`). Endpoints: `POST /:id/comments {body}`, `POST /:id/subtasks {text}`, `PATCH /:id/subtasks/:sid {text?,done?}`, `DELETE /:id/subtasks/:sid`, `POST /:id/nudge`, and `PATCH /:id` accepts `watcher_ids`.
- **Branch/worktree discipline + stage-only-your-files** (no `git add -A`). PRs target `servwave`.
- **Strict TDD**; update existing FE task tests to the real-data world (don't delete).

---

## File Structure
- **Modify** `frontend/src/lib/tasks/types.ts` — extend `Task`/`TaskComment`/`TaskActivity`; uppercase `TaskActivity['type']` union.
- **Modify** `frontend/src/lib/api/tasks.ts` — `TaskRow` gains `owner_name`/`linked_entity_label`/`risk`/`_count`; `mapRowToTask` consumes them; add `getTask`, `addCommentApi`, subtask APIs, `nudgeApi`; `updateTaskApi` accepts `watcher_ids`; add a `TaskDetailRow`→`Task` mapper.
- **Modify** `frontend/src/stores/tasksStore.ts` — add `fetchTaskDetail`, `addComment`, `addSubtask`, `toggleSubtask`, `deleteSubtask`, `setWatchers`, `nudge`.
- **Create** `frontend/src/components/tasks/LinkedEntitySelect.tsx` — type picker + per-type debounced search.
- **Modify** the 6 mock-dependent components + `MyDayView`/`SuggestedTasksPanel` + views (MOCK_NOW→`new Date()`, personName→BE names).
- **Modify** existing tests; add new ones.

---

## Task 1: FE types + rich read model (api client + store detail fetch)

**Files:** Modify `frontend/src/lib/tasks/types.ts`, `frontend/src/lib/api/tasks.ts`, `frontend/src/stores/tasksStore.ts`; Test `frontend/src/__tests__/tasks-store-api.test.ts`

**Interfaces — Produces:** `Task` gains `owner_name?: string | null` and `watchers?: {id;name}[]`; `TaskComment` gains `author_name?: string | null`; `TaskActivity` gains `description?: string` + `actor_name?: string | null` and `type` becomes the UPPERCASE union; `getTask(id): Promise<Task>`; store `fetchTaskDetail(id): Promise<void>`.

- [ ] **Step 1: Extend `types.ts`.** Change `TaskActivity['type']` to `'CREATED'|'ASSIGNED'|'STATUS_CHANGED'|'PRIORITY_CHANGED'|'DUE_CHANGED'|'COMMENTED'|'NUDGED'|'COMPLETED'`. Add `description?: string` and `actor_name?: string | null` to `TaskActivity`. Add `author_name?: string | null` to `TaskComment`. Add to `Task`: `owner_name?: string | null`, `watchers?: { id: string; name: string }[]`. (Keep `ai`; `risk` maps into `ai.risk_score`/`ai.risk_reason`.)
- [ ] **Step 2: Failing test** in `tasks-store-api.test.ts`: `listTasks` maps `owner_name`/`linked_entity_label`/`risk` from the row; `getTask` GETs `/api/tasks/:id` and returns a Task whose `subtasks`/`comments`/`activity`/`watchers` are the real arrays (not empty) with `author_name`/`actor_name` populated and `linked_entity.label` from `linked_entity_label`.
```ts
it('getTask maps the detail row to a full Task', async () => {
  mockApi.get.mockResolvedValue({ data: { task: {
    ...ROW, owner_name: 'Oved Adani', linked_entity_label: 'J00934 · Access Control',
    risk: { score: 40, reason: 'high priority' },
    subtasks: [{ id:'s1', text:'Wire', done:true, position:0 }],
    comments: [{ id:'n1', body:'Ordered', author_id:'u1', author_name:'Oved Adani', at:'2026-06-17T00:00:00Z' }],
    activity: [{ id:'a1', type:'CREATED', description:'created the task', actor_id:'u1', actor_name:'Oved Adani', at:'2026-06-17T00:00:00Z', metadata:null }],
    watchers: [{ id:'u2', name:'Hazal' }],
  } } });
  const t = await getTask('t1');
  expect(mockApi.get).toHaveBeenCalledWith('/api/tasks/t1');
  expect(t.subtasks[0].text).toBe('Wire');
  expect(t.comments[0].author_name).toBe('Oved Adani');
  expect(t.activity[0].type).toBe('CREATED');
  expect(t.linked_entity?.label).toBe('J00934 · Access Control');
  expect(t.ai.risk_score).toBe(40);
});
```
- [ ] **Step 3: Run → fail.** `npm test --workspace=frontend -- tasks-store-api`
- [ ] **Step 4: Implement.** In `lib/api/tasks.ts`: extend `TaskRow` with `owner_name?: string|null`, `linked_entity_label?: string|null`, `risk?: {score:number;reason:string|null}`, `_count?: {subtasks:number}`. In `mapRowToTask`, set `owner_name: r.owner_name ?? null`, `linked_entity.label: r.linked_entity_label ?? ''`, `ai.risk_score: r.risk?.score ?? 0`, `ai.risk_reason: r.risk?.reason ?? null` (keep empty `subtasks`/`comments`/`activity`/`watcher_ids` for LIST rows). Add `mapDetailToTask(d)` that additionally maps `subtasks`, `comments`, `activity`, `watchers`, and `watcher_ids: d.watchers.map(w=>w.id)`. Add `getTask(id)`: `api.get('/api/tasks/'+id).then(r=>mapDetailToTask(r.data.task))`. In `tasksStore.ts`: add `fetchTaskDetail(id)` → `const full = await getTask(id); set(s=>({tasks: s.tasks.map(t=>t.id===id?full:t)}))`.
- [ ] **Step 5: Run → pass; `cd frontend && npx tsc --noEmit`** (note any FE tsc errors are this task's to resolve). Commit (stage the 4 files): `feat(tasks-fe): rich read model — getTask detail + BE name/label/risk mapping`

---

## Task 2: Rich write model (comment / subtask / watcher / nudge APIs + store actions)

**Files:** Modify `frontend/src/lib/api/tasks.ts`, `frontend/src/stores/tasksStore.ts`; Test `tasks-store-api.test.ts`

**Interfaces — Produces:** `addCommentApi(id, body)`, `addSubtaskApi(id, text)`, `updateSubtaskApi(id, sid, patch)`, `deleteSubtaskApi(id, sid)`, `nudgeApi(id)`; `updateTaskApi` patch type gains `watcher_ids?: string[]`; store actions `addComment`, `addSubtask`, `toggleSubtask`, `deleteSubtask`, `setWatchers`, `nudge` (each refreshes the task via `fetchTaskDetail` after the call).

- [ ] **Step 1: Failing tests** — `addCommentApi` POSTs `/api/tasks/:id/comments {body}`; `addSubtaskApi` POSTs `/api/tasks/:id/subtasks {text}`; `updateSubtaskApi` PATCHes `/api/tasks/:id/subtasks/:sid`; `deleteSubtaskApi` DELETEs it; `nudgeApi` POSTs `/api/tasks/:id/nudge`; `updateTaskApi` forwards `watcher_ids`.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** the five api functions (mirroring the existing `updateTaskApi` style) + extend `updateTaskApi`'s `patch` Pick to include `'watcher_ids'`. Add store actions; each mutates server-side then calls `get().fetchTaskDetail(id)` to resync (or re-fetches the list for `setWatchers`). `toggleSubtask(taskId, sid, done)` → `updateSubtaskApi(taskId, sid, {done})` then `fetchTaskDetail(taskId)`.
- [ ] **Step 4: Run → pass; tsc.** Commit: `feat(tasks-fe): comment/subtask/watcher/nudge api + store actions`

---

## Task 3: CreateTaskModal — real users + AI re-point

**Files:** Modify `frontend/src/components/tasks/CreateTaskModal.tsx`; Test new/`__tests__`

- [ ] Swap the owner `<select>` (lines ~194–196) for `<AssigneeSelect value={ownerId} onChange={setOwnerId} />`; swap the watchers checkbox group (~214–222) for `<MultiAssigneeSelect value={watcherIds} onChange={setWatcherIds} />`. Replace `taskAI.suggestAssignee(tasks, MOCK_PEOPLE.map(p=>p.id))` (line 52) with the real candidate IDs from `useAssignableUsers()` (`users.map(u=>u.id)`); map those users to `TaskPerson[]` for `taskAI.parse` (line 87) `{id, name:`${first_name} ${last_name}`, role:role.toLowerCase(), department:department?.id ?? ''}`; `MOCK_NOW`→`new Date()`. Replace `personName(suggestion.userId)` (line 205) with a lookup over the loaded users. Remove the `tasks-mock` import. Submit still calls `addTask(CreateTaskInput)` incl. `owner_id`, `watcher_ids`, `linked_entity`.
- [ ] Tests: render with a mocked `useAssignableUsers` (a couple of users), assert the owner/watcher selects show real names and that submit posts `owner_id`/`watcher_ids`. TDD. Commit: `feat(tasks-fe): CreateTaskModal real assignee/watcher pickers + real-data AI parse`

---

## Task 4: Filter bar, useFilteredTasks, drawer owner, command bar, MyDay user

**Files:** Modify `TaskFilterBar.tsx`, `lib/tasks/useFilteredTasks.ts`, `TaskDetailDrawer.tsx` (owner select + name display), `AiCommandBar.tsx`, `pages/tasks/views/MyDayView.tsx`; Tests

- [ ] `TaskFilterBar`: member `<Select>` from `useAssignableUsers()` (render `${first_name} ${last_name}`); department `<Select>` from `useDepartments()`. Remove mock import.
- [ ] `useFilteredTasks`: accept/derive the real user list (`useAssignableUsers()`), map to the `{id, department}` shape `applyTaskFilter` needs (`u.department?.id ?? null`), pass it instead of `MOCK_PEOPLE`.
- [ ] `TaskDetailDrawer`: owner `<select>`→`<AssigneeSelect>`; replace `personName(...)` calls for owner/watchers/comment-author/activity-actor with the BE-provided names (`task.owner_name`, `task.watchers`, `comment.author_name`, `activity.actor_name`); `MOCK_NOW`→`new Date()`.
- [ ] `AiCommandBar`: real users→`TaskPerson[]` + real entities (a lightweight `taskAI.parse` people source; entities can be left to modal resolution — pass `[]` entities and let the user pick in the modal); `MOCK_NOW`→`new Date()`.
- [ ] `MyDayView`: replace `CURRENT_USER_ID='u_oved'` with `useAuthStore(s=>s.user?.id)`; `MOCK_NOW`→`new Date()`.
- [ ] Tests for each touched unit (filter options from real data; useFilteredTasks department mapping; MyDay uses auth user). TDD. Commit: `feat(tasks-fe): real users in filter/drawer/command-bar + MyDay auth user`

---

## Task 5: LinkedEntitySelect component + CreateTaskModal/SuggestedTasksPanel wiring

**Files:** Create `frontend/src/components/tasks/LinkedEntitySelect.tsx`; Modify `CreateTaskModal.tsx`, `SuggestedTasksPanel.tsx`; Tests

- [ ] Build `LinkedEntitySelect` cloning the `CustomerSelect` popover+debounced-`useQuery` pattern: a type toggle (JOB/LEAD/CUSTOMER/ESTIMATE) + a debounced search hitting the matching endpoint (`/api/jobs?search=`, `/api/leads?search=`, `/api/customers?search=`, `/api/estimates?search=`); `onChange(entity: {type,id,label})`. The label string populates `linked_entity.label`.
- [ ] Wire it into `CreateTaskModal` replacing the `MOCK_ENTITIES` `<select>` (lines ~254–267); honor `presetEntity` (disabled, preset). 
- [ ] Fix `SuggestedTasksPanel`: rewrite `handleAccept` to call `addTask(CreateTaskInput)` (NOT a full `Task`); drop hardcoded `u_oved`/`MOCK_ENTITIES` — seed suggestions without a linked entity or against the current page entity if present.
- [ ] Tests: LinkedEntitySelect type-switch + search calls the right endpoint and emits `{type,id,label}`; SuggestedTasksPanel accept posts a `CreateTaskInput`. TDD. Commit: `feat(tasks-fe): LinkedEntitySelect real entity picker + SuggestedTasksPanel fix`

---

## Task 6: Detail drawer rich mutations (fetch-on-open, comments, subtasks, nudge, watchers)

**Files:** Modify `frontend/src/components/tasks/TaskDetailDrawer.tsx`; Tests

- [ ] On open (when `openTaskId` changes), call store `fetchTaskDetail(id)` so subtasks/comments/activity/watchers load from `GET /:id`.
- [ ] Replace the client-side subtask toggle (line ~256, currently `updateTask(...,{subtasks})`) with `toggleSubtask(task.id, sub.id, !sub.done)`; add an "add subtask" input → `addSubtask(task.id, text)` and a delete affordance → `deleteSubtask(task.id, sub.id)`.
- [ ] Add a comment composer (textarea + Post) → `addComment(task.id, body)`; the list re-renders from the refreshed detail.
- [ ] Add a **Nudge** button → `nudge(task.id)` (records activity; toast/inline confirm). 
- [ ] Watcher management via `<MultiAssigneeSelect value={task.watcher_ids} onChange={ids=>setWatchers(task.id, ids)} />`.
- [ ] Owner change already calls `updateTask(...,{owner_id})` — keep, now persisted by the API.
- [ ] Tests: opening fetches detail; posting a comment calls `addComment` + shows it; toggling a subtask calls `toggleSubtask`; nudge calls `nudge`; watcher change calls `setWatchers`. TDD. Commit: `feat(tasks-fe): drawer rich mutations wired to real endpoints`

---

## Task 7: MOCK_NOW sweep + name display across views + JobLeadTasksTab

**Files:** Modify `views/DashboardView.tsx`, `ListView.tsx`, `CalendarView.tsx`, `BoardView.tsx`, `HistoryView.tsx`, `components/tasks/JobLeadTasksTab.tsx`; Tests

- [ ] Replace every remaining `MOCK_NOW` with `new Date()` (Dashboard/Board/MyDay/List/Calendar/History per recon line refs). For views that recompute risk via `assessRisk`, prefer the BE `task.ai.risk_score` where a value exists; otherwise leave `assessRisk` (acceptable).
- [ ] Replace remaining `personName(...)` display calls (DashboardView "Open by Assignee", ListView owner column) with `task.owner_name` (BE) — or a small lookup from `useAssignableUsers()` where the row is an aggregate keyed by id.
- [ ] `JobLeadTasksTab`: it already filters by `linked_entity.id`; ensure it triggers a fetch (the store's `fetchTasks` or a linked fetch) and that "Generate tasks" uses `taskAI.suggestTasks(jobType)` + `addTask(CreateTaskInput)` per accepted item (drop the hand-built `Task`/`u_oved`).
- [ ] Tests: update view tests that referenced mock people; assert owner_name renders. TDD. Commit: `feat(tasks-fe): drop MOCK_NOW + mock names across views + real Job/Lead tab create`

---

## Task 8: Test reconciliation + final FE verification

**Files:** Modify `frontend/src/__tests__/taskAI.test.ts`, `tasks-logic.test.ts`, `task-filter-history.test.ts`, `tasks-workspace-redesign.test.tsx` as needed

- [ ] Update any remaining tests that relied on `MOCK_PEOPLE`/`MOCK_ENTITIES`/`MOCK_TASKS` so the suite reflects the real-data wiring (keep `tasks-mock` only as a test fixture where helpful). `taskAI.parse`/`suggestAssignee` tests pass explicit `people`/`candidateIds` arrays (they already take params — just confirm they don't import removed mocks at module scope of shipped code).
- [ ] **Final:** `npm test --workspace=frontend` (FULL FE suite green) and `cd frontend && npx tsc --noEmit` (0 errors). Report counts. Commit: `test(tasks-fe): reconcile task tests to real-data wiring`

---

## Self-Review (completed)
- **Coverage:** types/read (T1), write (T2), CreateModal pickers (T3), filter/drawer-owner/command/MyDay (T4), entity picker + suggestions (T5), drawer mutations (T6), MOCK_NOW/name sweep + Job tab (T7), tests (T8). Every recon mock site is assigned.
- **Contract consistency:** activity `type` UPPERCASE union (T1) matches BE; `linked_entity.label`/`owner_name`/`risk` from BE (T1); watcher_ids⇄watchers (T1/T6).
- **Reuse over rebuild:** AssigneeSelect/MultiAssigneeSelect/useAssignableUsers/useDepartments/CustomerSelect-pattern.
- **Open risk flagged inline:** activity-type case reconciliation (T1); ACTIVITY_LABELS must be re-keyed to UPPERCASE when T1 changes the union — fold into T1.

## Next: Plan 3 — Job command-center task signals (separate file, after Plan 2 lands).
