/**
 * Regression tests: the service-role Storage client must never be tainted by a
 * user session.
 *
 * Bug: `auth.signInWithPassword` / `auth.refreshSession` on the shared
 * `supabaseAdmin` client write the just-authenticated USER's session into the
 * client's in-memory session store. Every subsequent Storage call on that Node
 * instance then sends the user's access token (role: `authenticated`) instead of
 * the service-role key, so `auth.role() = 'service_role'` RLS checks fail —
 * intermittently, per backend instance, until restart. Symptom: private-bucket
 * uploads AND signed-URL mints return 400 (observed live: call-recordings sign
 * 200s and 400s interleaved for the same object).
 *
 * Why `persistSession: false` is NOT a fix (verified against @supabase/auth-js
 * GoTrueClient): when persistSession is false the client still stores the
 * session — just in an in-memory adapter instead of localStorage. `_saveSession`
 * (called by signInWithPassword/refreshSession) writes there, and `_useSession`
 * (which Storage uses to resolve its token) reads it back. So the guard only
 * changes WHERE the session lives, never WHETHER it taints the client.
 *
 * Fix: session-mutating auth calls run on a DEDICATED `supabaseAuth` client, so
 * `supabaseAdmin` (Storage + admin APIs) stays permanently service-role.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SUPABASE_SRC = readFileSync(join(__dirname, '../lib/supabase.ts'), 'utf8');
const AUTH_CTRL_SRC = readFileSync(join(__dirname, '../controllers/auth.controller.ts'), 'utf8');
const USER_CTRL_SRC = readFileSync(join(__dirname, '../controllers/user.controller.ts'), 'utf8');
const PASSWORD_RESET_SRC = readFileSync(join(__dirname, '../lib/password-reset.ts'), 'utf8');

describe('supabase service-role client isolation', () => {
  it('supabase.ts still sets persistSession/autoRefreshToken/detectSessionInUrl false on both clients', () => {
    expect(SUPABASE_SRC).toContain('persistSession: false');
    expect(SUPABASE_SRC).toContain('autoRefreshToken: false');
    expect(SUPABASE_SRC).toContain('detectSessionInUrl: false');
  });

  it('exports a DEDICATED supabaseAuth client, separate from supabaseAdmin', () => {
    expect(SUPABASE_SRC).toMatch(/export const supabaseAdmin\s*=\s*createClient/);
    expect(SUPABASE_SRC).toMatch(/export const supabaseAuth\s*=\s*createClient/);
  });

  it('auth.controller session mutations use supabaseAuth, never the Storage client supabaseAdmin', () => {
    // The whole bug: signInWithPassword / refreshSession must NOT touch supabaseAdmin.
    expect(AUTH_CTRL_SRC).not.toMatch(/supabaseAdmin\.auth\.signInWithPassword/);
    expect(AUTH_CTRL_SRC).not.toMatch(/supabaseAdmin\.auth\.refreshSession/);
    expect(AUTH_CTRL_SRC).toMatch(/supabaseAuth\.auth\.signInWithPassword/);
    expect(AUTH_CTRL_SRC).toMatch(/supabaseAuth\.auth\.refreshSession/);
  });

  // Password reset spec §4.2: the current-password re-check runs on a client made for that one
  // request. It must not touch supabaseAdmin (Storage RLS, above) nor the shared supabaseAuth,
  // whose in-memory session every other request on the instance also uses.
  it('user.controller password re-check uses a fresh isolated client, never a shared one', () => {
    expect(USER_CTRL_SRC).not.toMatch(/supabaseAdmin\.auth\.signInWithPassword/);
    expect(USER_CTRL_SRC).not.toMatch(/supabaseAuth\.auth\.signInWithPassword/);
    expect(USER_CTRL_SRC).toMatch(/createIsolatedAuthClient\(\)\.auth\.signInWithPassword/);
  });

  // Password reset spec §5.2: verifyOtp signs the token's user in on the client that runs it.
  it('the reset link check (verifyOtp) runs on a fresh isolated client, never a shared one', () => {
    expect(PASSWORD_RESET_SRC).not.toMatch(/supabaseAdmin\.auth\.verifyOtp/);
    expect(PASSWORD_RESET_SRC).not.toMatch(/supabaseAuth\.auth\.verifyOtp/);
    expect(PASSWORD_RESET_SRC).toMatch(/createIsolatedAuthClient\(\)\.auth\.verifyOtp/);
  });

  it('createIsolatedAuthClient builds a new non-persisting client on every call', async () => {
    const real = await vi.importActual<typeof import('../lib/supabase')>('../lib/supabase');
    const a = real.createIsolatedAuthClient();
    const b = real.createIsolatedAuthClient();

    expect(a).not.toBe(b);
    expect(a.auth).not.toBe(b.auth);
    for (const shared of [real.supabaseAdmin, real.supabaseAuth]) {
      expect(a).not.toBe(shared);
      expect(a.auth).not.toBe(shared.auth);
    }
    // The factory reuses the same no-persist / no-refresh options as the shared clients.
    expect(SUPABASE_SRC).toMatch(
      /export function createIsolatedAuthClient\(\)\s*\{\s*return createClient\(env\.SUPABASE_URL, env\.SUPABASE_SERVICE_ROLE_KEY, SERVICE_ROLE_AUTH_OPTS\);/,
    );
  });
});
