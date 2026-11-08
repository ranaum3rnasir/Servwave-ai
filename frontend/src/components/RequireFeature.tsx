import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useFeature, catalogEntry } from '@/lib/entitlements';

interface Props {
  feature: string;
}

/**
 * Route-level entitlement gate. Renders the upgrade page instead of redirecting
 * to "/" so the user learns WHY the module is unavailable.
 *
 * Passes required_plan explicitly: the interceptor path gets it from the 402
 * body, but this path has no response to read, and UpgradePage would otherwise
 * render "Leads requires " with a dangling sentence.
 */
export default function RequireFeature({ feature }: Props) {
  const has = useFeature(feature);
  const location = useLocation();
  if (!has) {
    const requiredPlan = catalogEntry(feature)?.minPlan ?? '';
    const params = new URLSearchParams({ feature });
    if (requiredPlan) params.set('required_plan', requiredPlan);
    return <Navigate to={`/upgrade?${params.toString()}`} state={{ from: location }} replace />;
  }
  return <Outlet />;
}
