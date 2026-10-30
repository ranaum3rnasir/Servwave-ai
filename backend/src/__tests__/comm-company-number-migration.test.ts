import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Pins the S08.1 migration (20261008090000) to schema.prisma. It adds columns, indexes and foreign
 * keys, so any disagreement with the schema is drift, and drift fails the DEPLOY, not the PR. The
 * behaviour of the backfill itself is proven against a real database in
 * scripts/__tests__/text-company-number-migration.integration.test.ts.
 */
describe('company number on calls and texts: migration vs schema', () => {
  const sql = readFileSync(
    join(__dirname, '../../prisma/migrations/20261008090000_comm_company_number_on_calls_and_texts/migration.sql'),
    'utf8',
  );
  const schema = readFileSync(join(__dirname, '../../prisma/schema.prisma'), 'utf8');
  const model = (name: string, map: string) =>
    schema.slice(schema.indexOf(`model ${name} {`), schema.indexOf('}', schema.indexOf(`@@map("${map}")`)));
  const callSession = model('CallSession', 'call_sessions');
  const message = model('Message', 'messages');

  it('declares the three nullable UUID columns the schema declares', () => {
    expect(callSession).toMatch(/phone_number_id\s+String\?\s+@db\.Uuid/);
    expect(message).toMatch(/phone_number_id\s+String\?\s+@db\.Uuid/);
    expect(message).toMatch(/sent_by_user_id\s+String\?\s+@db\.Uuid/);
    expect(sql).toMatch(/ALTER TABLE "call_sessions" ADD COLUMN IF NOT EXISTS "phone_number_id" UUID;/);
    expect(sql).toMatch(/ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "phone_number_id" UUID;/);
    expect(sql).toMatch(/ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "sent_by_user_id" UUID;/);
  });

  it('creates the indexes the schema declares, under Prisma default naming', () => {
    expect(callSession).toMatch(/@@index\(\[phone_number_id\]\)/);
    expect(message).toMatch(/@@index\(\[phone_number_id\]\)/);
    expect(message).toMatch(/@@index\(\[sent_by_user_id\]\)/);
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "call_sessions_phone_number_id_idx"');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "messages_phone_number_id_idx"');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "messages_sent_by_user_id_idx"');
  });

  it('clears the link, never the call or text, when the number or the person is deleted', () => {
    for (const relation of [
      /phone_number\s+PhoneNumber\?\s+@relation\("CallSessionPhoneNumber".*onDelete: SetNull/,
      /phone_number\s+PhoneNumber\?\s+@relation\("MessagePhoneNumber".*onDelete: SetNull/,
      /sent_by\s+User\?\s+@relation\("MessageSentBy".*onDelete: SetNull/,
    ]) {
      expect(callSession + message).toMatch(relation);
    }
    expect(sql).toMatch(/"call_sessions_phone_number_id_fkey"[\s\S]*REFERENCES "phone_numbers"\("id"\) ON DELETE SET NULL ON UPDATE CASCADE/);
    expect(sql).toMatch(/"messages_phone_number_id_fkey"[\s\S]*REFERENCES "phone_numbers"\("id"\) ON DELETE SET NULL ON UPDATE CASCADE/);
    expect(sql).toMatch(/"messages_sent_by_user_id_fkey"[\s\S]*REFERENCES "users"\("id"\) ON DELETE SET NULL ON UPDATE CASCADE/);
  });

  it('is idempotent and portable', () => {
    expect(sql).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_constraint WHERE conname = 'call_sessions_phone_number_id_fkey'\)/);
    expect(sql).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_constraint WHERE conname = 'messages_phone_number_id_fkey'\)/);
    expect(sql).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_constraint WHERE conname = 'messages_sent_by_user_id_fkey'\)/);
    // the backfill only writes calls that have no company number yet
    expect(sql).toMatch(/c\.phone_number_id IS NULL/);
    // nothing Supabase-only
    expect(sql).not.toMatch(/\bauthenticated\b|\banon\b|service_role|auth\.uid\(\)/);
  });

  it('does not backfill texts: placing them reads the phone service, which is the one-time fill-in', () => {
    expect(sql).not.toMatch(/UPDATE "messages"/);
  });

  it('is hand-written SQL, not a generated one (no prisma migrate from a worktree)', () => {
    expect(sql).not.toMatch(/This is an empty migration/);
    expect(sql.trimStart().startsWith('--')).toBe(true);
  });
});
