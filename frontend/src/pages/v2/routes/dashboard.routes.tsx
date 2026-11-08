import { lazy } from 'react';
import { Route } from 'react-router-dom';

import ProtectedRoute from '@/components/ProtectedRoute';

import V2AppLayout from '../V2AppLayout';

const V2HomeRoute = lazy(() => import('../dashboard/V2HomeRoute'));

/**
 * Module 1 - Dashboard.
 *
 * The GUARD stack mirrors App.tsx exactly. There, `/` sits under
 * `ProtectedRoute allowedRoles={['ADMIN','SALES','DISPATCHER','TECHNICIAN']}`
 * with NO `RequireFeature` - the dashboard is not entitlement-gated - and the
 * element is `HomeRoute`, not `DashboardPage`. That indirection is the guard:
 * `read Dashboard` is admin/dispatcher-only, so a SALES or TECHNICIAN user who
 * rendered the page directly would hit `GET /api/dashboard` and 403 on their
 * own landing screen. `V2HomeRoute` reproduces that resolution over the same
 * `nav-registry` inputs, so the four roles land exactly where they do today.
 *
 * The CHROME is the only substitution: V2AppLayout stands in for AppLayout.
 *
 * `path="/"` is the app root, and this route is now its ONLY declaration: the
 * legacy `/` entry left App.tsx when this design took the bare paths, so there
 * is no overlapping pattern left for route ranking to resolve.
 * `__tests__/dashboardRoute.test.ts` pins both the literal and the resolution
 * rather than trusting either.
 */
export function dashboardV2Routes() {
  return (
    <Route element={<ProtectedRoute allowedRoles={['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN']} />}>
      <Route element={<V2AppLayout />}>
        <Route path="/" element={<V2HomeRoute />} />
      </Route>
    </Route>
  );
}
