# Tasks Module — Job Command-Center Task Signals (Plan 3 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Builds on Plan 1 (backend) + Plan 2 (frontend), both complete on this branch. Branch `feat/tasks-db-backed`, worktree `../alpha_crm-worktrees/tasks-module`.

**Goal:** Surface task health on the Job command center — open/overdue/next-due chips + a Tasks-tab count badge, an overdue/at-risk strip, and a "New task for this job" quick action — backed by a lightweight per-entity task-summary endpoint.

**Architecture:** One new read-only backend endpoint `GET /api/tasks/summary?linked_entity_type&linked_entity_id` reusing Plan-1's `taskVisibilityWhere` + `computeTaskRisk`. Frontend mirrors the existing `getJobFinancials` hook pattern (`lib/api/jobs.ts` + inline `useQuery` in `JobDetailPage`). All additive; scoped to the Job page (Leads already have the real tab from Plan 2).

**Tech Stack:** Node/Express/Prisma/Zod (BE), React+TanStack Query (FE, the jobs hooks already use it), vitest.

## Global Constraints
- TDD; tenant-scope every query (`taskVisibilityWhere` already does); route `GET /summary` MUST be registered BEFORE `GET /:id` (else Express routes `summary` into `getOne`).
- "at-risk" = `computeTaskRisk(task, now).score >= 50` (matches the FE `assessRisk` `atRisk` threshold in `tasks-logic.ts`).
- Branch/worktree discipline; stage-only-your-files; PRs target `servwave`.
- Pass the JOB **UUID** (`job.id`) as `linked_entity_id` (not `job_number`).

---

## File Structure
- **Modify** `backend/src/controllers/task.controller.ts` — add `summary` handler.
- **Modify** `backend/src/routes/task.routes.ts` — add `GET /summary` before `GET /:id`.
- **Modify** `backend/src/__tests__/tasks.test.ts` — summary tests.
- **Modify** `frontend/src/lib/api/jobs.ts` — `JobTaskSummary` + `getJobTaskSummary`.
- **Modify** `frontend/src/pages/JobDetailPage.tsx` — query + chips + at-risk strip + tab badge + New-Task button/modal + invalidation.
- **Test** `frontend/src/__tests__/job-task-signals.test.tsx` (new).

---

## Task 1: Backend `GET /api/tasks/summary` endpoint

**Files:** Modify `task.controller.ts`, `task.routes.ts`; Test `tasks.test.ts`

**Interfaces — Produces:** `GET /api/tasks/summary?linked_entity_type=JOB&linked_entity_id=<uuid>` → `{ open, overdue, at_risk, next_due_at }`. 400 if either param missing.

- [ ] **Step 1: Failing tests** (extend `tasks.test.ts`):
```ts
describe('GET /api/tasks/summary', () => {
  it('400 without entity params', async () => {
    mockAuthAs('admin');
    const res = await request(app).get('/api/tasks/summary').set(authHeader('admin'));
    expect(res.status).toBe(400);
  });
  it('returns open/overdue/at_risk/next_due_at for the entity (tenant-scoped)', async () => {
    mockAuthAs('admin');
    const now = Date.now();
    mockPrisma.task.findMany.mockResolvedValue([
      { status: 'TODO', priority: 'URGENT', due_at: new Date(now - 86400000), completed_at: null }, // overdue + at-risk
      { status: 'IN_PROGRESS', priority: 'LOW', due_at: new Date(now + 2*86400000), completed_at: null }, // open, future
      { status: 'DONE', priority: 'HIGH', due_at: new Date(now - 5*86400000), completed_at: new Date() }, // ignored
    ]);
    const res = await request(app)
      .get(`/api/tasks/summary?linked_entity_type=JOB&linked_entity_id=${JOB_ID}`)
      .set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ open: 2, overdue: 1 });
    expect(res.body.at_risk).toBeGreaterThanOrEqual(1);
    expect(res.body.next_due_at).not.toBeNull();
    const where = (mockPrisma.task.findMany.mock.calls[0][0] as any).where;
    expect(where).toMatchObject({ organization_id: ALPHA_ORG_ID, linked_entity_type: 'JOB', linked_entity_id: JOB_ID });
  });
});
```
- [ ] **Step 2: Run → fail.** `npm test --workspace=backend -- tasks`
- [ ] **Step 3: Implement `summary`** in `task.controller.ts` (reuses `taskVisibilityWhere` + `computeTaskRisk`, already imported):
```ts
export async function summary(req: Request, res: Response) {
  try {
    const { linked_entity_type, linked_entity_id } = req.query as Record<string, string | undefined>;
    if (!linked_entity_type || !linked_entity_id) {
      res.status(400).json({ error: 'linked_entity_type and linked_entity_id are required' });
      return;
    }
    const where = taskVisibilityWhere(req, { linked_entity_type, linked_entity_id });
    const tasks = await prisma.task.findMany({
      where, select: { status: true, priority: true, due_at: true, completed_at: true },
    });
    const now = new Date();
    let open = 0, overdue = 0, at_risk = 0;
    let next: Date | null = null;
    for (const t of tasks) {
      if (t.status === 'DONE') continue;
      open++;
      if (t.due_at && t.due_at < now) overdue++;
      if (computeTaskRisk(t, now).score >= 50) at_risk++;
      if (t.due_at && t.due_at > now && (!next || t.due_at < next)) next = t.due_at;
    }
    res.json({ open, overdue, at_risk, next_due_at: next ? next.toISOString() : null });
  } catch (err) {
    logger.error('Task summary error:', err);
    res.status(500).json({ error: 'Failed to compute task summary' });
  }
}
```
Route in `task.routes.ts` — insert BEFORE `GET /:id`:
```ts
router.get('/summary', canDo('read', 'Task'), ctrl.summary);
```
- [ ] **Step 4: Run → pass** (`npm test --workspace=backend -- tasks`) + `cd backend && npx tsc --noEmit` (only the 2 pre-existing jobs.test.ts errors). 
- [ ] **Step 5: Commit** (stage controller+routes+test): `feat(tasks): GET /api/tasks/summary (open/overdue/at-risk/next-due per entity)`

---

## Task 2: Frontend Job command-center task signals

**Files:** Modify `frontend/src/lib/api/jobs.ts`, `frontend/src/pages/JobDetailPage.tsx`; Test `frontend/src/__tests__/job-task-signals.test.tsx`

**Interfaces — Consumes:** `GET /api/tasks/summary`. **Produces:** `getJobTaskSummary(id)`, `JobTaskSummary`.

- [ ] **Step 1: `jobs.ts`** — add:
```ts
export interface JobTaskSummary { open: number; overdue: number; at_risk: number; next_due_at: string | null; }
export function getJobTaskSummary(id: string): Promise<JobTaskSummary> {
  return api.get('/api/tasks/summary', { params: { linked_entity_type: 'JOB', linked_entity_id: id } }).then((r) => r.data);
}
```
- [ ] **Step 2: Failing test** (`job-task-signals.test.tsx`) — render `JobDetailPage` (mock the job fetch + `getJobTaskSummary` → `{open:3, overdue:1, at_risk:2, next_due_at:'2026-06-20T17:00:00Z'}`) and assert: the open/overdue/next-due chips render those values; the Tasks tab shows a count badge; the at-risk/overdue strip renders; clicking "New Task" opens `CreateTaskModal`. (Mock the summary hook + use `renderWithProviders`; follow the existing JobDetailPage test setup in `job-command-center.test.tsx`/`job-detail-page.test.tsx`.)
- [ ] **Step 3: Run → fail.** `npm test --workspace=frontend -- job-task-signals`
- [ ] **Step 4: Implement in `JobDetailPage.tsx`** (per recon insertion points):
  - After the `financials` `useQuery` (~line 244): add `const { data: taskSummary } = useQuery({ queryKey: ['job-task-summary', id], queryFn: () => getJobTaskSummary(id!), enabled: !!id });`
  - In `invalidateJob()` (~line 248–252): also `queryClient.invalidateQueries({ queryKey: ['job-task-summary', id] })`.
  - **Stat chips:** between the 5-card KPI grid (~line 646) and `<JobLifecycleBar>` (~line 649), add a small row showing Open (`taskSummary?.open ?? 0`), Overdue (`taskSummary?.overdue ?? 0`, danger-toned when >0), and Next due (`taskSummary?.next_due_at` formatted, or "—"). Follow the existing summary-card styling.
  - **At-risk strip:** inside the command-center `<Card>`, between the reopen-error strip (~line 587) and the KPI grid (~line 590): render only when `taskSummary && (taskSummary.overdue>0 || taskSummary.at_risk>0)` — an amber/warning strip with `AlertTriangle` summarizing overdue (preferred) or at-risk count. Use the status `warning`/`danger` tokens (NOT notify red).
  - **Tasks tab badge:** at the Tasks `<TabsTrigger>` (~line 674–676), mirror the Work Items count pattern (line 665–669): `Tasks {taskSummary?.open ? <span className="ml-1.5 text-xs text-text-secondary">({taskSummary.open})</span> : null}`.
  - **Quick action:** add `const [newTaskOpen, setNewTaskOpen] = useState(false)` with the other dialog state (~line 229); a `<Button variant="outline" onClick={()=>setNewTaskOpen(true)}>` ("New Task", with a lucide icon) in the action cluster (~line 496); and mount `<CreateTaskModal open={newTaskOpen} onOpenChange={setNewTaskOpen} presetEntity={{ type:'JOB', id: job.id, label: \`${job.job_number} — ${customerName}\` }} />` with the other dialogs (~line 1012). Import `CreateTaskModal` from `@/components/tasks/CreateTaskModal`.
- [ ] **Step 5: Run → pass** (`npm test --workspace=frontend -- job-task-signals`) + keep full suite green + `cd frontend && npx tsc --noEmit` (0 errors).
- [ ] **Step 6: Commit** (stage jobs.ts + JobDetailPage + test): `feat(tasks-fe): job command-center task signals (chips, at-risk strip, tab badge, quick action)`

---

## Self-Review (completed)
- **Coverage:** summary endpoint (T1) feeds chips + strip + badge (T2); quick action (T2) reuses the Plan-2 CreateTaskModal with the JOB UUID. Matches the user's selected Jobs-depth surfaces (at-a-glance signals + tab badge; overdue/at-risk strip; create quick action). Auto-generate-on-create was NOT selected → not here.
- **Route safety:** `GET /summary` before `GET /:id` (T1) — called out explicitly.
- **UUID:** quick action uses `job.id` (UUID), consistent with the Plan-2 final-review fix.
- **Risk threshold** shared: BE `score>=50` matches FE `assessRisk.atRisk`.

## Done after this: full module (Plan 1 BE + Plan 2 FE + Plan 3 Jobs signals) complete. Final whole-branch review + finishing-a-development-branch.
