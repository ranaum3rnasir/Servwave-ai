# Create Job from Lead + "Schedule job" Notification Re-Point — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the lead page into a first-class entry point for converting an approved estimate into a job (a prominent button → an estimate-picker modal), and re-point the "Schedule job" notification so it deep-links to the lead and clears only when a job is actually created.

**Architecture:** No new conversion endpoint — the existing idempotent `POST /api/jobs { estimate_id }` does all the work and is already race-safe (`Job.estimate_id @unique` + find-or-create + P2002 fallback). We add: (a) `lead_id` to the estimate-approval notification payloads so the FE can deep-link to the lead; (b) a best-effort `resolveScheduleJobNotifications` helper called after a job is created from an estimate, which clears the Dispatcher's pinned "Schedule job" item; (c) `job` on each estimate in the lead-detail response so the modal can show "already converted"; (d) the lead-page button + modal; (e) the `inlineActions` change so "Schedule job" navigates to the lead without auto-completing.

**Tech Stack:** Node 20 + Express + Prisma + Vitest (backend, strict TDD); React 18 + TS + TanStack Query + shadcn/Radix Dialog + Tailwind (frontend; gate = `tsc --noEmit` + `build` + targeted vitest).

## Global Constraints

- **Branch isolation:** ALL work happens in the worktree `/Users/ranroffe/ALPHA_CRM/alpha_crm-worktrees/notifications` on branch `feat/in-app-notifications`. Never switch to or modify another branch. If a tool reports a different branch, stop and switch back.
- **No new migration.** This feature adds a Prisma `select` field (B4), a new read/update helper over existing tables (B2), and changes emitted JSON `data` (B1). The `notifications` / `notification_recipients` tables already exist on this branch. Do NOT author or run any migration. Never run `prisma migrate` from the worktree.
- **No AI attribution** in any commit message, PR title/body, or git artifact. Conventional-commit lines only.
- **Backend is strict TDD:** failing test → minimal code → green, every backend task. Prisma is fully mocked in backend tests — match the mock setup already used in the named test file.
- **emit/resolve must never break the parent action.** `resolveScheduleJobNotifications` wraps its body in try/catch and never throws; job creation must succeed even if resolution fails.
- **Notification tables stay off the Supabase Data API** (unchanged — no Data-API exposure is added).
- **Reuse `POST /api/jobs`** for conversion. Do not add a `/convert` route. The Convert-to-Job button on the estimate detail page stays as-is (this adds a lead entry point, it does not remove the estimate one).
- **Design system:** the Create-Job CTA uses `variant="business"` (sage — forward-motion create CTA) with the `Briefcase` lucide icon, matching the existing "+ New Estimate" precedent (`LeadDetailPage.tsx:1158`).

---

## File Structure

| File | Change | Task |
|------|--------|------|
| `backend/src/controllers/estimate.controller.ts` | add `lead_id` to 3 emit `data` bags | B1 |
| `backend/src/controllers/webhook.controller.ts` | add `lead_id` to 2 emit `data` bags | B1 |
| `backend/src/__tests__/estimate-notifications.test.ts` | assert `data.lead_id` | B1 |
| `backend/src/services/notifications/resolveNotifications.ts` | **new** best-effort resolve helper | B2 |
| `backend/src/services/notifications/__tests__/resolveNotifications.test.ts` | **new** unit test | B2 |
| `backend/src/controllers/job.controller.ts` | call resolve after estimate→job create | B3 |
| `backend/src/__tests__/jobs.test.ts` | assert resolve fires on conversion | B3 |
| `backend/src/controllers/lead.controller.ts` | add `job` to `leadDetailSelect.estimates` | B4 |
| `backend/src/__tests__/leads.test.ts` | assert `estimates[].job` returned | B4 |
| `frontend/src/components/notifications/inlineActions.ts` | re-point SCHEDULE_JOB + return `{skipActed}` | F1 |
| `frontend/src/components/notifications/NotificationItem.tsx` | `runAction` respects `skipActed` | F1 |
| `frontend/src/components/notifications/__tests__/inlineActions.test.ts` | assert lead deep-link + skipActed | F1 |
| `frontend/src/components/leads/CreateJobFromLeadDialog.tsx` | **new** estimate-picker modal | F2 |
| `frontend/src/components/leads/__tests__/CreateJobFromLeadDialog.test.tsx` | **new** component test | F2 |
| `frontend/src/pages/LeadDetailPage.tsx` | button replaces dropdown + mount modal + deep-link param | F3 |
| `md_files/plans/notifications/qa-checklist.md` | QA addendum | F4 |

---

## Task B1: Add `lead_id` to estimate-approval notification payloads

**Files:**
- Modify: `backend/src/controllers/estimate.controller.ts` (3 emit sites)
- Modify: `backend/src/controllers/webhook.controller.ts` (2 emit sites)
- Test: `backend/src/__tests__/estimate-notifications.test.ts`

**Interfaces:**
- Produces: every `estimate.approved` and `estimate.deposit_paid` notification now carries `data.lead_id` (the estimate's `lead_id`). The FE deep-link (F1) consumes it.

**Context:** The 5 emit call sites today pass `data: { object_label: <estimate_number> }` only. The lead id is already in scope at each (`existing.lead_id` / `est.lead_id`). This is purely additive.

- [ ] **Step 1: Write/extend the failing test.** In `estimate-notifications.test.ts`, find the existing cases that assert the `estimate.approved` and `estimate.deposit_paid` emits (public-approve path, record-payment path, and the Stripe webhook path). Add to each assertion that the emitted notification's `data` includes the lead id. Match the file's existing Prisma-mock + emit-capture style. Representative assertion to fold into each relevant case:

```ts
// the estimate fixture already has a known lead_id, e.g. LEAD_ID
expect(emittedFor('estimate.approved').data).toMatchObject({ lead_id: LEAD_ID });
// and for the deposit_paid cases:
expect(emittedFor('estimate.deposit_paid').data).toMatchObject({ lead_id: LEAD_ID });
```

- [ ] **Step 2: Run the tests, verify they fail.**
Run: `npm test --workspace=backend -- run src/__tests__/estimate-notifications.test.ts`
Expected: FAIL — `data.lead_id` is `undefined`.

- [ ] **Step 3: Add `lead_id` to all 5 `data` bags.** In `estimate.controller.ts`: the `approvePublic` no-deposit emit (`verb:'estimate.approved'`, ~line 2149), and in `recordEstimatePayment` both the `estimate.deposit_paid` (~line 1645) and the conditional `estimate.approved` (~line 1657) emits. In `webhook.controller.ts`: the `estimate.deposit_paid` and `estimate.approved` emits (~lines 335–354). Each change is the same shape:

```ts
// estimate.controller.ts (approvePublic + recordEstimatePayment): `existing` is in scope
data: { object_label: existing.estimate_number, lead_id: existing.lead_id },
// webhook.controller.ts: `est` is in scope
data: { object_label: est.estimate_number, lead_id: est.lead_id },
```

Confirm `lead_id` is selected in each site's estimate query (it is for all three controllers per the current selects). If any site's select omits `lead_id`, add `lead_id: true` to that select.

- [ ] **Step 4: Run the tests, verify they pass.**
Run: `npm test --workspace=backend -- run src/__tests__/estimate-notifications.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit.**
```bash
git add backend/src/controllers/estimate.controller.ts backend/src/controllers/webhook.controller.ts backend/src/__tests__/estimate-notifications.test.ts
git commit -m "feat(notifications): include lead_id in estimate-approval payloads for lead deep-link"
```

---

## Task B2: `resolveScheduleJobNotifications` best-effort helper

**Files:**
- Create: `backend/src/services/notifications/resolveNotifications.ts`
- Test: `backend/src/services/notifications/__tests__/resolveNotifications.test.ts`

**Interfaces:**
- Produces: `resolveScheduleJobNotifications(estimateId: string, organizationId: string, client?: Prisma.TransactionClient | typeof prisma): Promise<void>` — never throws. B3 consumes it.

**Context:** No existing helper resolves recipients by object — only `emit()` creates them. Prisma `updateMany` cannot filter through a relation, so this is a two-step: find the estimate's `SCHEDULE_JOB` notification ids, then `updateMany` their actionable recipient rows. Only `needs_action: true` rows are touched so informational copies (Sales/Admin) are left alone. Verify the `prisma` and `logger` import paths against a sibling (e.g. `notificationService.ts`) before writing.

- [ ] **Step 1: Write the failing test.** Create `resolveNotifications.test.ts` (mock `../../lib/prisma` and `../../lib/logger`, matching the sibling tests in `services/notifications/__tests__/`):

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveScheduleJobNotifications } from '../resolveNotifications';
import { prisma } from '../../../lib/prisma';

vi.mock('../../../lib/prisma', () => ({
  prisma: {
    notification: { findMany: vi.fn() },
    notificationRecipient: { updateMany: vi.fn() },
  },
}));
vi.mock('../../../lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));

const ORG = 'org-1';
const EST = 'est-1';

beforeEach(() => vi.clearAllMocks());

describe('resolveScheduleJobNotifications', () => {
  it('stamps acted_at/read_at on the actionable recipient rows of the estimate\'s SCHEDULE_JOB notifications', async () => {
    (prisma.notification.findMany as any).mockResolvedValue([{ id: 'n1' }, { id: 'n2' }]);
    (prisma.notificationRecipient.updateMany as any).mockResolvedValue({ count: 1 });

    await resolveScheduleJobNotifications(EST, ORG);

    expect(prisma.notification.findMany).toHaveBeenCalledWith({
      where: { organization_id: ORG, object_type: 'ESTIMATE', object_id: EST, action_type: 'SCHEDULE_JOB' },
      select: { id: true },
    });
    expect(prisma.notificationRecipient.updateMany).toHaveBeenCalledWith({
      where: { notification_id: { in: ['n1', 'n2'] }, organization_id: ORG, needs_action: true, acted_at: null },
      data: expect.objectContaining({ acted_at: expect.any(Date), read_at: expect.any(Date) }),
    });
  });

  it('does nothing (no update) when there are no matching notifications', async () => {
    (prisma.notification.findMany as any).mockResolvedValue([]);
    await resolveScheduleJobNotifications(EST, ORG);
    expect(prisma.notificationRecipient.updateMany).not.toHaveBeenCalled();
  });

  it('never throws when Prisma rejects (best-effort)', async () => {
    (prisma.notification.findMany as any).mockRejectedValue(new Error('db down'));
    await expect(resolveScheduleJobNotifications(EST, ORG)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test, verify it fails.**
Run: `npm test --workspace=backend -- run src/services/notifications/__tests__/resolveNotifications.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the helper.**

```ts
/**
 * resolveNotifications.ts — clear actionable notifications once their real-world
 * action is done. Best-effort: never throws (a failure here must not break the
 * parent action, mirroring emit()).
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';

/**
 * Mark the open "Schedule job" (action_type SCHEDULE_JOB) notification(s) for an
 * estimate as acted, so they leave the Dispatcher's pinned "needs action" list
 * once a job has actually been created from that estimate. Only needs_action
 * rows are touched — informational copies (Sales/Admin) are left untouched.
 */
export async function resolveScheduleJobNotifications(
  estimateId: string,
  organizationId: string,
  client: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<void> {
  try {
    const notifs = await client.notification.findMany({
      where: {
        organization_id: organizationId,
        object_type: 'ESTIMATE',
        object_id: estimateId,
        action_type: 'SCHEDULE_JOB',
      },
      select: { id: true },
    });
    if (notifs.length === 0) return;
    const now = new Date();
    await client.notificationRecipient.updateMany({
      where: {
        notification_id: { in: notifs.map((n) => n.id) },
        organization_id: organizationId,
        needs_action: true,
        acted_at: null,
      },
      data: { acted_at: now, read_at: now },
    });
  } catch (err) {
    logger.warn(`resolveScheduleJobNotifications failed for estimate ${estimateId}: ${String(err)}`);
  }
}
```

- [ ] **Step 4: Run the test, verify it passes.**
Run: `npm test --workspace=backend -- run src/services/notifications/__tests__/resolveNotifications.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit.**
```bash
git add backend/src/services/notifications/resolveNotifications.ts backend/src/services/notifications/__tests__/resolveNotifications.test.ts
git commit -m "feat(notifications): add best-effort resolveScheduleJobNotifications helper"
```

---

## Task B3: Resolve the "Schedule job" notification when a job is created from an estimate

**Files:**
- Modify: `backend/src/controllers/job.controller.ts` (the `create` function, estimate-conversion path)
- Test: `backend/src/__tests__/jobs.test.ts`

**Interfaces:**
- Consumes: `resolveScheduleJobNotifications` (B2).

**Context:** In `create()`, the estimate path creates the job inside `prisma.$transaction` (returns at ~line 731). Call resolve AFTER the transaction commits (post-commit, using the global `prisma`), guarded by `estimate_id` being present. Best-effort + post-commit keeps job creation bulletproof — a resolve failure cannot roll back the job. `estimate_id` and `req.user!.organization_id` are in scope.

- [ ] **Step 1: Write the failing test.** In `jobs.test.ts`, find the existing "create job from an APPROVED estimate" success case (the `POST /api/jobs { estimate_id }` happy path). Spy on the resolve helper and assert it's called with the estimate id + org id after a successful conversion. Add near the top:

```ts
import * as resolveNotifs from '../services/notifications/resolveNotifications';
// in the conversion success test, before calling the controller:
const resolveSpy = vi.spyOn(resolveNotifs, 'resolveScheduleJobNotifications').mockResolvedValue();
// after asserting the 201 + job:
expect(resolveSpy).toHaveBeenCalledWith(<APPROVED_ESTIMATE_ID>, <ORG_ID>);
```

Also add a guard case: a **standalone** job create (no `estimate_id`, customer+location body) does NOT call resolve:
```ts
expect(resolveSpy).not.toHaveBeenCalled();
```

- [ ] **Step 2: Run the tests, verify they fail.**
Run: `npm test --workspace=backend -- run src/__tests__/jobs.test.ts`
Expected: FAIL — resolve never called.

- [ ] **Step 3: Wire the call.** Import at the top of `job.controller.ts`:
```ts
import { resolveScheduleJobNotifications } from '../services/notifications/resolveNotifications';
```
Immediately after the `prisma.$transaction(...)` that creates the job from the estimate returns (the `const job = await prisma.$transaction(...)` at ~line 702–732, on the estimate path only), and before the response is sent:
```ts
// Clear the Dispatcher's pinned "Schedule job" notification now that the job exists.
// Best-effort, post-commit — never blocks the response.
if (estimate_id) {
  await resolveScheduleJobNotifications(estimate_id, req.user!.organization_id);
}
```
Place it so it runs only on the real-creation path (not the idempotent early-return-existing branches at ~lines 689–698 / 758–768 — those represent an already-converted estimate whose notification was resolved on first conversion).

- [ ] **Step 4: Run the tests, verify they pass.**
Run: `npm test --workspace=backend -- run src/__tests__/jobs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit.**
```bash
git add backend/src/controllers/job.controller.ts backend/src/__tests__/jobs.test.ts
git commit -m "feat(notifications): clear Schedule-job notification when a job is created from its estimate"
```

---

## Task B4: Include each estimate's `job` in the lead-detail response

**Files:**
- Modify: `backend/src/controllers/lead.controller.ts` (`leadDetailSelect.estimates.select`, ~line 123–129)
- Test: `backend/src/__tests__/leads.test.ts`

**Interfaces:**
- Produces: `GET /api/leads/:id` → `lead.estimates[]` each now has `job: { id, job_number, status } | null`. The modal (F2/F3) consumes it to show "already converted".

- [ ] **Step 1: Write the failing test.** In `leads.test.ts`, find the GET-one success case. Make the mocked lead's estimate include a `job`, and assert the response surfaces it. Match the file's existing Prisma-mock shape:
```ts
// mocked estimate fixture gains: job: { id: 'job-1', job_number: 'J00001', status: 'UNASSIGNED' }
expect(res.body.lead.estimates[0].job).toEqual({ id: 'job-1', job_number: 'J00001', status: 'UNASSIGNED' });
```
Also assert the `findUnique`/`findFirst` select requested the nested job (mirror however the file asserts selects, if it does):
```ts
// optional, if the file asserts select shape:
expect((prisma.lead.findFirst as any).mock.calls[0][0].select.estimates.select.job)
  .toEqual({ select: { id: true, job_number: true, status: true } });
```

- [ ] **Step 2: Run the test, verify it fails.**
Run: `npm test --workspace=backend -- run src/__tests__/leads.test.ts`
Expected: FAIL — `job` undefined / select missing.

- [ ] **Step 3: Extend the select.** In `lead.controller.ts`, inside `leadDetailSelect.estimates.select` (after the `creator` entry, ~line 126):
```ts
job: { select: { id: true, job_number: true, status: true } },
```

- [ ] **Step 4: Run the test, verify it passes.**
Run: `npm test --workspace=backend -- run src/__tests__/leads.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit.**
```bash
git add backend/src/controllers/lead.controller.ts backend/src/__tests__/leads.test.ts
git commit -m "feat(leads): include each estimate's job in lead-detail response"
```

---

## Task F1: Re-point the "Schedule job" inline action to the lead (no auto-complete)

**Files:**
- Modify: `frontend/src/components/notifications/inlineActions.ts`
- Modify: `frontend/src/components/notifications/NotificationItem.tsx` (`runAction`)
- Test: `frontend/src/components/notifications/__tests__/inlineActions.test.ts`

**Interfaces:**
- Consumes: `data.lead_id` from B1.
- Produces: `ActionHandler` return type widens to `Promise<{ skipActed?: boolean } | void>`. `handleScheduleJob` returns `{ skipActed: true }` and never auto-stamps acted; `runAction` leaves the row pinned for skip-acted handlers.

**Context:** Today `runAction` (`NotificationItem.tsx:137–159`) stamps `markActed` after ANY handler resolves. We want "Schedule job" to navigate to the lead (opening the picker) but stay pinned until the backend resolves it on real job creation (B3).

- [ ] **Step 1: Write the failing tests.** In `inlineActions.test.ts`, mock `useNavigate`/pass a `navigate` spy (match the file's existing style) and add:
```ts
it('SCHEDULE_JOB navigates to the lead with the createJob param when data.lead_id is present', async () => {
  const navigate = vi.fn();
  const item = makeItem({ action_type: 'SCHEDULE_JOB', object_id: 'est-9', data: { lead_id: 'lead-5' } });
  const result = await ACTION_HANDLERS.SCHEDULE_JOB(item, navigate);
  expect(navigate).toHaveBeenCalledWith('/leads/lead-5?createJob=est-9');
  expect(result).toEqual({ skipActed: true });
});

it('SCHEDULE_JOB falls back to the estimate page for legacy payloads without lead_id', async () => {
  const navigate = vi.fn();
  const item = makeItem({ action_type: 'SCHEDULE_JOB', object_id: 'est-9', data: {} });
  const result = await ACTION_HANDLERS.SCHEDULE_JOB(item, navigate);
  expect(navigate).toHaveBeenCalledWith('/estimates/est-9');
  expect(result).toEqual({ skipActed: true });
});
```
(Use the file's existing item factory; if none, build a minimal `NotificationView` literal as the other cases do.)

- [ ] **Step 2: Run the tests, verify they fail.**
Run: `npm test --workspace=frontend -- run src/components/notifications/__tests__/inlineActions.test.ts`
Expected: FAIL — current handler navigates to `/estimates/...` and returns `void`.

- [ ] **Step 3: Update the handler + type.** In `inlineActions.ts`:
```ts
export type ActionResult = { skipActed?: boolean } | void;
export type ActionHandler = (
  item: NotificationView,
  navigate: NavigateFunction,
) => Promise<ActionResult>;

/**
 * SCHEDULE_JOB — land on the lead and open its estimate-picker modal
 * (?createJob=<estimateId>). The notification is NOT marked done here; it
 * clears only when a job is actually created (backend resolveScheduleJobNotifications).
 * Falls back to the estimate page for legacy payloads without lead_id.
 */
async function handleScheduleJob(
  item: NotificationView,
  navigate: NavigateFunction,
): Promise<ActionResult> {
  const estimateId = (item.data.estimate_id as string | undefined) ?? item.object_id;
  const leadId = item.data.lead_id as string | undefined;
  if (leadId) {
    navigate(`/leads/${leadId}?createJob=${estimateId ?? ''}`);
  } else if (estimateId) {
    navigate(`/estimates/${estimateId}`);
  } else {
    navigate('/jobs?action=new-job');
  }
  return { skipActed: true };
}
```
(Other handlers keep returning `Promise<void>` — compatible with the widened type.)

- [ ] **Step 4: Teach `runAction` to respect `skipActed`.** In `NotificationItem.tsx`, in the `try` block of `runAction`:
```ts
const result = await handler(item, navigate);
if (result && result.skipActed) {
  // Navigate-only; the notification is NOT done yet — it clears later when the
  // backend resolves it (job actually created). Leave the row pinned: do NOT
  // stamp acted, and do NOT call onActed() (onActed = setActedOptimistic, which
  // would flash the row to "Done"). The finally{} block still clears the spinner.
  return;
}
// Entity call succeeded — stamp acted
await markActed.mutateAsync(item.id);
onActed();
toast({ title: 'Done', description: item.title, duration: 3000 });
```

- [ ] **Step 5: Run the tests, verify they pass.**
Run: `npm test --workspace=frontend -- run src/components/notifications/__tests__/inlineActions.test.ts`
Expected: PASS. Then `npx tsc --noEmit` (from `frontend/`) — expect clean.

- [ ] **Step 6: Commit.**
```bash
git add frontend/src/components/notifications/inlineActions.ts frontend/src/components/notifications/NotificationItem.tsx frontend/src/components/notifications/__tests__/inlineActions.test.ts
git commit -m "feat(notifications): Schedule-job action deep-links to lead and stays pinned until job created"
```

---

## Task F2: `CreateJobFromLeadDialog` estimate-picker modal

**Files:**
- Create: `frontend/src/components/leads/CreateJobFromLeadDialog.tsx`
- Test: `frontend/src/components/leads/__tests__/CreateJobFromLeadDialog.test.tsx`

**Interfaces:**
- Produces:
```ts
export interface CreateJobEstimate {
  id: string; estimate_number: string; status: string;
  total_amount: string; created_at: string;
  job?: { id: string; job_number: string; status: string } | null;
}
export function CreateJobFromLeadDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leadId: string;
  estimates: CreateJobEstimate[];
  canCreateEstimate: boolean;
  preselectEstimateId?: string | null;
  isConverting: boolean;
  onConvert: (estimateId: string) => void;
}): JSX.Element;
```
F3 consumes it.

**Context:** Match the controlled-Dialog pattern of `AssignLeadDialog` (`open`/`onOpenChange`). Convertible = `status === 'APPROVED' && !job`. Selecting then "Create job" calls `onConvert(selectedId)` (the parent's existing `createJobMutation`). "New estimate" navigates to `/estimates/new?lead_id=<leadId>` (does not convert — the new estimate needs approval first). Already-converted estimates show their `job_number` and link to the job. Verify import paths (`@/components/ui/dialog`, `@/components/ui/button`, `@/components/ui/status-badge`, `@/lib/utils` `formatCurrency`, `lucide-react`) against `AssignLeadDialog.tsx`.

- [ ] **Step 1: Write the failing component tests.** Create `CreateJobFromLeadDialog.test.tsx` (render with `@testing-library/react`; mock `react-router-dom` `useNavigate`):
```ts
const navigate = vi.fn();
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));
const base = { open: true, onOpenChange: vi.fn(), leadId: 'lead-1', canCreateEstimate: true, isConverting: false, onConvert: vi.fn() };
const approved = { id: 'e1', estimate_number: 'E00001', status: 'APPROVED', total_amount: '1000', created_at: '2026-01-01', job: null };
const sent = { id: 'e2', estimate_number: 'E00002', status: 'SENT', total_amount: '500', created_at: '2026-01-02', job: null };
const converted = { id: 'e3', estimate_number: 'E00003', status: 'APPROVED', total_amount: '900', created_at: '2026-01-03', job: { id: 'job-7', job_number: 'J00007', status: 'UNASSIGNED' } };
```
Cases:
1. `estimates: []` → renders "No estimates yet"; "Create job" button is disabled.
2. `estimates: [approved]` → it is auto-selected; "Create job" enabled; clicking it calls `onConvert('e1')`.
3. `estimates: [sent]` → renders "No approved estimate to convert yet"; "Create job" disabled.
4. `estimates: [converted]` → shows `J00007`; clicking its job link calls `navigate('/jobs/job-7')`; "Create job" disabled (no convertible).
5. `estimates: [sent, approved], preselectEstimateId: 'e1'` → `e1` selected; "Create job" enabled.
6. `canCreateEstimate: true` → a "New estimate" control exists; clicking it calls `navigate('/estimates/new?lead_id=lead-1')` and `onOpenChange(false)`.
7. `canCreateEstimate: false` → no "New estimate" control rendered.

- [ ] **Step 2: Run the tests, verify they fail.**
Run: `npm test --workspace=frontend -- run src/components/leads/__tests__/CreateJobFromLeadDialog.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the modal.**
```tsx
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatCurrency } from '@/lib/utils';
import { Briefcase, FileText } from 'lucide-react';

export interface CreateJobEstimate {
  id: string; estimate_number: string; status: string;
  total_amount: string; created_at: string;
  job?: { id: string; job_number: string; status: string } | null;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leadId: string;
  estimates: CreateJobEstimate[];
  canCreateEstimate: boolean;
  preselectEstimateId?: string | null;
  isConverting: boolean;
  onConvert: (estimateId: string) => void;
}

export function CreateJobFromLeadDialog({
  open, onOpenChange, leadId, estimates, canCreateEstimate,
  preselectEstimateId, isConverting, onConvert,
}: Props) {
  const navigate = useNavigate();
  const convertible = estimates.filter((e) => e.status === 'APPROVED' && !e.job);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const pre = preselectEstimateId && convertible.some((e) => e.id === preselectEstimateId);
    if (pre) setSelectedId(preselectEstimateId!);
    else if (convertible.length === 1) setSelectedId(convertible[0].id);
    else setSelectedId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, preselectEstimateId, estimates]);

  function goCreateEstimate() {
    onOpenChange(false);
    navigate(`/estimates/new?lead_id=${leadId}`);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Create job from estimate</DialogTitle>
          <DialogDescription>
            Pick an approved estimate to convert into a job. Only approved estimates can be converted.
          </DialogDescription>
        </DialogHeader>

        {estimates.length === 0 ? (
          <div className="flex flex-col items-center py-8 text-center">
            <FileText className="h-8 w-8 text-text-secondary/30 mb-2" />
            <p className="text-sm text-text-secondary">No estimates yet.</p>
          </div>
        ) : (
          <>
            <div className="space-y-1.5 max-h-72 overflow-y-auto">
              {estimates.map((est) => {
                const isConvertible = est.status === 'APPROVED' && !est.job;
                const isSelected = selectedId === est.id;
                return (
                  <div
                    key={est.id}
                    className={[
                      'flex items-center justify-between rounded-lg border px-3 py-2',
                      isConvertible ? 'cursor-pointer' : 'opacity-70',
                      isSelected ? 'border-primary bg-primary-subtle' : 'border-border',
                    ].join(' ')}
                    onClick={isConvertible ? () => setSelectedId(est.id) : undefined}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      {isConvertible && (
                        <span
                          className={[
                            'h-4 w-4 rounded-full border shrink-0',
                            isSelected ? 'border-primary bg-primary' : 'border-border',
                          ].join(' ')}
                          aria-hidden
                        />
                      )}
                      <span className="font-medium text-primary">{est.estimate_number}</span>
                      <StatusBadge status={est.status} />
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {est.job ? (
                        <button
                          type="button"
                          className="text-xs text-text-secondary underline"
                          onClick={(e) => { e.stopPropagation(); onOpenChange(false); navigate(`/jobs/${est.job!.id}`); }}
                        >
                          {est.job.job_number} →
                        </button>
                      ) : (
                        <span className="tabular-nums text-sm">{formatCurrency(est.total_amount)}</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            {convertible.length === 0 && (
              <p className="text-xs text-text-secondary">
                No approved estimate to convert yet. Approve an estimate first
                {canCreateEstimate ? ', or create a new one below.' : '.'}
              </p>
            )}
          </>
        )}

        <div className="flex items-center justify-between gap-3 pt-2">
          {canCreateEstimate ? (
            <Button variant="outline" size="sm" onClick={goCreateEstimate}>
              <FileText className="mr-2 h-4 w-4" /> New estimate
            </Button>
          ) : <span />}
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button
              variant="business"
              size="sm"
              disabled={!selectedId || isConverting}
              onClick={() => selectedId && onConvert(selectedId)}
            >
              <Briefcase className="mr-2 h-4 w-4" />
              {isConverting ? 'Creating…' : 'Create job'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: Run the tests, verify they pass.**
Run: `npm test --workspace=frontend -- run src/components/leads/__tests__/CreateJobFromLeadDialog.test.tsx`
Expected: PASS. Then `npx tsc --noEmit` (from `frontend/`) — clean.

- [ ] **Step 5: Commit.**
```bash
git add frontend/src/components/leads/CreateJobFromLeadDialog.tsx frontend/src/components/leads/__tests__/CreateJobFromLeadDialog.test.tsx
git commit -m "feat(leads): add CreateJobFromLeadDialog estimate-picker modal"
```

---

## Task F3: Wire the lead page — prominent "Create Job" button, modal, deep-link param

**Files:**
- Modify: `frontend/src/pages/LeadDetailPage.tsx`

**Interfaces:**
- Consumes: `CreateJobFromLeadDialog` (F2), `estimates[].job` (B4), the `?createJob=<estimateId>` param produced by F1.

**Context:** Replace the buried "Actions" dropdown (the only item is Convert-to-Job) with a prominent `business` button that opens the modal. The page already has `createJobMutation` (`:613`, takes `estimateId`), `canConvertToJob` (`:678`), `canCreateEstimate` (`:662`), and the `estimates` array (`:667`). Add the `job` field to the `estimates` type, mount the modal, and open it (pre-selected) when the deep-link param is present. This task's gate is `tsc --noEmit` + `build` + the F2 modal tests (the page has no test harness); the deep-link flow is covered by manual QA (F4).

- [ ] **Step 1: Extend the estimates type + add `job`.** In the `estimates` cast (`:667–672`), add:
```ts
job?: { id: string; job_number: string; status: string } | null;
```

- [ ] **Step 2: Add imports + state + deep-link handling.**
- Add `useSearchParams` to the `react-router-dom` import (`:2`).
- Import the modal: `import { CreateJobFromLeadDialog } from '@/components/leads/CreateJobFromLeadDialog';`
- Add state near the other dialog state (`:572–579`):
```ts
const [createJobOpen, setCreateJobOpen] = useState(false);
const [preselectEstimateId, setPreselectEstimateId] = useState<string | null>(null);
const [searchParams, setSearchParams] = useSearchParams();
```
- Add a one-shot effect that opens the modal when `?createJob=` is present, then strips the param so closing/refresh won't reopen it:
```ts
useEffect(() => {
  const cj = searchParams.get('createJob');
  if (!cj) return;
  setPreselectEstimateId(cj);
  setCreateJobOpen(true);
  const next = new URLSearchParams(searchParams);
  next.delete('createJob');
  setSearchParams(next, { replace: true });
}, [searchParams, setSearchParams]);
```

- [ ] **Step 3: Replace the dropdown with the button.** Replace the entire `{canConvertToJob && ( <DropdownMenu> … </DropdownMenu> )}` block (`:816–840`) with:
```tsx
{canConvertToJob && (
  <Button variant="business" size="sm" onClick={() => setCreateJobOpen(true)}>
    <Briefcase className="mr-2 h-4 w-4" />
    Create Job
  </Button>
)}
```

- [ ] **Step 4: Mount the modal** alongside the other dialogs (near `AssignLeadDialog` etc.):
```tsx
<CreateJobFromLeadDialog
  open={createJobOpen}
  onOpenChange={setCreateJobOpen}
  leadId={id!}
  estimates={estimates}
  canCreateEstimate={canCreateEstimate}
  preselectEstimateId={preselectEstimateId}
  isConverting={createJobMutation.isPending}
  onConvert={(estimateId) => createJobMutation.mutate(estimateId)}
/>
```

- [ ] **Step 5: Remove now-dead code.** Delete the `approvedEstimate` derivation (`:677`) if it is no longer referenced. Remove `DropdownMenu*`, `MoreHorizontal`, and any other imports/symbols left unused by the dropdown removal — but ONLY if they are unused elsewhere in the file (grep within the file first). Keep `Briefcase`.

- [ ] **Step 6: Verify.** From `frontend/`:
Run: `npx tsc --noEmit` → expect clean (no unused-symbol or type errors).
Run: `npm run build --workspace=frontend` (from repo root) → expect success.
Run the modal tests again to confirm no regression: `npm test --workspace=frontend -- run src/components/leads/__tests__/CreateJobFromLeadDialog.test.tsx`.

- [ ] **Step 7: Commit.**
```bash
git add frontend/src/pages/LeadDetailPage.tsx
git commit -m "feat(leads): prominent Create Job button + estimate-picker modal + notification deep-link"
```

---

## Task F4: QA-checklist addendum

**Files:**
- Modify: `md_files/plans/notifications/qa-checklist.md`

- [ ] **Step 1: Append a new section** documenting the manual flows to verify on the demo (no code; this is the QA script):

```markdown
## Create-Job-from-Lead + Schedule-job re-point (2026-06-18)
- [ ] Lead page (Admin/Dispatcher): a sage **"Create Job"** button shows in the header. Sales does NOT see it.
- [ ] Click it → modal lists the lead's estimates with status + amount. An APPROVED, un-converted estimate is selectable; "Create job" converts it and lands on /jobs/:id.
- [ ] An already-converted estimate shows its J##### and links to the job (not selectable). A non-approved estimate is shown but not selectable.
- [ ] No approved estimate → modal explains "No approved estimate to convert yet"; "Create job" disabled. "New estimate" (Admin/Sales) opens /estimates/new?lead_id=… and does NOT convert.
- [ ] Empty lead (no estimates) → "No estimates yet"; "New estimate" available to create one.
- [ ] **Notification re-point:** approve an estimate → Dispatcher's "Schedule job" notification, when clicked, opens the **lead** with the picker pre-selected to that estimate (not the estimate page). The notification stays pinned under "Needs action".
- [ ] After actually creating the job from that estimate, the Dispatcher's "Schedule job" notification leaves "Needs action" (resolved). The Sales/Admin informational copies are unchanged.
- [ ] Legacy/no-lead_id notification still falls back to the estimate page.
```

- [ ] **Step 2: Commit.**
```bash
git add md_files/plans/notifications/qa-checklist.md
git commit -m "docs(notifications): QA addendum for create-job-from-lead + Schedule-job re-point"
```

---

## Notes for the controller (execution)

- **Order:** B1 → B2 → B3 → B4 → F1 → F2 → F3 → F4. B3 depends on B2; F3 depends on F2. The rest are independent (FE tests mock their inputs).
- **No migration**, no out-of-band SQL — this rides on the notifications branch which already has the tables/grants.
- **Whole-branch final review** after F4 should focus on: the resolve helper never blocking job creation; only `needs_action` rows resolved; the `skipActed` change not regressing OT/stock/reminder/VIEW (those must still mark acted); and the dead-code removal in F3 leaving `tsc` clean.
