import { lazy } from 'react';
import { Route } from 'react-router-dom';

import ProtectedRoute from '@/components/ProtectedRoute';

import V2AppLayout from '../V2AppLayout';

const DashboardPage = lazy(() => import('../dashboard/DashboardPage'));

/**
 * Module 1 - Dashboard.
 *
 * `/` is every signed-in person's home page and renders the dashboard for all of them, whatever their switches say: the
 * dashboard has no switch (Roles & Permissions, PRD 2), its endpoints answer everyone, and what it shows is the
 * person's own layout. There is no "first page you may open" redirect and no fallback page, so a role with every
 * switch off lands here and never loops. Every hidden page's guard sends its refusals to this route.
 *
 * The GUARD stack is the app-wide one only: `ProtectedRoute` (all four roles), with NO `RequireFeature` - the
 * dashboard is not entitlement-gated.
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
        <Route path="/" element={<DashboardPage />} />
      </Route>
    </Route>
  );
}
