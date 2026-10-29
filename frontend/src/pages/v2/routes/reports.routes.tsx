import { lazy } from 'react';
import { Route } from 'react-router-dom';

import ProtectedRoute from '@/components/ProtectedRoute';
import DemoOnlyRoute from '@/components/DemoOnlyRoute';

import V2AppLayout from '../V2AppLayout';

const ReportsPage = lazy(() => import('../reports/ReportsPage'));
const ReportRoute = lazy(() => import('../reports/ReportRoute'));
const MarketingAnalyticsPage = lazy(() => import('../reports/MarketingAnalyticsPage'));

/**
 * Module 9 - Reports.
 *
 * The GUARD stack mirrors `App.tsx` exactly, and it is two different stacks
 * for the two surfaces, which is why they are two sibling blocks here:
 *
 *   /reports, /reports/:slug   ProtectedRoute(all four roles), the app-wide gate
 *                              that wraps App.tsx's whole authenticated tree,
 *                              then ProtectedRoute(['ADMIN','DISPATCHER'],
 *                              fallback). The outer wrapper was missing here for
 *                              a while; it rejects nobody on its own, but the
 *                              rule is that a v2 stack matches its legacy twin.
 *                              The coarse route gate is role-based because the
 *                              backend 403s SALES on `/api/reports/*`; the
 *                              per-card and per-page gating is CASL plus the
 *                              entitlement axis, and it lives inside the pages
 *                              (`isReportVisible` / `canShowReport`), imported
 *                              from the legacy catalog rather than restated.
 *                              `fallback` is carried over verbatim: without it
 *                              a SALES user is bounced to `/`, with it they get
 *                              the in-place "no access" screen.
 *
 *   /marketing                 ProtectedRoute(all four roles) > DemoOnlyRoute.
 *                              A mock page with no `/api/marketing` behind it,
 *                              so real orgs are redirected to the dashboard and
 *                              only demo orgs see it. `DemoOnlyRoute` is NOT a
 *                              substitute for the role gate: its own docstring
 *                              says it is "mounted inside the authed AppLayout,
 *                              so auth + role are already enforced upstream by
 *                              <ProtectedRoute>", and it only ever checks
 *                              `useIsDemoOrg()`. This block carried the demo
 *                              gate alone for a while, which left the v2 route
 *                              reachable without the authentication check its
 *                              legacy twin has - an unauthenticated visitor was
 *                              bounced to "/" by the demo check rather than to
 *                              "/login" by the role gate. The stack now mirrors
 *                              App.tsx.
 *
 * There is deliberately no `RequireFeature` on any of the three: `App.tsx` has
 * none. Reports' entitlement gating is per-report (`ReportDef.feature`, e.g.
 * `inventory-usage` -> `inventory`) and is enforced inside `ReportRoute`, which
 * shows the "not in your plan" stub rather than a route-level bounce.
 *
 * The CHROME is the only substitution: V2AppLayout stands in for AppLayout.
 */
export function reportsV2Routes() {
  return (
    <>
      <Route element={<ProtectedRoute allowedRoles={['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN']} />}>
        <Route element={<V2AppLayout />}>
          <Route element={<ProtectedRoute allowedRoles={['ADMIN', 'DISPATCHER']} fallback />}>
            <Route path="/reports" element={<ReportsPage />} />
            <Route path="/reports/:slug" element={<ReportRoute />} />
          </Route>
        </Route>
      </Route>
      <Route element={<ProtectedRoute allowedRoles={['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN']} />}>
        <Route element={<V2AppLayout />}>
          <Route element={<DemoOnlyRoute />}>
            <Route path="/marketing" element={<MarketingAnalyticsPage />} />
          </Route>
        </Route>
      </Route>
    </>
  );
}
