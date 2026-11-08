import { Navigate, Outlet } from 'react-router-dom';
import { useFeature } from '@/lib/entitlements';
import { useAppAbility } from '@/contexts/AbilityContext';

/**
 * Route guard for the dedicated `/phone` tab (Task A3 — the sole CTM
 * softphone device-owner surface). Gates on BOTH checks the master plan's
 * Global Constraints require for every phone surface/action:
 *   1. Org-level Communication access (`useFeature('phone')` — the org's
 *      plan entitlement; same check `<RequireFeature feature="phone">`
 *      uses for `/communication/*`).
 *   2. User-level CASL grant (`ability.can('create', 'Communication')`) —
 *      never a hardcoded role list, so future roles inherit access with zero
 *      code changes (see `create Communication`'s shared-baseline grant in
 *      `defaultGrants.ts`, Task A0).
 *
 * A user failing EITHER check is redirected to the dashboard so `/phone`
 * can't be reached by typing the URL. `useFeature('phone')` fails OPEN when
 * org_features is undefined (cosmetic only; the real boundary is the backend
 * 402), but CASL's emptyAbility always fails closed, providing a defense-in-depth
 * gate that keeps the softphone surface locked on auth-state gaps.
 */
export default function RequireCommunicationCreate() {
  const canAccessComms = useFeature('phone');
  const ability = useAppAbility();
  if (!canAccessComms || !ability.can('create', 'Communication')) {
    return <Navigate to="/" replace />;
  }
  return <Outlet />;
}
