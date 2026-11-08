import { lazy } from 'react';
import { Navigate, Route } from 'react-router-dom';

import ProtectedRoute from '@/components/ProtectedRoute';
import RequireFeature from '@/components/RequireFeature';

import V2AppLayout from '../V2AppLayout';

const AutomationsHomePage = lazy(() => import('../automations/AutomationsHomePage'));
const AutomationBuilderPage = lazy(() => import('../automations/AutomationBuilderPage'));

/**
 * Module 14 - Automations.
 *
 * The GUARD stack mirrors App.tsx exactly, and the NESTING ORDER is
 * load-bearing:
 *
 *   ProtectedRoute(all four roles)          <- the app-wide gate
 *     V2AppLayout                            <- chrome only
 *       ProtectedRoute(ADMIN, DISPATCHER) with `fallback`
 *         RequireFeature("automations")
 *
 * The role guard is the OUTER of the inner two. With `fallback` set,
 * ProtectedRoute renders NotAuthorizedPage instead of bouncing to `/`, so a
 * SALES user on a STARTER org sees the not-authorized page rather than the
 * upgrade page. Swapping the two would change what that user sees. The backend
 * 403s SALES and TECHNICIAN on /api/workflows/* either way.
 *
 * `RequireFeature("automations")` resolves `minPlan: PRO` from the entitlement
 * catalog and redirects to /upgrade when the org lacks it.
 *
 * `relative="path"` on the /edit redirect is load-bearing for the same reason
 * it is in App.tsx: every parent route here is pathless (V2AppLayout, both
 * ProtectedRoutes, RequireFeature), so with the default relative="route" a
 * single ".." strips the whole "automations/:id/edit" leaf and resolves to "/"
 * rather than to the builder for that id. It is also declared LAST, after its
 * `/v2/automations/:id` sibling, exactly as App.tsx orders them.
 *
 * The CHROME is the only substitution: V2AppLayout stands in for the app's
 * AppLayout. Guards decide who may enter, the layout only decides what frames
 * the page, so swapping the second changes no permission.
 */
export function automationsV2Routes() {
  return (
    <Route element={<ProtectedRoute allowedRoles={['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN']} />}>
      <Route element={<V2AppLayout />}>
        <Route element={<ProtectedRoute allowedRoles={['ADMIN', 'DISPATCHER']} fallback />}>
          <Route element={<RequireFeature feature="automations" />}>
            <Route path="/automations" element={<AutomationsHomePage />} />
            <Route path="/automations/new" element={<AutomationBuilderPage />} />
            <Route path="/automations/:id" element={<AutomationBuilderPage />} />
            <Route path="/automations/:id/edit" element={<Navigate to=".." relative="path" replace />} />
          </Route>
        </Route>
      </Route>
    </Route>
  );
}
