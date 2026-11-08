import { create } from 'zustand';
import { supabase } from '@/lib/supabase';
import api from '@/lib/axios';
import { clearQueryCache } from '@/lib/queryClient';
import { resetAccountScopedStores } from '@/lib/storeReset';
import { extractApiError } from '@/lib/utils';
import {
  buildAbility,
  emptyAbility,
  type AbilityRule,
  type AppAbility,
} from '@/lib/ability';

export interface User {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  // The BASE role - unchanged by SRVW-138. Route/nav gating (ProtectedRoute, App.tsx) reads
  // this field only; a custom role narrows GRANTS (CASL ability, via abilityRules) but never
  // this value, so it must never be used for a role === 'X' route check.
  role: 'ADMIN' | 'SALES' | 'DISPATCHER' | 'TECHNICIAN';
  // Present when the user holds a custom role; optional because a cached pre-SRVW-138 payload
  // may omit it.
  custom_role_id?: string | null;
  custom_role?: { key: string } | null;
  organization_id: string;
  // True when the user's org is flagged is_demo — gates the mock-first Reports.
  // Optional: a cached pre-flag payload may omit it; treated as false (real org).
  org_is_demo?: boolean;
  // Effective plan + resolved feature keys from the login / me payload.
  // Optional: a user cached before this shipped has neither — useFeature()
  // fails OPEN on undefined so existing sessions are not locked out at deploy.
  org_plan?: string;
  org_features?: string[];
  feature_overrides?: Record<string, unknown> | null;
  // Self-service profile fields. Optional because the cached/`/api/auth/me`
  // payload may predate them; the full row is merged in via applyUserPatch
  // after a profile save (PATCH /api/users/me returns these).
  phone?: string | null;
  phone_ext?: string | null;
  has_login?: boolean;
  // Signed URL to the uploaded profile photo, or null for the initials tile. Optional for the
  // same reason as phone/phone_ext above — the login response and any stale cached payload may
  // predate it; /api/auth/me always sets it (2026-08-04 plan).
  avatar_url?: string | null;
}

/**
 * Discriminated result of login(): either the backend completed the sign-in
 * (mfaRequired:false → session set, user authenticated), or it issued an MFA
 * challenge (mfaRequired:true → NO session set; the caller must collect a code
 * and call verifyMfa()).
 */
export type LoginResult =
  | { mfaRequired: false }
  | { mfaRequired: true; challengeId: string };

interface Session {
  access_token: string;
  refresh_token: string;
}

interface AuthState {
  user: User | null;
  ability: AppAbility;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<LoginResult>;
  verifyMfa: (challengeId: string, code: string) => Promise<void>;
  loginWithGoogle: (loginHint?: string) => Promise<void>;
  finalizeOAuthLogin: () => Promise<User>;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
  // Merge a partial user (e.g. the row returned by PATCH /api/users/me) into the
  // cached auth user so the header/profile reflect a self-service edit without a
  // full re-fetch. Identity fields the patch omits are preserved.
  applyUserPatch: (patch: Partial<User>) => void;
}

const CACHE_KEY = 'servwave_user';
const ABILITY_CACHE_KEY = 'servwave_ability_rules';

function getCachedUser(): User | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as User) : null;
  } catch {
    return null;
  }
}

export function setCachedUser(user: User | null): void {
  if (user) {
    localStorage.setItem(CACHE_KEY, JSON.stringify(user));
  } else {
    localStorage.removeItem(CACHE_KEY);
  }
}

/** The signed-in user's display name for surfaces that need a human-readable
 *  signature (drafted emails, AI-assist attribution) - full name when either
 *  half is set, falling back to the email, or empty string when signed out. */
export function userDisplayName(
  user: Pick<User, 'first_name' | 'last_name' | 'email'> | null | undefined,
): string {
  return user && (user.first_name || user.last_name)
    ? `${user.first_name} ${user.last_name}`.trim()
    : (user?.email ?? '');
}

function getCachedAbility(): AppAbility {
  try {
    const raw = localStorage.getItem(ABILITY_CACHE_KEY);
    if (!raw) return emptyAbility;
    const rules = JSON.parse(raw) as AbilityRule[];
    return buildAbility(rules);
  } catch {
    return emptyAbility;
  }
}

function setCachedAbilityRules(rules: AbilityRule[] | null): void {
  if (rules) {
    localStorage.setItem(ABILITY_CACHE_KEY, JSON.stringify(rules));
  } else {
    localStorage.removeItem(ABILITY_CACHE_KEY);
  }
}

// Optimistic rendering: cached user is displayed immediately on page refresh.
// checkAuth() validates in the background; on failure it clears the cache and redirects.
const cachedUser = getCachedUser();
const cachedAbility = getCachedAbility();

export const useAuthStore = create<AuthState>((set) => {
  // Shared post-credential flow: persist the Supabase session for token
  // refresh, hydrate the full profile + CASL rules, and open the gate. Used by
  // both the no-MFA login path and the verifyMfa() completion path so they stay
  // byte-for-byte identical (see auth.store.ts:92).
  const establishSession = async (user: User, session: Session) => {
    await supabase.auth.setSession({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
    });

    const { data: meData } = await api.get('/api/auth/me');
    const rules: AbilityRule[] = meData.abilityRules ?? [];
    const ability = buildAbility(rules);

    setCachedUser(user);
    setCachedAbilityRules(rules);
    set({ user, ability, isAuthenticated: true, isLoading: false });
  };

  return {
  user: cachedUser,
  ability: cachedAbility,
  isAuthenticated: !!cachedUser,
  isLoading: !cachedUser,
  error: null,

  login: async (email: string, password: string): Promise<LoginResult> => {
    set({ error: null, isLoading: true });
    try {
      // Login through our backend (which calls Supabase Auth)
      const { data } = await api.post('/api/auth/login', { email, password });

      // Email-OTP gate: the backend withholds the session and asks for a code.
      // Do NOT set a session — surface the challenge so the caller can verify.
      if (data.mfaRequired) {
        set({ isLoading: false });
        return { mfaRequired: true, challengeId: data.challengeId };
      }

      await establishSession(data.user, data.session);
      return { mfaRequired: false };
    } catch (err: unknown) {
      const message = extractApiError(err, 'Login failed');
      set({ error: message, isLoading: false });
      throw new Error(message);
    }
  },

  verifyMfa: async (challengeId: string, code: string): Promise<void> => {
    set({ error: null, isLoading: true });
    try {
      const { data } = await api.post('/api/auth/mfa/verify', { challengeId, code });
      await establishSession(data.user, data.session);
    } catch (err: unknown) {
      const message = extractApiError(err, 'Verification failed');
      set({ error: message, isLoading: false });
      throw new Error(message);
    }
  },

  loginWithGoogle: async (loginHint?: string) => {
    // Redirects the browser to Google; control returns to /auth/callback.
    // When a hint is given (the invite flow passes the invited email), pin the
    // request to that account: `login_hint` pre-selects it and `select_account`
    // forces a conscious pick — so a browser already signed into a DIFFERENT
    // Google account can't silently authenticate the wrong identity (which would
    // then fail the terms/authorization gate on the backend). The plain /login
    // flow passes no hint and keeps its original behavior.
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
        ...(loginHint ? { queryParams: { login_hint: loginHint, prompt: 'select_account' } } : {}),
      },
    });
  },

  finalizeOAuthLogin: async () => {
    // Supabase already set the session (detectSessionInUrl); the JWT is attached
    // by the axios interceptor. The backend gatekeeps and returns the profile.
    const { data } = await api.post('/api/auth/google/finalize');
    const rules: AbilityRule[] = data.abilityRules ?? [];
    const ability = buildAbility(rules);
    setCachedUser(data.user);
    setCachedAbilityRules(rules);
    set({ user: data.user, ability, isAuthenticated: true, isLoading: false });
    return data.user as User;
  },

  logout: async () => {
    try {
      await api.post('/api/auth/logout');
    } catch {
      // Ignore logout API errors
    }
    await supabase.auth.signOut();
    setCachedUser(null);
    setCachedAbilityRules(null);
    // Signing back in is a client-side navigation, so nothing else drops the previous
    // account's cached data. clearQueryCache() covers TanStack Query; the Zustand stores are
    // module singletons that outlive the logout on their own and need resetting explicitly.
    clearQueryCache();
    resetAccountScopedStores();
    set({ user: null, ability: emptyAbility, isAuthenticated: false, error: null });
  },

  checkAuth: async () => {
    // Only show loading if there's no cached user to display immediately
    if (!getCachedUser()) {
      set({ isLoading: true });
    }
    try {
      const { data } = await api.get('/api/auth/me');
      const rules: AbilityRule[] = data.abilityRules ?? [];
      const ability = buildAbility(rules);

      // Belt and braces on top of the sign-out clear: whoever the backend says we are now
      // is the only identity the cache may hold data for. A session that changes identity
      // without passing through logout() (OAuth completing over a dead session, a restored
      // session belonging to someone else) must not inherit the previous user's queries.
      if (getCachedUser()?.id && getCachedUser()?.id !== data.user.id) clearQueryCache();

      setCachedUser(data.user);
      setCachedAbilityRules(rules);
      set({ user: data.user, ability, isAuthenticated: true, isLoading: false });
    } catch {
      await supabase.auth.signOut();
      setCachedUser(null);
      setCachedAbilityRules(null);
      set({ user: null, ability: emptyAbility, isAuthenticated: false, isLoading: false });
    }
  },

  applyUserPatch: (patch) =>
    set((state) => {
      if (!state.user) return {};
      const next = { ...state.user, ...patch };
      setCachedUser(next);
      return { user: next };
    }),
  };
});
