# Single-Org Email Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the accidental, inconsistent "email already in use" behavior across the two user-creation endpoints with one deliberate, canonical 409 guard that checks across ALL organizations before writing anything.

**Architecture:** A single new pure-ish helper (`assertEmailAvailable`) does an unscoped, case-insensitive `User` lookup and throws a typed error. Both `create` and `inviteUser` in `user.controller.ts` call it before their existing writes/Supabase calls and translate the typed error (plus `create`'s existing Supabase `email_exists` path) into one canonical 409 message. No schema change, no frontend change (the existing generic 409 → inline-email-error handler in `StaffFormDialog.tsx:105-106` already covers this).

**Tech Stack:** Express + TypeScript, Prisma, Supabase Auth admin SDK, Vitest + Supertest.

## Global Constraints

- Spec of record: `md_files/plans/security/2026-07-16-single-org-email-guard-design.md`.
- No DB migration in this plan (case-insensitive unique index is an explicitly deferred follow-up).
- No changes to `acceptInvite` (`backend/src/controllers/auth.controller.ts`) — its message is a deliberate, different scenario.
- No frontend changes — verified `frontend/src/components/settings/StaffFormDialog.tsx:105-106` already maps any 409 on invite/create to an inline `email` field error.
- Canonical message (exact string, used everywhere in this plan):
  `"This email already belongs to a Servwave account and can't be added to another organization."`
- TDD: isolation test before every controller change (project convention).
- No AI attribution in any commit message.
- Work happens in a worktree branched from `origin/main` under `../alpha_crm-worktrees/<branch>` per CLAUDE.md rule 9 (set up via the `superpowers:using-git-worktrees` skill at execution time, not a step in this plan).
- Every fix opens a PR against `staging` first (per CLAUDE.md rule 11) — not part of this plan's tasks; handled at ship time.

---

### Task 1: `assertEmailAvailable` guard helper

**Files:**
- Create: `backend/src/lib/user-email-guard.ts`
- Test: `backend/src/lib/__tests__/user-email-guard.test.ts`

**Interfaces:**
- Consumes: `prisma` from `backend/src/lib/prisma.ts` (`prisma.user.findFirst`).
- Produces (for Tasks 2 & 3):
  - `export class EmailAlreadyRegisteredError extends Error {}`
  - `export const EMAIL_ALREADY_REGISTERED_MSG: string`
  - `export async function assertEmailAvailable(email: string): Promise<void>` — resolves if the email is free; throws `EmailAlreadyRegisteredError` if a `User` row with that email (case-insensitive) already exists in ANY organization.

- [ ] **Step 1: Write the failing tests**

Create `backend/src/lib/__tests__/user-email-guard.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '../prisma';
import {
  assertEmailAvailable,
  EmailAlreadyRegisteredError,
  EMAIL_ALREADY_REGISTERED_MSG,
} from '../user-email-guard';

const mockFindFirst = prisma.user.findFirst as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('assertEmailAvailable', () => {
  it('resolves without throwing when the email is not in use anywhere', async () => {
    mockFindFirst.mockResolvedValue(null);
    await expect(assertEmailAvailable('new@test.com')).resolves.toBeUndefined();
  });

  it('throws EmailAlreadyRegisteredError when a user with that email exists in ANY org', async () => {
    mockFindFirst.mockResolvedValue({ id: 'existing-user-id' });
    await expect(assertEmailAvailable('taken@test.com')).rejects.toThrow(EmailAlreadyRegisteredError);
  });

  it('carries the canonical message on the thrown error', async () => {
    mockFindFirst.mockResolvedValue({ id: 'existing-user-id' });
    await expect(assertEmailAvailable('taken@test.com')).rejects.toThrow(EMAIL_ALREADY_REGISTERED_MSG);
  });

  it('looks up case-insensitively and does NOT scope by organization_id', async () => {
    mockFindFirst.mockResolvedValue(null);
    await assertEmailAvailable('Mixed@Case.com');
    expect(mockFindFirst).toHaveBeenCalledWith({
      where: { email: { equals: 'Mixed@Case.com', mode: 'insensitive' } },
      select: { id: true },
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx vitest run src/lib/__tests__/user-email-guard.test.ts`
Expected: FAIL — `Cannot find module '../user-email-guard'` (file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `backend/src/lib/user-email-guard.ts`:

```ts
import { prisma } from './prisma';

/**
 * Non-disclosive by design: never reveals which org owns the email, to
 * preserve cross-tenant privacy (org B should not learn an email belongs
 * to org A). Used identically by both create and invite — see
 * md_files/plans/security/2026-07-16-single-org-email-guard-design.md.
 */
export const EMAIL_ALREADY_REGISTERED_MSG =
  "This email already belongs to a Servwave account and can't be added to another organization.";

export class EmailAlreadyRegisteredError extends Error {
  constructor() {
    super(EMAIL_ALREADY_REGISTERED_MSG);
    this.name = 'EmailAlreadyRegisteredError';
  }
}

/**
 * Deliberately unscoped (no tenantWhere) — checks across every organization,
 * not just the caller's. Case-insensitive to also catch legacy/imported rows
 * that predate the emailSchema lowercase-on-write normalization.
 */
export async function assertEmailAvailable(email: string): Promise<void> {
  const existing = await prisma.user.findFirst({
    where: { email: { equals: email, mode: 'insensitive' } },
    select: { id: true },
  });
  if (existing) {
    throw new EmailAlreadyRegisteredError();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx vitest run src/lib/__tests__/user-email-guard.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/src/lib/user-email-guard.ts backend/src/lib/__tests__/user-email-guard.test.ts
git commit -m "feat(users): add cross-org email availability guard"
```

---

### Task 2: Wire the guard into `inviteUser`

**Files:**
- Modify: `backend/src/controllers/user.controller.ts:219-265` (function `inviteUser`)
- Modify: `backend/src/__tests__/users-staff-mgmt.test.ts` (tighten one existing test, add one new test)

**Interfaces:**
- Consumes: `assertEmailAvailable`, `EmailAlreadyRegisteredError`, `EMAIL_ALREADY_REGISTERED_MSG` from `../lib/user-email-guard` (Task 1).

- [ ] **Step 1: Write the failing tests**

In `backend/src/__tests__/users-staff-mgmt.test.ts`, add the import near the top (alongside the existing imports):

```ts
import { EMAIL_ALREADY_REGISTERED_MSG } from '../lib/user-email-guard';
```

Then, inside the existing `describe('POST /api/users/invite', ...)` block, add a new test **immediately before** the existing `'returns 409 on duplicate email'` test:

```ts
  it('409s with the canonical message and does NOT call prisma.user.create when the email already exists in another org', async () => {
    mockAuthAs('admin');
    mockPrisma.user.findFirst.mockResolvedValue({ id: 'existing-elsewhere' });

    const res = await request(app)
      .post('/api/users/invite')
      .set(authHeader('admin'))
      .send({ first_name: 'Jane', last_name: 'Doe', email: 'taken@test.com', role: 'TECHNICIAN' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe(EMAIL_ALREADY_REGISTERED_MSG);
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
  });
```

Then tighten the existing test right after it — replace:

```ts
  it('returns 409 on duplicate email', async () => {
    mockAuthAs('admin');
    const prismaError = Object.assign(new Error('Unique constraint'), { code: 'P2002', meta: { target: ['email'] } });
    mockPrisma.user.create.mockRejectedValue(prismaError);
    const res = await request(app)
      .post('/api/users/invite')
      .set(authHeader('admin'))
      .send({ first_name: 'Jane', last_name: 'Doe', email: 'dup@test.com', role: 'TECHNICIAN' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/email/i);
  });
```

with:

```ts
  it('returns 409 (canonical message) via the P2002 backstop — race between the guard check and the write', async () => {
    mockAuthAs('admin');
    const prismaError = Object.assign(new Error('Unique constraint'), { code: 'P2002', meta: { target: ['email'] } });
    mockPrisma.user.create.mockRejectedValue(prismaError);
    const res = await request(app)
      .post('/api/users/invite')
      .set(authHeader('admin'))
      .send({ first_name: 'Jane', last_name: 'Doe', email: 'dup@test.com', role: 'TECHNICIAN' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(EMAIL_ALREADY_REGISTERED_MSG);
  });
```

- [ ] **Step 2: Run tests to verify the new/changed ones fail**

Run: `cd backend && npx vitest run src/__tests__/users-staff-mgmt.test.ts`
Expected: FAIL — the new test gets a 201 (guard doesn't exist yet, `prisma.user.create` was mocked to resolve `undefined` so the handler proceeds); the tightened test still gets 409 but with the OLD message `'Email already in use'`, not the canonical one, so the `toBe(EMAIL_ALREADY_REGISTERED_MSG)` assertion fails.

- [ ] **Step 3: Wire the guard into the controller**

In `backend/src/controllers/user.controller.ts`, add the import alongside the existing ones near the top of the file (after the `emailSchema` import):

```ts
import { assertEmailAvailable, EmailAlreadyRegisteredError, EMAIL_ALREADY_REGISTERED_MSG } from '../lib/user-email-guard';
```

Then change `inviteUser` — insert the guard call right after the department check and before `prisma.user.create`:

```ts
export async function inviteUser(req: Request, res: Response) {
  const { email, first_name, last_name, role, department_id, phone, phone_ext } = req.body;

  try {
    if (department_id) {
      const dept = await prisma.department.findFirst({
        where: { id: department_id, ...tenantWhere(req) },
        select: { id: true },
      });
      if (!dept) {
        res.status(400).json({ error: 'Department not found' });
        return;
      }
    }

    await assertEmailAvailable(email);

    const user = await prisma.user.create({
      data: {
        email,
        first_name,
        last_name,
        role,
        phone: phone ?? null,
        phone_ext: phone_ext ?? null,
        has_login: true,
        password_hash: '',
        department_id: department_id ?? null,
        organization_id: req.user!.organization_id,
      },
      select: userSelect,
    });

    const { inviteUrl, emailSent } = await dispatchInvite({
      id: user.id, email: user.email, first_name: user.first_name, organization_id: req.user!.organization_id,
    });

    void logAudit({ req, action: 'user.invited', resourceType: 'User', resourceId: user.id, metadata: { email: user.email, role: user.role } });
    res.status(201).json({ user, email_sent: emailSent, invite_url: inviteUrl });
  } catch (err) {
    if (err instanceof EmailAlreadyRegisteredError) {
      res.status(409).json({ error: EMAIL_ALREADY_REGISTERED_MSG });
      return;
    }
    const prismaErr = err as { code?: string; meta?: { target?: string[] } };
    if (prismaErr.code === 'P2002' && prismaErr.meta?.target?.includes('email')) {
      res.status(409).json({ error: EMAIL_ALREADY_REGISTERED_MSG });
      return;
    }
    logger.error('Invite user error:', err);
    res.status(500).json({ error: 'Failed to invite user' });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx vitest run src/__tests__/users-staff-mgmt.test.ts`
Expected: PASS (all tests in the file, including the 2 touched above)

Also run the full existing invite suite to confirm no regressions:
Run: `cd backend && npx vitest run src/__tests__/users.test.ts`
Expected: PASS (unaffected — its invite tests never mock `findFirst`, which defaults to resolving falsy, so the guard passes through)

- [ ] **Step 5: Commit**

```bash
git add backend/src/controllers/user.controller.ts backend/src/__tests__/users-staff-mgmt.test.ts
git commit -m "feat(users): block invite when the email exists in another org"
```

---

### Task 3: Wire the guard into `create`

**Files:**
- Modify: `backend/src/controllers/user.controller.ts:147-204` (function `create`)
- Modify: `backend/src/__tests__/users.test.ts` (add new describe block)

**Interfaces:**
- Consumes: same as Task 2 (`assertEmailAvailable`, `EmailAlreadyRegisteredError`, `EMAIL_ALREADY_REGISTERED_MSG`), already imported into `user.controller.ts` by Task 2.

- [ ] **Step 1: Write the failing tests**

In `backend/src/__tests__/users.test.ts`, add the import near the top (alongside the existing imports):

```ts
import { EMAIL_ALREADY_REGISTERED_MSG } from '../lib/user-email-guard';
```

Then add a new top-level `describe` block (place it near the other `POST /api/users...` blocks):

```ts
describe('POST /api/users (create)', () => {
  it('creates a Supabase auth user + Prisma user for a brand-new email', async () => {
    mockAuthAs('admin');
    mockPrisma.user.findFirst.mockResolvedValue(null);
    mockSupabaseAdmin.auth.admin.createUser.mockResolvedValue({
      data: { user: { id: 'supa-new-id' } }, error: null,
    });
    mockPrisma.user.create.mockResolvedValue({
      id: 'supa-new-id', email: 'brandnew@test.com', first_name: 'Brand', last_name: 'New',
      role: 'TECHNICIAN', is_active: true, has_login: true, department_id: null, department: null,
      created_at: new Date(), updated_at: new Date(),
    });

    const res = await request(app)
      .post('/api/users')
      .set(authHeader('admin'))
      .send({ email: 'brandnew@test.com', password: 'StrongPass!1', first_name: 'Brand', last_name: 'New', role: 'TECHNICIAN' });

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: 'brandnew@test.com' });
  });

  it('409s with the canonical message and never calls Supabase when the email already exists in another org', async () => {
    mockAuthAs('admin');
    mockPrisma.user.findFirst.mockResolvedValue({ id: 'existing-elsewhere' });

    const res = await request(app)
      .post('/api/users')
      .set(authHeader('admin'))
      .send({ email: 'taken@test.com', password: 'StrongPass!1', first_name: 'A', last_name: 'B', role: 'SALES' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe(EMAIL_ALREADY_REGISTERED_MSG);
    expect(mockSupabaseAdmin.auth.admin.createUser).not.toHaveBeenCalled();
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
  });

  it('409s with the canonical message when Supabase itself reports the email already exists (orphaned auth account)', async () => {
    mockAuthAs('admin');
    mockPrisma.user.findFirst.mockResolvedValue(null);
    mockSupabaseAdmin.auth.admin.createUser.mockResolvedValue({
      data: { user: null },
      error: { code: 'email_exists', message: 'A user with this email address has already been registered' },
    });

    const res = await request(app)
      .post('/api/users')
      .set(authHeader('admin'))
      .send({ email: 'orphaned@test.com', password: 'StrongPass!1', first_name: 'A', last_name: 'B', role: 'SALES' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe(EMAIL_ALREADY_REGISTERED_MSG);
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `cd backend && npx vitest run src/__tests__/users.test.ts`
Expected: FAIL — test 2 gets a 500 (guard doesn't exist yet, so it falls through to the real Supabase call which isn't properly mocked for that path / or proceeds and hits the Prisma create with unmocked data); test 3 currently returns 400 with the raw Supabase message instead of 409 with the canonical one. Test 1 should already pass (it's the pre-existing happy path, added here for completeness since `create` had no prior coverage).

- [ ] **Step 3: Wire the guard into the controller**

In `backend/src/controllers/user.controller.ts`, change `create`:

```ts
export async function create(req: Request, res: Response) {
  const { email, password, first_name, last_name, role, department_id, phone, phone_ext } = req.body;

  try {
    if (department_id) {
      const dept = await prisma.department.findFirst({
        where: { id: department_id, ...tenantWhere(req) },
        select: { id: true },
      });
      if (!dept) {
        res.status(400).json({ error: 'Department not found' });
        return;
      }
    }

    await assertEmailAvailable(email);

    // Create in Supabase Auth first
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    if (authError || !authData.user) {
      const code = (authError as { code?: string } | null)?.code;
      const message = authError?.message ?? '';
      if (code === 'email_exists' || /already.*(registered|exists)/i.test(message)) {
        res.status(409).json({ error: EMAIL_ALREADY_REGISTERED_MSG });
        return;
      }
      res.status(400).json({ error: message || 'Failed to create auth user' });
      return;
    }

    // Create matching Prisma user with same ID (in requesting org)
    try {
      const user = await prisma.user.create({
        data: {
          id: authData.user.id,
          email,
          first_name,
          last_name,
          role,
          phone: phone ?? null,
          phone_ext: phone_ext ?? null,
          department_id: department_id ?? null,
          organization_id: req.user!.organization_id,
        },
        select: userSelect,
      });

      void logAudit({ req, action: 'user.created', resourceType: 'User', resourceId: user.id, metadata: { email: user.email, role: user.role } });
      res.status(201).json({ user });
    } catch (prismaError) {
      // Rollback: delete the Supabase Auth user if Prisma creation fails
      await supabaseAdmin.auth.admin.deleteUser(authData.user.id);
      logger.error('Create user Prisma error (rolled back Supabase):', prismaError);
      res.status(500).json({ error: 'Failed to create user' });
    }
  } catch (err) {
    if (err instanceof EmailAlreadyRegisteredError) {
      res.status(409).json({ error: EMAIL_ALREADY_REGISTERED_MSG });
      return;
    }
    logger.error('Create user error:', err);
    res.status(500).json({ error: 'Failed to create user' });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx vitest run src/__tests__/users.test.ts`
Expected: PASS (all tests, including the 3 new ones)

Also run the tenant-isolation suite to confirm the pre-existing cross-org `POST /api/users` test still passes (it hits the department check, which still runs before the new guard):
Run: `cd backend && npx vitest run src/__tests__/tenant-attack.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/controllers/user.controller.ts backend/src/__tests__/users.test.ts
git commit -m "feat(users): block direct-create when the email exists in another org"
```

---

### Task 4: Full regression pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full backend test suite**

Run: `cd backend && npm test`
Expected: PASS — every suite green, no unrelated failures.

- [ ] **Step 2: Typecheck**

Run: `cd backend && npx tsc -p tsconfig.build.json --noEmit`
Expected: no errors.

- [ ] **Step 3: Manually confirm the frontend needs no change**

Open `frontend/src/components/settings/StaffFormDialog.tsx:103-112` and confirm the `onSubmit` catch block still maps any `409` response to `form.setError('email', ...)`. No edit expected — this step is a sanity check that Task 2/3's status code (still `409`) didn't drift from what the frontend expects.

- [ ] **Step 4 (no commit — verification-only task)**

If Steps 1–3 all pass, this plan is complete. Nothing to stage or commit for this task.

---

## Self-Review

**Spec coverage:**
- New unscoped, case-insensitive guard → Task 1. ✅
- Wired into `inviteUser` before the write, P2002 backstop kept as defense-in-depth, canonical message on both paths → Task 2. ✅
- Wired into `create` before the Supabase call, Supabase `email_exists` mapped to the same canonical 409 → Task 3. ✅
- `acceptInvite` left untouched → no task touches `auth.controller.ts`. ✅
- No schema migration → confirmed, no task includes a `prisma migrate` step. ✅
- No frontend change → confirmed via existing-code read in the design phase; Task 4 Step 3 is a verification-only sanity check, not a build step. ✅
- No live/on-blur check → not present anywhere in this plan. ✅

**Placeholder scan:** no TBD/TODO; every step has complete, runnable code or an exact command with expected output.

**Type consistency:** `assertEmailAvailable(email: string): Promise<void>`, `EmailAlreadyRegisteredError`, and `EMAIL_ALREADY_REGISTERED_MSG` are defined once in Task 1 and consumed with identical names/signatures in Tasks 2 and 3. The `user.controller.ts` import line is introduced in Task 2 and reused (not re-imported) in Task 3, since both tasks edit the same file in sequence.
