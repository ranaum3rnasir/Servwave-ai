/**
 * Spec C slice 5 - the message thread gains a FOURTH counterparty: a user.
 *
 * MessageThread already addresses a customer, a lead and a vendor, each as a nullable
 * id with a relation and an index. Staff SMS needs the same shape for a user, and this
 * suite pins the three properties that are expensive to get wrong later:
 *
 *   1. the relation is NAMED. A relation name is the JSON key an `include` produces, so
 *      renaming it after the fact breaks every API consumer. Both existing optional
 *      non-customer counterparties name theirs (LeadMessageThreads / VendorMessageThreads).
 *   2. the delete behaviour is SET NULL, matching all three siblings - deleting a user
 *      must never delete the conversation or block the delete outright.
 *   3. the migration is expand-only. A code rollback has to leave an unused nullable
 *      column and nothing else, so the .sql may carry no destructive statement and no
 *      backfill, and re-applying it must be a no-op.
 *
 * (3) is asserted against the migration file itself rather than a database: the local
 * env points at the SHARED STAGING database, so nothing here may connect.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Prisma } from '@prisma/client';
import { describe, it, expect } from 'vitest';

const MIGRATION = join(
  __dirname,
  '../../prisma/migrations/20260828170000_message_thread_user_counterparty/migration.sql',
);

const model = (name: string) => {
  const m = Prisma.dmmf.datamodel.models.find((x) => x.name === name);
  if (!m) throw new Error(`model ${name} not in the datamodel`);
  return m;
};
const field = (modelName: string, fieldName: string) => {
  const f = model(modelName).fields.find((x) => x.name === fieldName);
  if (!f) throw new Error(`${modelName}.${fieldName} not in the datamodel`);
  return f;
};

describe('MessageThread user counterparty', () => {
  it('carries a nullable user_id alongside the three existing counterparties', () => {
    const userId = field('MessageThread', 'user_id');
    expect(userId.kind).toBe('scalar');
    expect(userId.type).toBe('String');
    // Nullable, not required: a customer/lead/vendor thread legitimately has no user,
    // exactly as a user thread has no customer.
    expect(userId.isRequired).toBe(false);
    // Same physical type as the siblings, so the FK to users(id) is well-formed.
    expect(userId.nativeType?.[0]).toBe('Uuid');
  });

  it('names the user relation, as the two other optional counterparties do', () => {
    const user = field('MessageThread', 'user');
    expect(user.kind).toBe('object');
    expect(user.type).toBe('User');
    expect(user.isRequired).toBe(false);
    expect(user.relationFromFields).toEqual(['user_id']);
    expect(user.relationToFields).toEqual(['id']);
    // The name is the contract: it is the JSON key an include produces.
    expect(user.relationName).toBe('UserMessageThreads');
    // ...and it follows the shape the siblings already established.
    expect(field('MessageThread', 'lead').relationName).toBe('LeadMessageThreads');
    expect(field('MessageThread', 'vendor').relationName).toBe('VendorMessageThreads');
  });

  it('exposes the back-relation on User under the same relation name', () => {
    const threads = field('User', 'message_threads');
    expect(threads.kind).toBe('object');
    expect(threads.type).toBe('MessageThread');
    expect(threads.isList).toBe(true);
    expect(threads.relationName).toBe('UserMessageThreads');
  });

  it('sets the thread user id to null when the user is deleted', () => {
    // Declared EXPLICITLY rather than left to Prisma's default for an optional relation,
    // because the org purge depends on this behaviour: a user-keyed thread survives
    // tx.user.deleteMany with its user_id nulled, which is exactly the orphan the
    // organization-scoped catch-all sweep exists to clear.
    expect(field('MessageThread', 'user').relationOnDelete).toBe('SetNull');
  });
});

describe('the message_thread user counterparty migration', () => {
  const sql = readFileSync(MIGRATION, 'utf8');

  it('adds the column, the index and the FK, each guarded so a re-run is a no-op', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS "user_id" UUID/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS "message_threads_user_id_idx" ON "message_threads"\("user_id"\)/);
    // The FK cannot use IF NOT EXISTS, so it carries the pg_constraint guard instead.
    expect(sql).toMatch(/pg_constraint WHERE conname = 'message_threads_user_id_fkey'/);
    expect(sql).toMatch(/FOREIGN KEY \("user_id"\) REFERENCES "users"\("id"\)/);
  });

  it('deletes a user by nulling the pointer, matching the three sibling FKs', () => {
    expect(sql).toMatch(/ON DELETE SET NULL/);
    expect(sql).not.toMatch(/ON DELETE (CASCADE|RESTRICT|NO ACTION)/);
  });

  it('is expand-only, so rolling the code back leaves an unused column and nothing else', () => {
    // No destructive statement and no backfill: there is nothing to backfill onto a
    // column no row has ever carried, and a DROP here would make a code rollback lossy.
    //
    // Matched on statement FORMS, not bare keywords - `ON DELETE SET NULL` and
    // `ON UPDATE CASCADE` are referential-action clauses on the FK and are the
    // whole point of the migration, so a bare /DELETE/ scan would reject the
    // correct file.
    const statements = sql
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');
    expect(statements).not.toMatch(/\bDROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT|TYPE|SCHEMA)\b/i);
    expect(statements).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(statements).not.toMatch(/\bUPDATE\s+"?\w+"?\s+SET\b/i);
    expect(statements).not.toMatch(/\bTRUNCATE\b/i);
    // ALTER ... DROP in any spelling, which the form list above would miss.
    expect(statements).not.toMatch(/ALTER\s+TABLE[\s\S]*?\bDROP\b/i);
  });

  it('exists as a migration folder', async () => {
    const { readdirSync } = await import('node:fs');
    const dir = join(__dirname, '../../prisma/migrations');
    const names = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    // Presence, NOT position. This asserted "sorts last of all migrations" until it turned red on
    // PR #1940 - an unrelated permissions PR whose only crime was carrying a later timestamp. Its
    // premise was wrong too: `prisma migrate deploy` applies every folder ABSENT from
    // `_prisma_migrations`, in lexicographic order, whatever its position relative to ones already
    // applied - an out-of-order name is not silently skipped, it is applied out of order. The real
    // hazard is two migrations touching the SAME object, which a global sort assertion neither
    // detects nor prevents.
    expect(names).toContain('20260828170000_message_thread_user_counterparty');
  });
});
