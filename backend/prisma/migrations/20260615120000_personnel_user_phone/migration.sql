-- Personnel port: phone + extension on team member (User). Additive, nullable, re-runnable.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "phone" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "phone_ext" TEXT;
