import { describe, it, expect } from 'vitest';
import { createClient } from '@supabase/supabase-js';

/**
 * B-01 / F-71 regression guard. Proves the bundled anon key cannot reach PII or financial
 * tables through the Supabase Data API (PostgREST).
 *
 * OPT-IN: runs ONLY when RUN_ANON_LOCKOUT_TEST=1 AND SUPABASE_URL + SUPABASE_ANON_KEY are
 * set. It is gated on the EXPLICIT flag (not merely on the keys) so it never fires during the
 * normal local/CI suite — where SUPABASE_URL is often present but may point at a project whose
 * Data API has not yet been locked down (which would make this red on every run).
 *
 * After applying backend/scripts/security/2026-06-15-keystone-rls-revoke.sql + disabling the
 * Data API + rotating the anon key, run against EACH project:
 *   RUN_ANON_LOCKOUT_TEST=1 SUPABASE_URL=<proj-url> SUPABASE_ANON_KEY=<rotated-anon> \
 *     npx vitest run src/__tests__/anon-postgrest-lockout.test.ts
 *
 * Locked-down = anon gets an error (RLS / revoked grant / Data API off) and/or an empty
 * result. A populated row, or a successful insert, is the failure this guards against.
 */
const url = process.env.SUPABASE_URL;
const anon = process.env.SUPABASE_ANON_KEY;
const enabled = process.env.RUN_ANON_LOCKOUT_TEST === '1' && !!url && !!anon;
const SENSITIVE_TABLES = ['users', 'payments', 'role_permissions', 'invoices'] as const;

describe.skipIf(!enabled)('anon PostgREST lockout (live project)', () => {
  // Only constructed when enabled, so a skipped run never touches createClient with no URL.
  const client = enabled ? createClient(url!, anon!, { auth: { persistSession: false } }) : (null as never);

  for (const table of SENSITIVE_TABLES) {
    it(`anon cannot read rows from "${table}"`, async () => {
      const { data, error } = await client.from(table).select('*').limit(1);
      const leaked = !error && Array.isArray(data) && data.length > 0;
      expect(leaked, `anon leaked ${data?.length ?? 0} row(s) from "${table}"`).toBe(false);
    });

    it(`anon cannot insert into "${table}"`, async () => {
      const { error } = await client.from(table).insert({} as never);
      expect(error, `anon insert into "${table}" unexpectedly succeeded`).not.toBeNull();
    });
  }
});
