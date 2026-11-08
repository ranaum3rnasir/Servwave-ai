import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Guard for the hand-authored `leads.attribution` migration (web-form lead
 * intake slice 2, plan §3e): pure expand, idempotent, portable, and its own
 * file rather than an edit to the committed slice-1 migration.
 */
const DIR = '20260918130000_lead_attribution';
const sql = readFileSync(join(__dirname, `../../prisma/migrations/${DIR}/migration.sql`), 'utf8');

const slice1 = readFileSync(
  join(__dirname, '../../prisma/migrations/20260918120000_web_form_integrations/migration.sql'),
  'utf8',
);

/** The call side's twin, which this column's whole point is to be unionable with. */
const callSide = readFileSync(
  join(__dirname, '../../prisma/migrations/20260807120000_call_attribution/migration.sql'),
  'utf8',
);

/** One CREATE INDEX statement, whitespace-flattened, for a literal comparison. */
function indexStatement(source: string, name: string): string {
  const m = source.match(new RegExp(`CREATE INDEX[^;]*"${name}"[^;]*;`));
  if (!m) throw new Error(`no CREATE INDEX "${name}" in that migration`);
  return m[0].replace(/\s+/g, ' ').trim();
}

describe('lead attribution migration', () => {
  it('adds the column idempotently', () => {
    expect(sql).toMatch(/ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "attribution" JSONB/);
  });

  it('indexes the column the schema already promises is indexed', () => {
    // `Lead.attribution`'s schema comment says it is null and never `{}` "so a
    // partial index covers only rows that carry attribution" - which described
    // an index that did not exist. §3e's whole point is that "which campaign
    // produced revenue" is ONE union over calls and forms; indexing one half
    // and not the other defeats it.
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS "leads_attribution_idx"\s*ON "leads" USING GIN \("attribution" jsonb_path_ops\)\s*WHERE "attribution" IS NOT NULL/,
    );
  });

  it('mirrors the call-side statement exactly rather than inventing a second shape', () => {
    // Two halves of one union query indexed two different ways is how a planner
    // ends up choosing a sequential scan on one of them.
    expect(indexStatement(sql, 'leads_attribution_idx')).toBe(
      indexStatement(callSide, 'call_sessions_attribution_idx')
        .replace(/"call_sessions_attribution_idx"/, '"leads_attribution_idx"')
        .replace(/"call_sessions"/g, '"leads"'),
    );
  });

  it('builds the index in the ordinary way, never CONCURRENTLY', () => {
    // Prisma runs each migration inside a transaction and CREATE INDEX
    // CONCURRENTLY cannot run in one - recorded in
    // 20260819140000_visits_scheduled_at_index_multi_visit_s6 and verified
    // against a real postgres:16 before this was written. The column is brand
    // new and every row is NULL, so the ordinary build is instant anyway.
    // Matched as a STATEMENT, not as a word: the header comment has to be free
    // to explain why it is absent.
    expect(sql).not.toMatch(/^\s*CREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY/im);
  });

  it('drops or renames nothing (pure expand)', () => {
    expect(sql).not.toMatch(/DROP COLUMN|DROP TABLE|DROP TYPE|RENAME (COLUMN|TO)/i);
  });

  it('is portable: no Supabase-only role or auth object', () => {
    // CI applies this against a vanilla postgres:16 with no `anon`/`authenticated`
    // role and no `auth` schema, so an unguarded reference to either fails the
    // Database (migrations + RLS) job outright.
    expect(sql).not.toMatch(/TO (authenticated|anon|service_role)\b/);
    expect(sql).not.toMatch(/auth\.(uid|role|jwt)\(/);
  });

  it('leaves the committed slice-1 migration alone: it adds no lead column of its own', () => {
    // Editing an applied migration leaves its checksum disagreeing with the
    // ledger, so slice 2 gets its own file. If this ever fails, the column was
    // moved into slice 1's file rather than added beside it.
    expect(slice1).not.toMatch(/ALTER TABLE "leads"/);
  });

  it('does not write `leads.source`, which stays dead under the first-touch rule', () => {
    // Source is a first-touch CUSTOMER attribute (customers.ad_source). A lead
    // column would give a returning customer two origins.
    expect(sql).not.toMatch(/ADD COLUMN[^\n]*"source"/);
  });
});
