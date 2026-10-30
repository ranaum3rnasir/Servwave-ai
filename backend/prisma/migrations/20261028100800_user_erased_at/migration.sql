-- Roles & Permissions alignment, AL-13b (P19, A5): users.erased_at marks a deactivated person whose personal data an Admin
-- erased (name, email, phone, photo, credentials). The row and every link to it stay; an erased person cannot sign in or
-- be reactivated. Schema only: IDEMPOTENT, plain PostgreSQL. NEVER run `prisma migrate` from a worktree.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "erased_at" TIMESTAMP(3);
