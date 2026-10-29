# Single-org email guard — design

**Date:** 2026-07-16
**Status:** Approved (brainstorming), pending implementation plan
**Linear:** referenced by Ran as "recorded in Linear" — exact issue not located by search; this spec supersedes it as the source of truth.

## Problem

Ran wants to restrict inviting/creating a user whose email already belongs to a user account elsewhere on the platform (a different organization). The stated trigger: he'd seen `ranroffe@servwave.com` "in two organizations."

## Investigation findings

Before designing, we verified the premise against the actual code and data rather than assuming it.

**The block already exists, structurally, today:**
- `User.email` is a plain global `@unique` in `backend/prisma/schema.prisma:13` → DB constraint `users_email_key` (case-sensitive).
- Supabase Auth's `auth.users.email` is also globally unique.
- Query across both live databases (`alpha-crm-staging` and `alpha-crm-cutover-clone`, i.e. prod) confirmed: **no email belongs to 2+ organizations in either database.** `ranroffe@servwave.com` exists once in staging (org "Servwave Test") and once in prod (org "Servwave Demo") — two different environments/databases, not two orgs within one running platform. The "two organizations" Ran recalled was staging vs. prod, not an in-platform duplicate.

**What's actually wrong is not a broken guarantee — it's that the guarantee is incidental, not intentional:**
1. **No deliberate pre-check.** Nothing explicitly asks "does this email already belong to a user?" before attempting a write. All three creation surfaces just let the DB/Supabase constraint throw, then translate whatever error comes back.
2. **Three inconsistent error paths** for what is conceptually one rule:
   - `POST /api/users` (`create`, `user.controller.ts:147`) — Supabase `createUser` runs first; on failure, the **raw Supabase error message** is passed through as a **400** (`user.controller.ts:169-172`). If Supabase succeeds but the subsequent Prisma insert then hits `P2002`, it rolls back the Supabase user and returns a generic **500** (`user.controller.ts:194-199`) — the true cause ("email already in use") is swallowed.
   - `POST /api/users/invite` (`inviteUser`, `user.controller.ts:219`) — relies entirely on the Prisma `P2002` catch (`user.controller.ts:256-261`) → **409 "Email already in use"**.
   - `POST /api/auth/accept-invite` (`acceptInvite`, `auth.controller.ts:731`) — a genuinely different scenario (an invited user setting their password reaches this only if a Prisma row for them already exists); if Supabase's `createUser` reports `email_exists`, returns **409 "This account is already set up. Please sign in…"** (`auth.controller.ts:761-767`). This message is correct as-is and is not part of the inconsistency being fixed.
3. **One real seam:** `resolveAppUser` (`backend/src/lib/auth-user.ts:60-81`) falls back to resolving a logged-in Supabase identity to a Prisma `User` **by confirmed email, case-insensitively, globally** (no org scoping) when the ids don't match. Today this is inert because `create` and `inviteUser` always keep Supabase-id and Prisma-id in sync — but it means an orphaned Supabase Auth account (no matching Prisma row — e.g. a Google-first sign-in with no Prisma row created) is silently adoptable by whichever org later invites that email, since `create`'s Supabase call is the only thing that would surface `email_exists`, and it currently does so by leaking the raw provider message (400) rather than a clear, intentional block.

**Conclusion:** the fix is not a data-integrity repair or a schema change — it's replacing "an accidental side-effect of a DB constraint, exposed through three inconsistent error messages" with one deliberate, legible guard.

## Decision

Approach: **application-level guard, checked explicitly, with one canonical error message reused across the two creation surfaces.** No schema migration.

Rejected alternatives:
- **Case-insensitive unique DB index** (replacing `users_email_key` with a functional index on `lower(email)`) — real hardening against direct/import writes that bypass the app layer, but it's a migration on the shared staging DB. Deferred as a follow-up, not bundled into this change (matches the standing preference to keep DB migrations separate/deferred — see `feedback-740-build-ui-defer-migration`).
- **Proactive/live checks** (on-blur "is this email taken?" endpoint, or scanning Supabase `admin.listUsers` during invite) — unscoped `listUsers` doesn't paginate well and a live-check endpoint is unrequested surface area. Skipped as YAGNI; nothing in the ask requires real-time feedback beyond a clear error on submit.

## Design

### New shared guard

`backend/src/lib/user-email-guard.ts` (new file):

```ts
export class EmailAlreadyRegisteredError extends Error {}

export const EMAIL_ALREADY_REGISTERED_MSG =
  "This email already belongs to a Servwave account and can't be added to another organization.";

export async function assertEmailAvailable(email: string): Promise<void> {
  const existing = await prisma.user.findFirst({
    where: { email: { equals: email, mode: 'insensitive' } }, // deliberately unscoped — no tenantWhere
    select: { id: true },
  });
  if (existing) throw new EmailAlreadyRegisteredError();
}
```

Deliberately **not** scoped by `tenantWhere` — the whole point is to look across every organization.

The message is intentionally **non-disclosive**: it does not name which org owns the email, and does not offer a "contact that org" or reactivation path. This preserves cross-tenant privacy (org B should not learn that a given email is a user in org A).

### Call sites

- **`create`** (`user.controller.ts:147`) — call `assertEmailAvailable(email)` first, before the Supabase `admin.createUser` call. Also: catch a Supabase `email_exists` error (in case of a race) and map it to the same 409/message instead of the current raw-message 400.
- **`inviteUser`** (`user.controller.ts:219`) — call `assertEmailAvailable(email)` first, before `prisma.user.create`. Keep the existing `P2002` catch as a defensive backstop (race between check and write), but have it return the same canonical message instead of the current "Email already in use" string.
- **`acceptInvite`** (`auth.controller.ts:731`) — **unchanged.** Its 409 ("This account is already set up. Please sign in…") addresses a different situation — the invitee completing their own account — and stays as-is.

Both call sites: on `EmailAlreadyRegisteredError`, respond `409 { error: EMAIL_ALREADY_REGISTERED_MSG }`.

### Frontend

The invite/create user form(s) map the 409 to an inline error under the email field (exact component(s) to be located during planning — likely under `frontend/src/pages/settings` or wherever user/team management lives). No new proactive/live-check UI.

### Tests (TDD)

Per project convention (`feedback_tdd`), isolation tests before controller changes:
- `assertEmailAvailable` — throws for an existing email in another org; throws case-insensitively (`Foo@x.com` vs `foo@x.com`); does not throw for a genuinely new email.
- `create` — inviting/creating an email that exists in another org → 409 canonical message, no Supabase user left orphaned (i.e. the guard runs *before* `admin.createUser`, so there's nothing to roll back).
- `inviteUser` — same 409 canonical message for an existing email; happy path (new email) unaffected.
- Regression: `acceptInvite`'s existing "already set up" message/behavior is unchanged.

## Out of scope

- Case-insensitive DB unique index (noted as a recommended follow-up above).
- Any live/on-blur availability check.
- Any change to how `resolveAppUser` resolves identity by email.
- Multi-org user membership (explicitly not what Ran wants — confirmed during brainstorming).
