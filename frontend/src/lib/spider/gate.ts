import { useAuthStore } from '@/stores/auth.store';

/**
 * Who has Spider, the lead watcher (#2619): the company owns the `spider` feature (Scale) AND,
 * while the launch is demo-only, it is a demo company. Every Spider surface checks this BEFORE
 * any Spider code loads or any Spider request is made.
 *
 * Fails closed on both halves - unlike useFeature, which fails open for a cached session that
 * predates the feature payload - so a session without the flags never reaches Spider code.
 * Opening Spider to Scale customers later means deleting the `org_is_demo` half here and in
 * backend/src/services/spider/gate.ts.
 */
export function spiderAvailableFor(
  user: { org_features?: readonly string[]; org_is_demo?: boolean } | null | undefined,
): boolean {
  return (user?.org_features ?? []).includes('spider') && user?.org_is_demo === true;
}

export function useSpiderAvailable(): boolean {
  return useAuthStore((s) => spiderAvailableFor(s.user));
}

/**
 * Who may manage Spider: an Admin. Spider's settings and History are Admin-only (the server
 * enforces it too). In ServWave an Admin is never also on a custom role, so the role is the answer.
 */
export function isSpiderAdminUser(user: { role?: string } | null | undefined): boolean {
  return user?.role === 'ADMIN';
}

export function useIsSpiderAdmin(): boolean {
  return useAuthStore((s) => isSpiderAdminUser(s.user));
}

/**
 * Browser keys an earlier, browser-side Spider kept its settings, read alerts and selections in.
 * Spider keeps nothing in the browser now - the server is the only source of truth - so these
 * are cleared on load wherever they still linger.
 */
export const RETIRED_SPIDER_STORAGE_KEYS = [
  'servwave_spider_watcher_settings',
  'servwave_spider_last_viewed_history_at',
] as const;

export function clearRetiredSpiderStorage(): void {
  try {
    for (const key of RETIRED_SPIDER_STORAGE_KEYS) window.localStorage.removeItem(key);
  } catch {
    // Storage can be unavailable (private mode, blocked site data); there is nothing to clear then.
  }
}
