---
name: writing-migrations
description: Author or apply a Prisma DB migration on ServWave so it survives all three places it runs. Use when creating/editing a migration .sql, changing backend/prisma/schema.prisma, or applying a migration via Supabase MCP.
user_invocable: true
---

# Writing Migrations

A migration `.sql` runs in **three** places, so it must be portable and idempotent:

1. **CI `Database (migrations + RLS)`** - vanilla `postgres:16`, no Supabase auth roles.
2. **Render deploy** - `startCommand` runs `prisma migrate deploy` on the Supabase DB.
3. **Manual** - applied by hand via Supabase MCP (`mcp__supabase__apply_migration`).

## Rules (every migration)

1. **Portable.** Supabase-only objects break vanilla Postgres: `TO authenticated`/`anon`/`service_role`,
   `auth.uid()`, `auth.*`. Guard them so CI's plain Postgres skips them:
   ```sql
   DO $$ BEGIN
     IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
       EXECUTE 'CREATE POLICY ...';
     END IF;
   END $$;
   ```
2. **Idempotent.** The shared staging DB may see a migration twice. Always:
   - `CREATE TABLE/INDEX IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`
   - `DROP POLICY IF EXISTS ...` before every `CREATE POLICY`
3. **Never `prisma migrate` from a worktree.** The local `.env` points at **staging** - running migrate
   there mutates the shared staging DB. Let CI + Render apply it, or apply via Supabase MCP.
4. **Never embed secrets** in a migration file (they are committed). Keys/tokens/passwords never belong in `.sql`.

## Gotchas (from past incidents)

- **Storage RLS:** use `auth.role()` + `TO public`; do not issue SQL `DELETE` on `storage.objects`.
  See vault feedback `Supabase Storage RLS pattern`.
- **`prisma migrate diff` bundles unrelated drift** - review the generated SQL and strip anything you did
  not intend before committing. See vault `Learnings/Prisma-Migrate-Diff-Bundles-Drift`.
- **Never move the DB ahead of the branch** - a column/enum present in staging but not in the merged code
  500s untyped *and* typed queries. See memory `learning-staging-enum-drift-breaks-untyped-and-typed-queries`.
- **Log the DB error before a role cutover** so a failed policy/grant is diagnosable.
  See memory `learning-log-db-error-before-role-cutover`.

## Checklist before opening the PR

- [ ] Every Supabase-only object is wrapped in a `pg_roles` guard (portability).
- [ ] Every `CREATE` uses `IF NOT EXISTS`; every `CREATE POLICY` is preceded by `DROP POLICY IF EXISTS`.
- [ ] No `prisma migrate` was run from a worktree.
- [ ] No secrets in the `.sql`.
- [ ] `prisma migrate diff` output reviewed - no unintended drift bundled in.
