# Tasks Module — Backend Full-Rich Implementation Plan (Plan 1 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand the lean Task backend into the full-rich, tenant-scoped, role-visible API the PRD (GitHub #231) specifies — subtasks, comments, activity feed, watchers, AI provenance, computed risk, scoped listing, entity-label/owner-name resolution — all TDD-first against the mocked-Prisma vitest harness.

**Architecture:** Reuse two battle-tested polymorphic models — **`Note`** (task comments, `entity_type='TASK'`) and **`TimelineEvent`** (task activity feed, `entity_type='TASK'`, `event_type=<activity type>`). Add exactly one new table, **`TaskSubtask`**, plus `watcher_ids`/`ai_source`/`ai_suggested_by` columns and a `TaskSource` enum on `Task`. Pure deep modules (`risk`, `visibility`, `activity-diff`, `enrich`) hold the logic; the controller orchestrates them. Risk is **computed on read**, never stored.

**Tech Stack:** Node 20 + Express + TypeScript, Prisma (Supabase Postgres 15), Zod, CASL, vitest + supertest (Prisma fully mocked — no DB in tests).

## Global Constraints

- **TDD always** — failing test → minimal code → green → commit. (Project rule: strict backend TDD.)
- **Tenant scope every query** — spread `tenantWhere(req)` into every `where`/`data` (`backend/src/lib/tenant.ts`).
- **Idempotent migration** — hand-author the SQL with `IF NOT EXISTS` / `DO $$…$$` guards. Staging is a **shared** DB across branches. **Do NOT run `prisma migrate dev`/`deploy` locally** (local `.env` `DATABASE_URL` points at shared staging). Use `npx prisma generate` to refresh the client/types only; the migration is applied to staging **deliberately, later** (owner via Supabase MCP `apply_migration`).
- **CASL gating unchanged** — routes keep `canDo(<action>,'Task')`; ADMIN immune, TECHNICIAN has no `delete:Task`.
- **No AI attribution in git** — conventional commit lines only.
- **Branch/worktree** — all work on `feat/tasks-db-backed` in worktree `../alpha_crm-worktrees/tasks-module`. PRs target `servwave`.
- **Commands:** `npm test --workspace=backend` (vitest). Single file: `npm test --workspace=backend -- tasks`. Types: `npx tsc --noEmit` in `backend/`.

---

## File Structure

- **Modify** `backend/prisma/schema.prisma` — `TaskSource` enum; add `TASK` to `NoteEntity`; `Task` gets `watcher_ids`, `ai_source`, `ai_suggested_by`, `subtasks TaskSubtask[]`; new `TaskSubtask` model.
- **Create** `backend/prisma/migrations/<timestamp>_task_full_rich/migration.sql` — idempotent.
- **Create** `backend/src/lib/tasks/risk.ts` — `computeTaskRisk(task, now)` (pure).
- **Create** `backend/src/lib/tasks/visibility.ts` — `taskVisibilityWhere(req, filters)`.
- **Create** `backend/src/lib/tasks/activity.ts` — `recordTaskActivity(tx, …)`, `diffTaskActivities(before, after)`, `TASK_ENTITY_TYPE`.
- **Create** `backend/src/lib/tasks/enrich.ts` — `resolveEntityLabels`, `resolveUserNames`, `customerLabel`, `userFullName`.
- **Modify** `backend/src/controllers/task.controller.ts` — expand handlers + Zod schemas.
- **Modify** `backend/src/routes/task.routes.ts` — add detail/comment/subtask/nudge routes.
- **Modify** `backend/src/__tests__/setup.ts` — add `taskSubtask` mock + `note.findFirst`.
- **Create** `backend/src/__tests__/task-modules.test.ts` — unit tests for the pure modules.
- **Modify** `backend/src/__tests__/tasks.test.ts` — endpoint cases.

---

## Task 1: Schema + idempotent migration + test-mock surface

**Files:**
- Modify: `backend/prisma/schema.prisma` (Task model ~2755; `NoteEntity` ~1221)
- Create: `backend/prisma/migrations/<timestamp>_task_full_rich/migration.sql`
- Modify: `backend/src/__tests__/setup.ts` (prisma mock block)

**Interfaces — Produces:** Prisma types `TaskSource`, `TaskSubtask`; `Task.watcher_ids: string[]`, `Task.ai_source: TaskSource`, `Task.ai_suggested_by: string | null`; `NoteEntity.TASK`.

- [ ] **Step 1: Edit `schema.prisma`.** Add the enum, extend `NoteEntity`, extend `Task`, add `TaskSubtask`:

```prisma
enum TaskSource {
  MANUAL
  AI_NL
  AI_TEMPLATE
  AI_EXTRACT
}
```

In `enum NoteEntity { CUSTOMER LEAD ESTIMATE JOB INVOICE }` add `TASK` as the last value.

In `model Task`, after `tags String[] @default([])` add:
```prisma
  watcher_ids        String[]     @default([]) @db.Uuid
  ai_source          TaskSource   @default(MANUAL)
  ai_suggested_by    String?
```
and in its relation block add:
```prisma
  subtasks     TaskSubtask[]
```

New model (place after `Task`):
```prisma
model TaskSubtask {
  id         String   @id @default(uuid()) @db.Uuid
  task_id    String   @db.Uuid
  text       String
  done       Boolean  @default(false)
  position   Int      @default(0)
  created_at DateTime @default(now())
  task       Task     @relation(fields: [task_id], references: [id], onDelete: Cascade)

  @@index([task_id])
  @@map("task_subtasks")
}
```

- [ ] **Step 2: Hand-author the idempotent migration.** Create the folder with a timestamp matching the repo convention (e.g. `20260617120000_task_full_rich`), file `migration.sql`:

```sql
-- TaskSource enum
DO $$ BEGIN
  CREATE TYPE "TaskSource" AS ENUM ('MANUAL', 'AI_NL', 'AI_TEMPLATE', 'AI_EXTRACT');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Extend NoteEntity with TASK (PG12+ allows ADD VALUE; IF NOT EXISTS makes it idempotent)
ALTER TYPE "NoteEntity" ADD VALUE IF NOT EXISTS 'TASK';

-- Task columns
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "watcher_ids" UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "ai_source" "TaskSource" NOT NULL DEFAULT 'MANUAL';
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "ai_suggested_by" TEXT;

-- task_subtasks
CREATE TABLE IF NOT EXISTS "task_subtasks" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "task_id" UUID NOT NULL,
  "text" TEXT NOT NULL,
  "done" BOOLEAN NOT NULL DEFAULT false,
  "position" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "task_subtasks_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "task_subtasks_task_id_idx" ON "task_subtasks"("task_id");
DO $$ BEGIN
  ALTER TABLE "task_subtasks" ADD CONSTRAINT "task_subtasks_task_id_fkey"
    FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
```
> Note: `ALTER TYPE … ADD VALUE` must be the only enum mutation and is not used within this same migration's later statements — safe on Supabase PG15.

- [ ] **Step 3: Add the `taskSubtask` mock + `note.findFirst`** to `setup.ts`. In the `task: { … }` block's vicinity add:
```ts
    taskSubtask: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
```
And extend the existing `note` mock to include `findFirst: vi.fn()` (used by the comment endpoint's tenant check).

- [ ] **Step 4: Regenerate client + typecheck.** Run: `cd backend && npx prisma generate && npx prisma validate && npx tsc --noEmit`
Expected: validate OK; tsc passes (new types exist). **Do not run `prisma migrate`.**

- [ ] **Step 5: Commit.**
```bash
git add backend/prisma/schema.prisma backend/prisma/migrations backend/src/__tests__/setup.ts
git commit -m "feat(tasks): full-rich schema — subtasks, watchers, AI source; reuse Note/TimelineEvent"
```

---

## Task 2: Risk evaluator (pure)

**Files:** Create `backend/src/lib/tasks/risk.ts`; Test `backend/src/__tests__/task-modules.test.ts`

**Interfaces — Produces:** `computeTaskRisk(task: {status; priority; due_at; completed_at}, now: Date): { score: number; reason: string | null }`

- [ ] **Step 1: Failing test** (create `task-modules.test.ts`):
```ts
import { describe, it, expect } from 'vitest';
import { computeTaskRisk } from '../lib/tasks/risk';

const NOW = new Date('2026-06-17T12:00:00Z');

describe('computeTaskRisk', () => {
  it('DONE tasks are always zero-risk', () => {
    expect(computeTaskRisk({ status: 'DONE', priority: 'URGENT', due_at: '2026-06-01T00:00:00Z', completed_at: NOW }, NOW))
      .toEqual({ score: 0, reason: null });
  });
  it('overdue + urgent + blocked stacks toward high risk', () => {
    const r = computeTaskRisk({ status: 'BLOCKED', priority: 'URGENT', due_at: '2026-06-14T12:00:00Z', completed_at: null }, NOW);
    expect(r.score).toBeGreaterThanOrEqual(90);
    expect(r.reason).toContain('overdue');
    expect(r.reason).toContain('blocked');
  });
  it('low priority, no due date → low score, null-ish reason', () => {
    expect(computeTaskRisk({ status: 'TODO', priority: 'LOW', due_at: null, completed_at: null }, NOW).score).toBe(0);
  });
});
```

- [ ] **Step 2: Run → fail.** `npm test --workspace=backend -- task-modules` → FAIL (module not found).

- [ ] **Step 3: Implement `risk.ts`:**
```ts
type Priority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
type Status = 'TODO' | 'IN_PROGRESS' | 'BLOCKED' | 'DONE';

export interface TaskRisk { score: number; reason: string | null; }

const PRIORITY_WEIGHT: Record<Priority, number> = { LOW: 0, MEDIUM: 20, HIGH: 45, URGENT: 70 };

export function computeTaskRisk(
  task: { status: Status; priority: Priority; due_at: Date | string | null; completed_at: Date | string | null },
  now: Date,
): TaskRisk {
  if (task.status === 'DONE' || task.completed_at) return { score: 0, reason: null };

  let score = PRIORITY_WEIGHT[task.priority] ?? 0;
  const reasons: string[] = [];
  if (task.priority === 'URGENT' || task.priority === 'HIGH') reasons.push(`${task.priority.toLowerCase()} priority`);

  if (task.due_at) {
    const overdueMs = now.getTime() - new Date(task.due_at).getTime();
    if (overdueMs >= 86_400_000) {
      const days = Math.floor(overdueMs / 86_400_000);
      score += Math.min(30, 10 + days * 5);
      reasons.push(`${days}d overdue`);
    } else if (overdueMs >= 0) {
      score += 12; reasons.push('due today');
    }
  }
  if (task.status === 'BLOCKED') { score += 20; reasons.push('blocked'); }

  score = Math.min(100, score);
  return { score, reason: reasons.length ? reasons.join(' · ') : null };
}
```

- [ ] **Step 4: Run → pass.** `npm test --workspace=backend -- task-modules` → PASS.
- [ ] **Step 5: Commit.** `feat(tasks): deterministic risk evaluator (priority + overdue + blocked)`

---

## Task 3: Visibility policy (pure)

**Files:** Create `backend/src/lib/tasks/visibility.ts`; Test append to `task-modules.test.ts`

**Interfaces — Consumes:** `tenantWhere(req)`. **Produces:** `taskVisibilityWhere(req, filters: { linked_entity_type?: string; linked_entity_id?: string }): Record<string, unknown>`

- [ ] **Step 1: Failing test** (append):
```ts
import { taskVisibilityWhere } from '../lib/tasks/visibility';

const reqAs = (role: string, id: string) =>
  ({ user: { id, role, organization_id: 'org-1' } } as any);

describe('taskVisibilityWhere', () => {
  it('ADMIN hub → org-only, no OR scoping', () => {
    const w = taskVisibilityWhere(reqAs('ADMIN', 'u-admin'), {});
    expect(w.organization_id).toBe('org-1');
    expect(w.OR).toBeUndefined();
  });
  it('non-admin hub → owner OR watcher', () => {
    const w = taskVisibilityWhere(reqAs('TECHNICIAN', 'u-tech'), {});
    expect(w.OR).toEqual([{ owner_id: 'u-tech' }, { watcher_ids: { has: 'u-tech' } }]);
  });
  it('entity filter → entity-wide, no personal scoping even for non-admin', () => {
    const w = taskVisibilityWhere(reqAs('SALES', 'u-sales'), { linked_entity_type: 'JOB', linked_entity_id: 'job-1' });
    expect(w.linked_entity_type).toBe('JOB');
    expect(w.linked_entity_id).toBe('job-1');
    expect(w.OR).toBeUndefined();
  });
});
```
> `tenantWhere` reads `req.user.organization_id`; the stub above satisfies it. If `tenantWhere`'s shape differs, confirm at `backend/src/lib/tenant.ts` and align the stub.

- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement `visibility.ts`:**
```ts
import type { Request } from 'express';
import { tenantWhere } from '../tenant';

export interface TaskListFilters { linked_entity_type?: string; linked_entity_id?: string; }

export function taskVisibilityWhere(req: Request, filters: TaskListFilters): Record<string, unknown> {
  const where: Record<string, unknown> = { ...tenantWhere(req) };
  if (filters.linked_entity_type && filters.linked_entity_id) {
    where.linked_entity_type = filters.linked_entity_type;
    where.linked_entity_id = filters.linked_entity_id;
    return where;
  }
  if (req.user!.role !== 'ADMIN') {
    const me = req.user!.id;
    where.OR = [{ owner_id: me }, { watcher_ids: { has: me } }];
  }
  return where;
}
```
- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit.** `feat(tasks): role-aware task visibility scope (admin-all / others own+watched / entity-wide)`

---

## Task 4: Activity recorder + diff

**Files:** Create `backend/src/lib/tasks/activity.ts`; Test append to `task-modules.test.ts`

**Interfaces — Produces:** `TASK_ENTITY_TYPE='TASK'`; `type TaskActivityType`; `recordTaskActivity(tx, {taskId, orgId, actorId, type, description, metadata?}): Promise<void>`; `diffTaskActivities(before, after): {type, description}[]`

- [ ] **Step 1: Failing test** (append — pure `diff` only):
```ts
import { diffTaskActivities } from '../lib/tasks/activity';

describe('diffTaskActivities', () => {
  it('status→DONE yields COMPLETED', () => {
    expect(diffTaskActivities({ status: 'TODO' }, { status: 'DONE' })[0].type).toBe('COMPLETED');
  });
  it('owner change yields ASSIGNED; due change yields DUE_CHANGED', () => {
    const evs = diffTaskActivities(
      { owner_id: null, due_at: null },
      { owner_id: 'u-2', due_at: '2026-07-01T00:00:00Z' },
    );
    expect(evs.map((e) => e.type).sort()).toEqual(['ASSIGNED', 'DUE_CHANGED']);
  });
  it('no changes → empty', () => {
    expect(diffTaskActivities({ status: 'TODO' }, {})).toEqual([]);
  });
});
```

- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement `activity.ts`:**
```ts
import type { Prisma, PrismaClient } from '@prisma/client';

export const TASK_ENTITY_TYPE = 'TASK';

export type TaskActivityType =
  | 'CREATED' | 'ASSIGNED' | 'STATUS_CHANGED' | 'PRIORITY_CHANGED'
  | 'DUE_CHANGED' | 'COMMENTED' | 'NUDGED' | 'COMPLETED';

type Tx = PrismaClient | Prisma.TransactionClient;

export async function recordTaskActivity(
  tx: Tx,
  a: { taskId: string; orgId: string; actorId: string; type: TaskActivityType; description: string; metadata?: Prisma.InputJsonValue },
): Promise<void> {
  await tx.timelineEvent.create({
    data: {
      organization_id: a.orgId,
      entity_type: TASK_ENTITY_TYPE,
      entity_id: a.taskId,
      event_type: a.type,
      description: a.description,
      metadata: a.metadata,
      created_by: a.actorId,
    },
  });
}

interface BA { status?: string; priority?: string; owner_id?: string | null; due_at?: Date | string | null; }

export function diffTaskActivities(before: BA, after: BA): { type: TaskActivityType; description: string }[] {
  const out: { type: TaskActivityType; description: string }[] = [];
  if (after.status !== undefined && after.status !== before.status) {
    out.push(after.status === 'DONE'
      ? { type: 'COMPLETED', description: 'marked the task complete' }
      : { type: 'STATUS_CHANGED', description: `changed status to ${after.status}` });
  }
  if (after.priority !== undefined && after.priority !== before.priority)
    out.push({ type: 'PRIORITY_CHANGED', description: `changed priority to ${after.priority}` });
  if (after.owner_id !== undefined && after.owner_id !== before.owner_id)
    out.push({ type: 'ASSIGNED', description: after.owner_id ? 'reassigned the task' : 'unassigned the task' });
  if (after.due_at !== undefined && String(after.due_at ?? '') !== String(before.due_at ?? ''))
    out.push({ type: 'DUE_CHANGED', description: after.due_at ? 'changed the due date' : 'cleared the due date' });
  return out;
}
```
- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit.** `feat(tasks): activity recorder over TimelineEvent + PATCH diff`

---

## Task 5: Entity-label + user-name resolvers

**Files:** Create `backend/src/lib/tasks/enrich.ts`; Test append to `task-modules.test.ts`

**Interfaces — Produces:** `userFullName(u)`, `customerLabel(c)`, `resolveEntityLabels(orgId, refs): Promise<Map<string,string>>` (key `"TYPE:id"`), `resolveUserNames(orgId, ids): Promise<Map<string,string>>`

- [ ] **Step 1: Failing test** (append; the pure formatters only — resolvers are covered by endpoint tests since they hit mocked prisma):
```ts
import { userFullName, customerLabel } from '../lib/tasks/enrich';

describe('enrich formatters', () => {
  it('userFullName joins first + last', () => {
    expect(userFullName({ first_name: 'Oved', last_name: 'Adani' })).toBe('Oved Adani');
  });
  it('customerLabel prefers company_name, falls back to person, then number', () => {
    expect(customerLabel({ company_name: 'Acme', first_name: null, last_name: null, customer_number: 'C00001' })).toBe('Acme');
    expect(customerLabel({ company_name: null, first_name: 'Gail', last_name: 'Levi', customer_number: 'C00002' })).toBe('Gail Levi');
    expect(customerLabel({ company_name: null, first_name: null, last_name: null, customer_number: 'C00003' })).toBe('C00003');
  });
});
```

- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement `enrich.ts`** (real schema fields: User `first_name`/`last_name`; Job `job_number`/`job_type`; Lead `lead_number`/`job_type`; Estimate `estimate_number`; Customer `company_name`/`first_name`/`last_name`/`customer_number`):
```ts
import { prisma } from '../prisma';

export function userFullName(u: { first_name?: string | null; last_name?: string | null }): string {
  return `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim();
}
export function customerLabel(c: { company_name?: string | null; first_name?: string | null; last_name?: string | null; customer_number: string }): string {
  if (c.company_name) return c.company_name;
  const person = `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim();
  return person || c.customer_number;
}

const k = (t: string, id: string) => `${t}:${id}`;

export async function resolveEntityLabels(orgId: string, refs: { type: string; id: string }[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const by: Record<string, string[]> = {};
  for (const r of refs) if (r.type && r.id) (by[r.type] ??= []).push(r.id);

  if (by.JOB?.length) {
    const rows = await prisma.job.findMany({ where: { id: { in: by.JOB }, organization_id: orgId }, select: { id: true, job_number: true, job_type: true } });
    rows.forEach((j) => out.set(k('JOB', j.id), j.job_type ? `${j.job_number} · ${j.job_type}` : j.job_number));
  }
  if (by.LEAD?.length) {
    const rows = await prisma.lead.findMany({ where: { id: { in: by.LEAD }, organization_id: orgId }, select: { id: true, lead_number: true, job_type: true } });
    rows.forEach((l) => out.set(k('LEAD', l.id), l.job_type ? `${l.lead_number} · ${l.job_type}` : l.lead_number));
  }
  if (by.ESTIMATE?.length) {
    const rows = await prisma.estimate.findMany({ where: { id: { in: by.ESTIMATE }, organization_id: orgId }, select: { id: true, estimate_number: true } });
    rows.forEach((e) => out.set(k('ESTIMATE', e.id), e.estimate_number));
  }
  if (by.CUSTOMER?.length) {
    const rows = await prisma.customer.findMany({ where: { id: { in: by.CUSTOMER }, organization_id: orgId }, select: { id: true, company_name: true, first_name: true, last_name: true, customer_number: true } });
    rows.forEach((c) => out.set(k('CUSTOMER', c.id), customerLabel(c)));
  }
  return out;
}

export async function resolveUserNames(orgId: string, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return out;
  const rows = await prisma.user.findMany({ where: { id: { in: unique }, organization_id: orgId }, select: { id: true, first_name: true, last_name: true } });
  rows.forEach((u) => out.set(u.id, userFullName(u)));
  return out;
}
```
> Confirm `Lead`/`Estimate`/`Job` field names against `schema.prisma` lines noted in the plan header before finalizing the `select`s.

- [ ] **Step 4: Run → pass.** **Step 5: Commit.** `feat(tasks): entity-label + user-name batch resolvers`

---

## Task 6: Scoped + enriched list endpoint

**Files:** Modify `backend/src/controllers/task.controller.ts` (`list`); Test `backend/src/__tests__/tasks.test.ts`

**Interfaces — Consumes:** `taskVisibilityWhere`, `resolveEntityLabels`, `resolveUserNames`, `computeTaskRisk`. **Produces:** `GET /api/tasks` → `{ tasks: TaskSummary[] }` where each summary adds `owner_name`, `linked_entity_label`, `risk:{score,reason}`, `subtask_done`, `subtask_total`, `comment_count`.

- [ ] **Step 1: Failing tests** (extend the existing `GET /api/tasks` describe). Keep the existing three; add:
```ts
it('non-admin list is scoped to owner OR watcher', async () => {
  mockAuthAs('technician');
  await request(app).get('/api/tasks').set(authHeader('technician'));
  const where = (mockPrisma.task.findMany.mock.calls[0][0] as any).where;
  expect(where.OR).toEqual([
    { owner_id: expect.any(String) },
    { watcher_ids: { has: expect.any(String) } },
  ]);
});

it('list enriches each task with owner_name, label, and risk', async () => {
  mockAuthAs('admin');
  mockPrisma.task.findMany.mockResolvedValue([{ ...TASK_FIXTURE, owner_id: '00000000-0000-0000-0000-000000000001' }]);
  // owner-name + label resolvers read these:
  mockPrisma.user.findMany.mockResolvedValue([{ id: '00000000-0000-0000-0000-000000000001', first_name: 'Oved', last_name: 'Adani' }]);
  mockPrisma.job.findMany.mockResolvedValue([{ id: JOB_ID, job_number: 'J00934', job_type: 'Access Control' }]);
  const res = await request(app).get('/api/tasks').set(authHeader('admin'));
  expect(res.body.tasks[0].owner_name).toBe('Oved Adani');
  expect(res.body.tasks[0].linked_entity_label).toBe('J00934 · Access Control');
  expect(res.body.tasks[0].risk).toHaveProperty('score');
});
```

- [ ] **Step 2: Run → fail** (`owner_name` undefined / `OR` absent).
- [ ] **Step 3: Implement** — replace the body of `list`:
```ts
export async function list(req: Request, res: Response) {
  try {
    const { linked_entity_type, linked_entity_id } = req.query as Record<string, string | undefined>;
    const where = taskVisibilityWhere(req, { linked_entity_type, linked_entity_id });

    const tasks = await prisma.task.findMany({
      where,
      orderBy: { created_at: 'desc' },
      include: { _count: { select: { subtasks: true } } },
    });

    const orgId = req.user!.organization_id;
    const labels = await resolveEntityLabels(orgId,
      tasks.filter((t) => t.linked_entity_type && t.linked_entity_id)
           .map((t) => ({ type: t.linked_entity_type as string, id: t.linked_entity_id as string })));
    const names = await resolveUserNames(orgId, tasks.map((t) => t.owner_id).filter(Boolean) as string[]);
    const now = new Date();

    res.json({
      tasks: tasks.map((t) => ({
        ...t,
        owner_name: t.owner_id ? names.get(t.owner_id) ?? null : null,
        linked_entity_label:
          t.linked_entity_type && t.linked_entity_id
            ? labels.get(`${t.linked_entity_type}:${t.linked_entity_id}`) ?? null
            : null,
        risk: computeTaskRisk(t, now),
      })),
    });
  } catch (err) {
    logger.error('List tasks error:', err);
    res.status(500).json({ error: 'Failed to list tasks' });
  }
}
```
> `subtask_done`/`comment_count` need extra queries; defer the *counts* to Task 10/9 where those models are wired, OR add `_count` for subtasks now (shown) and comment_count in Task 9. The fixture lacks `_count`; add `_count: { subtasks: 0 }` to `TASK_FIXTURE` in `beforeEach` to keep existing tests green.

- [ ] **Step 4: Run → pass** (`npm test --workspace=backend -- tasks`). Fix the fixture if `_count` access throws.
- [ ] **Step 5: Commit.** `feat(tasks): scoped + enriched task list (owner name, entity label, risk)`

---

## Task 7: `GET /api/tasks/:id` detail with includes

**Files:** Modify `task.controller.ts` (`getOne`), `task.routes.ts`; Test `tasks.test.ts`

**Interfaces — Produces:** `GET /api/tasks/:id` → `{ task: TaskDetail }` = summary + `subtasks[]` (ordered), `comments[]` (`{id, body, author_id, author_name, at}` from `Note`), `activity[]` (`{id, type, description, actor_id, actor_name, at, metadata}` from `TimelineEvent`), `watchers[] ({id,name})`.

- [ ] **Step 1: Failing test:**
```ts
describe('GET /api/tasks/:id', () => {
  it('returns task with subtasks, comments, activity, watcher names', async () => {
    mockAuthAs('admin');
    mockPrisma.task.findFirst.mockResolvedValue({ ...TASK_FIXTURE, owner_id: 'u-1', watcher_ids: ['u-2'] });
    mockPrisma.taskSubtask.findMany.mockResolvedValue([{ id: 's1', task_id: TASK_ID, text: 'Wire reader', done: true, position: 0 }]);
    mockPrisma.note.findMany.mockResolvedValue([{ id: 'n1', content: 'Ordered', created_by: 'u-1', created_at: new Date(), entity_type: 'TASK', entity_id: TASK_ID }]);
    mockPrisma.timelineEvent.findMany.mockResolvedValue([{ id: 't1', event_type: 'CREATED', description: 'created the task', created_by: 'u-1', created_at: new Date(), metadata: null }]);
    mockPrisma.user.findMany.mockResolvedValue([{ id: 'u-1', first_name: 'Oved', last_name: 'Adani' }, { id: 'u-2', first_name: 'Hazal', last_name: 'D' }]);
    const res = await request(app).get(`/api/tasks/${TASK_ID}`).set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.task.subtasks[0].text).toBe('Wire reader');
    expect(res.body.task.comments[0].author_name).toBe('Oved Adani');
    expect(res.body.task.activity[0].type).toBe('CREATED');
    expect(res.body.task.watchers).toEqual([{ id: 'u-2', name: 'Hazal D' }]);
  });
  it('404 when task not in tenant', async () => {
    mockAuthAs('admin');
    mockPrisma.task.findFirst.mockResolvedValue(null);
    const res = await request(app).get(`/api/tasks/${TASK_ID}`).set(authHeader('admin'));
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement `getOne`** (and export). Fetch task (tenant-checked `findFirst`); load subtasks (`orderBy position`), comments (`note.findMany where entity_type:'TASK', entity_id:id`), activity (`timelineEvent.findMany` same filter, `orderBy created_at desc`); resolve names for owner+watchers+comment authors+activity actors via `resolveUserNames`; compute risk; assemble. Add route `router.get('/:id', canDo('read','Task'), ctrl.getOne)` **before** any conflicting param routes.
- [ ] **Step 4: Run → pass. Step 5: Commit.** `feat(tasks): GET /:id detail with subtasks, comments, activity, watchers`

---

## Task 8: Create (+CREATED activity + creator-watch) & Update (+diff activity)

**Files:** Modify `task.controller.ts` (`create`, `update`, schemas); Test `tasks.test.ts`

**Interfaces — Produces:** `POST` adds `watcher_ids`/`ai_source` support, records `CREATED`, auto-adds creator to `watcher_ids`. `PATCH` accepts `watcher_ids`; records diff activities; `DONE`→`completed_at` set + `COMPLETED`, off-`DONE`→cleared.

- [ ] **Step 1: Failing tests:**
```ts
it('create records CREATED activity and adds creator as watcher', async () => {
  mockAuthAs('admin');
  await request(app).post('/api/tasks').set(authHeader('admin')).send({ title: 'X' });
  const createArgs = mockPrisma.task.create.mock.calls[0][0] as any;
  expect(createArgs.data.watcher_ids).toContain('00000000-0000-0000-0000-000000000001'); // admin id from helpers
  expect(mockPrisma.timelineEvent.create).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ entity_type: 'TASK', event_type: 'CREATED' }) }),
  );
});
it('patch status→DONE sets completed_at and records COMPLETED', async () => {
  mockAuthAs('admin');
  mockPrisma.task.findFirst.mockResolvedValue({ ...TASK_FIXTURE, status: 'TODO' });
  await request(app).patch(`/api/tasks/${TASK_ID}`).set(authHeader('admin')).send({ status: 'DONE' });
  const updArgs = mockPrisma.task.update.mock.calls[0][0] as any;
  expect(updArgs.data.completed_at).toBeInstanceOf(Date);
  expect(mockPrisma.timelineEvent.create).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ event_type: 'COMPLETED' }) }),
  );
});
```

- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement.** Extend `createTaskSchema`/`updateTaskSchema` with `watcher_ids: z.array(z.string().uuid()).optional()` and `ai_source`/`ai_suggested_by` (create only). In `create`: inside the existing `$transaction`, after `tx.task.create`, call `recordTaskActivity(tx, {type:'CREATED', description:'created the task', …})`; set `watcher_ids: [...new Set([req.user!.id, ...(watcher_ids ?? [])])]`. In `update`: wrap in `$transaction`; compute `diffTaskActivities(existing, data)` and `recordTaskActivity` for each event after the update; keep the `DONE`→`completed_at` logic.
- [ ] **Step 4: Run → pass. Step 5: Commit.** `feat(tasks): create/update emit activity + creator auto-watch`

---

## Task 9: Comments endpoint (reuse `Note`)

**Files:** Modify `task.controller.ts` (`addComment`), `task.routes.ts`; Test `tasks.test.ts`

**Interfaces — Produces:** `POST /api/tasks/:id/comments` `{ body }` → `{ comment }`; writes a `Note` (`entity_type:'TASK'`) + `COMMENTED` activity. Gated `canDo('update','Task')`.

- [ ] **Step 1: Failing test** asserting `note.create` called with `entity_type:'TASK', entity_id:id, content:body`, a `COMMENTED` timeline event, and 201. (404 if task not in tenant.)
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** — tenant-check task via `findFirst`; in a `$transaction`, `tx.note.create` + `recordTaskActivity(...'COMMENTED'...)`; return the created comment shaped `{ id, body: content, author_id: created_by, at: created_at }`. Add Zod `commentSchema = z.object({ body: z.string().min(1) })`. Route: `router.post('/:id/comments', canDo('update','Task'), validate(ctrl.commentSchema), ctrl.addComment)`.
- [ ] **Step 4: Run → pass. Step 5: Commit.** `feat(tasks): task comments via Note + COMMENTED activity`

---

## Task 10: Subtask endpoints

**Files:** Modify `task.controller.ts` (`addSubtask`, `updateSubtask`, `deleteSubtask`), `task.routes.ts`; Test `tasks.test.ts`

**Interfaces — Produces:** `POST /api/tasks/:id/subtasks` `{text}` → `{subtask}`; `PATCH /api/tasks/:id/subtasks/:subtaskId` `{text?,done?}`; `DELETE …`. All gated `canDo('update','Task')`, tenant-checked via parent task.

- [ ] **Step 1: Failing tests** — create asserts `taskSubtask.create` with `task_id`; toggle asserts `taskSubtask.update` with `{done:true}`; delete → 204. Parent-task tenant check via `task.findFirst` (404 if missing).
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** the three handlers (verify subtask belongs to a tenant task before update/delete). Zod: `subtaskCreateSchema = z.object({ text: z.string().min(1) })`, `subtaskUpdateSchema = z.object({ text: z.string().min(1).optional(), done: z.boolean().optional() })`. Routes added in order so `/:id/subtasks/:subtaskId` doesn't shadow `/:id`.
- [ ] **Step 4: Run → pass. Step 5: Commit.** `feat(tasks): subtask checklist CRUD`

---

## Task 11: Nudge + delete cleanup + final integration pass

**Files:** Modify `task.controller.ts` (`nudge`, `remove`), `task.routes.ts`; Test `tasks.test.ts`

**Interfaces — Produces:** `POST /api/tasks/:id/nudge` → `{task}` + `NUDGED` activity (no external notification — out of scope). `remove` also deletes the task's `Note`s + `TimelineEvent`s (polymorphic rows have no FK cascade).

- [ ] **Step 1: Failing tests** — nudge records a `NUDGED` timeline event (200); delete calls `note.deleteMany`/`timelineEvent.deleteMany` with `{entity_type:'TASK', entity_id:id}` then `task.delete` (204); technician delete still 403 (unchanged grant).
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** `nudge` (tenant-check, record activity, return task) and extend `remove` to `deleteMany` the polymorphic children inside a `$transaction` before `task.delete`. Wire routes.
- [ ] **Step 4: Full backend suite green.** Run: `npm test --workspace=backend` and `cd backend && npx tsc --noEmit`. Expected: all pass.
- [ ] **Step 5: Commit.** `feat(tasks): nudge action + cascade-clean comments/activity on delete`

---

## Self-Review (completed)

- **Spec coverage:** subtasks ✓(T1,T10) comments ✓(T1 reuse,T9) activity ✓(T4,T7,T8,T9,T11) watchers ✓(T1,T7,T8) AI source ✓(T1,T8) risk ✓(T2,T6,T7) visibility ✓(T3,T6) labels/names ✓(T5,T6,T7) detail ✓(T7) numbering/tenant/CASL reused ✓.
- **Out of scope (correctly absent):** notifications, LLM, pagination, auto-generate-on-job-create, attachments — none planned here.
- **Type consistency:** `TaskActivityType` strings shared T4↔T8↔T9↔T11; `entity_type:'TASK'` constant `TASK_ENTITY_TYPE` shared; resolver key format `"TYPE:id"` shared T5↔T6↔T7.
- **Open verification flagged inline:** `tenantWhere` stub shape (T3), `Lead/Estimate` exact `select` fields (T5), `_count` fixture (T6) — each is a concrete confirm-against-schema step, not a placeholder.

## Next plans (not this file)
- **Plan 2 — Frontend real-data + rich wiring:** replace `MOCK_PEOPLE`/`MOCK_ENTITIES`/`MOCK_DEPARTMENTS` across the 6 components with real org users/entities; extend `lib/api/tasks` + `tasksStore` for `GET /:id`, comments, subtasks, watchers, nudge; wire the drawer's comments/subtasks/activity + History; re-point `taskAI` at real users; resolve owner names. **Keep Zustand** (extend, don't migrate to TanStack Query).
- **Plan 3 — Job command-center task signals:** per-entity summary (open/overdue/next-due), header signals + tab count badge, overdue/at-risk strip, "new task for this job" quick action — built on the Plan-1 endpoints + the existing command-center scaffolding (`5f912951`/`ffab84b9`).
