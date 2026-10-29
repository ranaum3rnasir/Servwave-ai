import { lazy } from 'react';
import { Route } from 'react-router-dom';

import ProtectedRoute from '@/components/ProtectedRoute';

import V2AppLayout from '../V2AppLayout';

const EstimatesPage = lazy(() => import('../estimates/EstimatesPage'));
const NewEstimateRedirect = lazy(() => import('../estimates/NewEstimateRedirect'));
const EstimateWorkspacePage = lazy(() => import('../estimates/EstimateWorkspacePage'));
const EstimateVersionPage = lazy(() => import('../estimates/EstimateVersionPage'));

/**
 * Module 4 - Estimates.
 *
 * The GUARD stack mirrors App.tsx exactly: the three estimate routes sit
 * directly inside `ProtectedRoute(all four roles)` with NO `RequireFeature`
 * wrapper - unlike `/leads`, estimates are Starter-core and carry no
 * entitlement gate. Access control is entirely the API's CASL checks plus the
 * in-page `ability.can(...)` conditionals the pages carry over verbatim.
 *
 * Route ORDER mirrors App.tsx too: `/estimates/new` before `/estimates/:id`,
 * so the literal segment is never swallowed by the param.
 *
 * The CHROME is the only substitution: V2AppLayout stands in for the app's
 * AppLayout. Guards decide who may enter, the layout only decides what frames
 * the page, so swapping the second changes no permission.
 */
export function estimatesV2Routes() {
  return (
    <Route element={<ProtectedRoute allowedRoles={['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN']} />}>
      <Route element={<V2AppLayout />}>
        <Route path="/estimates" element={<EstimatesPage />} />
        <Route path="/estimates/new" element={<NewEstimateRedirect />} />
        <Route path="/estimates/:id" element={<EstimateWorkspacePage />} />
        {/* #2030 — a past version, on its OWN route rather than a mode flag on the workspace, so
            read-only is structural. Declared before nothing and after `/estimates/:id` is fine:
            the two paths differ by segment count, not by a literal-versus-param collision. */}
        <Route path="/estimates/:id/versions/:version" element={<EstimateVersionPage />} />
      </Route>
    </Route>
  );
}
