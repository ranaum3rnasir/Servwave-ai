import type { AxiosError } from 'axios';
import type { ToastFn } from './handle429';
import { catalogEntry, PLAN_LABELS, featureNotInPlanCopy } from './entitlements/catalog';

/**
 * Entitlement gate (402 FEATURE_NOT_IN_PLAN) response handling.
 *
 * This deliberately does NOT navigate. It used to: the interceptor ran
 * `window.location.href = '/upgrade?...'` on any 402 from any request, which
 * meant one background widget calling a higher-plan module tore down whatever
 * page the user was actually on. A Pro org could not open a job, because
 * <JobDetailPage> mounts a Scale-only inventory cost rollup - the job itself
 * was fine, the stray 402 hijacked the navigation.
 *
 * The rule now: a module the org DOES have must never be taken away by a
 * module it does not. Only <RequireFeature> - a deliberate navigation into a
 * gated module - renders the upgrade page.
 *
 * Reads stay silent: a 402 on a GET means a widget mounted that should have
 * been hidden, which is a bug to fix at the call site, not something to
 * interrupt the user over. Writes toast, because a write is a user action and
 * silence would read as the app losing their input.
 */

// De-dupe per feature: a burst of failing writes must not stack toasts, but two
// DIFFERENT gated modules failing in the same window are two different messages
// and collapsing them would misinform. -Infinity is the "never shown" sentinel
// so the first call after a reset is never throttled against a `now()` like 1000.
const DEDUPE_MS = 3000;
const lastShownAt = new Map<string, number>();

const WRITE_METHODS = new Set(['post', 'put', 'patch', 'delete']);

/** Body shape of the backend's `requireFeature` denial. Every field is untrusted. */
interface FeatureDenial {
  feature?: unknown;
  required_plan?: unknown;
}

function describe(error: AxiosError): string {
  const body = (error.response?.data ?? {}) as FeatureDenial;
  const feature = typeof body.feature === 'string' ? body.feature : undefined;
  const entry = catalogEntry(feature);
  const bodyPlan = typeof body.required_plan === 'string' ? body.required_plan : undefined;

  // Body first, catalog second: the server is authoritative, but the route-guard
  // path can omit the field and the frontend mirror still names a plan. Only a body
  // plan that actually disagrees with the catalog mirror needs its own sentence -
  // otherwise this is exactly the shared "not in plan" copy.
  if (entry && bodyPlan && bodyPlan !== entry.minPlan) {
    return `${entry.label} is available on the ${PLAN_LABELS[bodyPlan] ?? bodyPlan} plan.`;
  }
  return featureNotInPlanCopy(feature);
}

/**
 * If `error` is a 402, handle it and return true; otherwise return false so the
 * caller keeps its normal error handling. NEVER navigates. `now` is injected for
 * testability, matching `handle429`.
 */
export function handle402(error: AxiosError, notify: ToastFn, now: () => number): boolean {
  if (error.response?.status !== 402) return false;

  const method = (error.config?.method ?? '').toLowerCase();
  if (!WRITE_METHODS.has(method)) return true; // read - handled: intentionally quiet

  const body = (error.response?.data ?? {}) as FeatureDenial;
  const key = typeof body.feature === 'string' ? body.feature : '';
  const last = lastShownAt.get(key) ?? -Infinity;
  if (now() - last < DEDUPE_MS) return true; // handled: intentionally quiet
  lastShownAt.set(key, now());

  notify({
    title: 'Not included in your plan',
    description: describe(error),
    variant: 'destructive',
  });
  return true;
}

/** Test-only: reset the de-dupe throttle between test cases. */
export function __resetHandle402Throttle(): void {
  lastShownAt.clear();
}
