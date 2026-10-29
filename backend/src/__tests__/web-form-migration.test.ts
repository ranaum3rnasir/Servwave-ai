import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Guard for the hand-authored web-form migration: pins the RLS backstop +
 * PostgREST revokes on BOTH new org-scoped tables, idempotent DDL, and the
 * unique keys the receiver's token lookup and the submission ledger's
 * claim-first insert depend on.
 */
const sql = readFileSync(
  join(__dirname, '../../prisma/migrations/20260918120000_web_form_integrations/migration.sql'),
  'utf8',
);

describe('web form integrations migration', () => {
  it('creates the enum and both tables idempotently', () => {
    expect(sql).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_type WHERE typname = 'WebFormProvider'\)/);
    expect(sql).toMatch(/CREATE TYPE "WebFormProvider" AS ENUM \('forminator'\)/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "web_form_integrations"/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "web_form_submissions"/);
  });

  it('carries no signing_key column: this vendor signs nothing, so the URL token is the only gate', () => {
    // The header comment says WHY there is none, so match a column definition
    // rather than the word.
    expect(sql).not.toMatch(/^\s*"signing_key"/m);
    expect(sql).not.toMatch(/ADD COLUMN[^\n]*signing_key/);
  });

  it('enforces the unique keys the token lookup and the idempotency claim rely on', () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "web_form_integrations_url_token_key"/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "web_form_integrations_organization_id_provider_key"/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS "web_form_submissions_organization_id_received_at_idx"/);
  });

  it('puts the ORGANIZATION in the submission ledger key, unlike ctm_events', () => {
    // A form plugin's entry id is its SITE's sequential counter, so every site's
    // second submission is `2`; the derived fallback key hashes (form title,
    // contact handle, minute), which is not org-specific either. A two-column key
    // therefore makes one org's ordinary submission another org's duplicate - and
    // the receiver's duplicate branch stores nothing at all, so that org loses the
    // ledger row, the Customer and the Lead, with a de-duplication log line as the
    // only trace. ctm_events is the opposite case and is right as it stands: one
    // vendor account mints those ids for everybody.
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS "web_form_submissions_organization_id_provider_submission_ke_key"\s*ON "web_form_submissions"\("organization_id", "provider", "submission_key"\)/,
    );
    // The two-column key is never CREATED. It is still NAMED, by the DROP the
    // next test pins, so match the CREATE rather than the bare name.
    expect(sql).not.toMatch(/CREATE UNIQUE INDEX[^\n]*"web_form_submissions_provider_submission_key_key"/);
    expect(sql).not.toMatch(/ON "web_form_submissions"\("provider", "submission_key"\)/);
  });

  it('DROPS the pre-fix global index, because this file was edited in place', () => {
    // a34c81151 changed the ledger's unique key from (provider, submission_key)
    // to (organization_id, provider, submission_key) by editing this migration
    // rather than adding a new one - and that is a DIFFERENT INDEX NAME. Every
    // statement here is IF NOT EXISTS and there was no DROP, so a database that
    // ran the PRE-FIX version keeps the old global index and goes on enforcing a
    // cross-tenant key for ever, which is the exact failure the fix was for.
    //
    // Staging and production both top out at 20260915170000 and never ran this,
    // so today it is latent. It is fixed anyway: the header claims this file is
    // honest about its own history, and any developer database, CI run or branch
    // that DID apply the earlier version is a real instance of it.
    const drop = 'DROP INDEX IF EXISTS "web_form_submissions_provider_submission_key_key";';
    expect(sql).toContain(drop);

    // BEFORE the new index, not after: the old one is what would be in the way.
    const create = 'CREATE UNIQUE INDEX IF NOT EXISTS "web_form_submissions_organization_id_provider_submission_ke_key"';
    expect(sql.indexOf(drop)).toBeGreaterThan(-1);
    expect(sql.indexOf(drop)).toBeLessThan(sql.indexOf(create));
  });

  it('names no index Postgres would truncate (63-character identifier limit)', () => {
    // The untruncated name for the three-column key is 64 characters, and Prisma
    // emits it truncated to 63. Postgres truncates silently, so an index whose
    // real name differs from the one Prisma generates is permanent drift - which
    // is how the pre-existing drift line in this repo happened. Every identifier
    // this file mints is therefore measured rather than trusted.
    const names = [...sql.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS "([^"]+)"/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(name.length).toBeLessThanOrEqual(63);
  });

  it('adds both organization foreign keys through a duplicate_object guard', () => {
    expect(sql).toMatch(/"web_form_integrations_organization_id_fkey"[\s\S]*?REFERENCES "organizations"\("id"\)/);
    expect(sql).toMatch(/"web_form_submissions_organization_id_fkey"[\s\S]*?REFERENCES "organizations"\("id"\)/);
    expect(sql.match(/EXCEPTION WHEN duplicate_object THEN null; END \$\$;/g) ?? []).toHaveLength(2);
  });

  it('leaves the submission ledger free of a lead/customer foreign key (slice 2 fills them)', () => {
    expect(sql).not.toMatch(/web_form_submissions_lead_id_fkey|web_form_submissions_customer_id_fkey/);
  });

  it('applies the tenant RLS backstop to both new org-scoped tables', () => {
    for (const table of ['web_form_integrations', 'web_form_submissions']) {
      expect(sql).toMatch(new RegExp(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`));
      expect(sql).toMatch(new RegExp(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`));
      expect(sql).toMatch(new RegExp(`DROP POLICY IF EXISTS "tenant_isolation" ON "${table}"`));
      expect(sql).toMatch(new RegExp(`CREATE POLICY "tenant_isolation" ON "${table}"`));
    }
  });

  it('revokes the PostgREST role grants behind a pg_roles guard (those roles exist only on Supabase)', () => {
    expect(sql).toMatch(/IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'anon'\)/);
    expect(sql).toMatch(/IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'authenticated'\)/);
    for (const table of ['web_form_integrations', 'web_form_submissions']) {
      expect(sql).toMatch(new RegExp(`REVOKE ALL PRIVILEGES ON public\\.${table} FROM anon`));
      expect(sql).toMatch(new RegExp(`REVOKE ALL PRIVILEGES ON public\\.${table} FROM authenticated`));
    }
  });

  it('drops or renames nothing a deploy overlap could miss (still an expand)', () => {
    // The one DROP INDEX above is deliberately not in this list and does not
    // match it. Dropping an index is invisible to the old instance running
    // during a deploy overlap - it names no column that has gone - which is
    // what this guard is actually protecting.
    expect(sql).not.toMatch(/DROP COLUMN|DROP TABLE|DROP TYPE|RENAME (COLUMN|TO)/i);
  });
});
