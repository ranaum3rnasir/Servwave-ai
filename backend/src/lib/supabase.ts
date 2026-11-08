import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env';

const SERVICE_ROLE_AUTH_OPTS = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
} as const;

// supabaseAdmin — the service-role client for Storage + admin APIs. It must stay
// PERMANENTLY service-role, so it must NEVER run a session-mutating auth call
// (signInWithPassword / refreshSession / setSession). Those write the
// just-authenticated USER's session into the client and every subsequent Storage
// call then sends the user's `authenticated` token instead of the service-role
// key, so `auth.role() = 'service_role'` RLS checks fail — intermittently, per
// Node instance, until restart (observed live: private-bucket sign/upload 400s).
//
// NOTE: persistSession:false does NOT protect against this. Per @supabase/auth-js
// GoTrueClient, persistSession:false just swaps localStorage for an in-memory
// session adapter — _saveSession still writes there and _useSession (which Storage
// uses to resolve its token) still reads it back. The ONLY reliable isolation is
// keeping session-mutating auth calls off this client entirely — see supabaseAuth.
// Regression coverage: __tests__/supabase-client-isolation.test.ts.
export const supabaseAdmin = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  SERVICE_ROLE_AUTH_OPTS,
);

// supabaseAuth — a SEPARATE service-role client dedicated to session-based auth
// operations (login / token refresh / password re-auth). Its in-memory session
// gets overwritten by each signInWithPassword/refreshSession, which is harmless
// because this client is never used for Storage. This is what keeps supabaseAdmin
// clean. Auth `admin.*` calls and getUser(token) do NOT mutate the session, so
// they stay on supabaseAdmin.
export const supabaseAuth = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  SERVICE_ROLE_AUTH_OPTS,
);
