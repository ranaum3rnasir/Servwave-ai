import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Pins the WhatsAppMessage.lead_id migration (20260804200000) to schema.prisma,
 * the way permissions-technician-communication-backfill.test.ts pins its sibling
 * 20260804210000. Only that sibling had a pin, and this is the riskier of the
 * two: it adds a COLUMN, an INDEX and a FOREIGN KEY, so any disagreement with
 * the schema is drift - and drift fails the DEPLOY, not the PR.
 *
 * WHY THE COLUMN EXISTS: before it, the four comm channels had three different
 * anchor shapes and whatsapp_messages carried job_id with NO lead_id at all. One
 * shared visibility predicate cannot ride three shapes, and copying the emails
 * fragment onto whatsapp_messages would have matched NOTHING rather than failing
 * loudly - a filter that looks correct and hides everything.
 *
 * Verified read-only against the live staging DB (redacted-staging-ref) while
 * writing this: whatsapp_messages has no lead_id today, and messages_lead_id_fkey
 * is `ON UPDATE CASCADE ON DELETE SET NULL` - which is what this migration
 * mirrors and what the assertions below require.
 */
describe('whatsapp_messages.lead_id migration', () => {
  const sql = readFileSync(
    join(__dirname, '../../prisma/migrations/20260804200000_whatsapp_message_lead_id/migration.sql'),
    'utf8',
  );
  const schema = readFileSync(join(__dirname, '../../prisma/schema.prisma'), 'utf8');

  const whatsAppMessageModel = schema.slice(
    schema.indexOf('model WhatsAppMessage {'),
    schema.indexOf('}', schema.indexOf('@@map("whatsapp_messages")')),
  );

  it('declares the column the schema declares, nullable and UUID', () => {
    expect(whatsAppMessageModel).toMatch(/lead_id\s+String\?\s+@db\.Uuid/);
    expect(sql).toMatch(/ALTER TABLE "whatsapp_messages"\s+ADD COLUMN IF NOT EXISTS "lead_id" UUID;/);
  });

  it('creates the index the schema declares, under Prisma default naming', () => {
    // `@@index([lead_id])` on a model mapped to whatsapp_messages compiles to
    // exactly this name; a mismatch is drift even though the index "exists".
    expect(whatsAppMessageModel).toMatch(/@@index\(\[lead_id\]\)/);
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "whatsapp_messages_lead_id_idx"');
  });

  it('mirrors messages_lead_id_fkey exactly - deleting a lead must not take the history', () => {
    expect(whatsAppMessageModel).toMatch(/lead\s+Lead\?.*onDelete: SetNull/s);
    expect(sql).toContain('"whatsapp_messages_lead_id_fkey"');
    expect(sql).toMatch(/REFERENCES "leads"\("id"\) ON DELETE SET NULL ON UPDATE CASCADE/);
  });

  it('is idempotent on a second application', () => {
    // Column and index are IF NOT EXISTS; the FK sits behind a pg_constraint
    // existence check (postgres has no ADD CONSTRAINT IF NOT EXISTS); and the
    // backfill is guarded so a re-run cannot overwrite a repointed attribution.
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS');
    expect(sql).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_messages_lead_id_fkey'\)/);
    expect(sql).toMatch(/AND m\."lead_id" IS NULL/);
  });

  it('backfills from the parent chat, not from nothing', () => {
    // The chat's lead link is the ONLY lead linkage that existed before this
    // column, so every pre-existing message must inherit it - otherwise those
    // rows read as unanchored, i.e. ORG-WIDE, which is the opposite of scoping.
    expect(sql).toMatch(/UPDATE "whatsapp_messages" m/);
    expect(sql).toMatch(/SET "lead_id" = c\."lead_id"/);
    expect(sql).toMatch(/FROM "whatsapp_chats" c/);
    expect(sql).toMatch(/WHERE m\."chat_id" = c\."id"/);
  });

  it('never runs prisma migrate from a worktree - no generated header', () => {
    // A `prisma migrate dev` header here would mean the schema was diffed
    // against a live DB from inside a worktree, which is forbidden.
    expect(sql).not.toMatch(/This is an empty migration/);
    expect(sql.trimStart().startsWith('--')).toBe(true);
  });
});
