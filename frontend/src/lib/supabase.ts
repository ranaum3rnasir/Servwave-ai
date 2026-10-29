import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,
  },
});

// Cached access token — updated synchronously on every auth state change.
let currentAccessToken: string | null = null;

// Keep the cache up to date (fires on login, logout, and auto-refresh).
supabase.auth.onAuthStateChange((_event, session) => {
  currentAccessToken = session?.access_token ?? null;
});

// Seed the cache from the persisted session on module load.
supabase.auth.getSession().then(({ data }) => {
  currentAccessToken = data.session?.access_token ?? null;
});

/** Synchronous getter — safe to call in the axios request interceptor hot path. */
export function getAccessToken(): string | null {
  return currentAccessToken;
}
