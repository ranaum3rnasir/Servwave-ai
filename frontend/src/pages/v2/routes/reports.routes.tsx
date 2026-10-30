import { lazy } from 'react';
import { Route } from 'react-router-dom';

import ProtectedRoute from '@/components/ProtectedRoute';
import DemoOnlyRoute from '@/components/DemoOnlyRoute';
import RequireReportAccess from '@/components/RequireReportAccess';
import RequirePageAccess from '@/components/RequirePageAccess';

import V2AppLayout from '../V2AppLayout';

const ReportsPage = lazy(() => import('../reports/ReportsPage'));
const ReportRoute = lazy(() => import('../reports/ReportRoute'));
const MarketingAnalyticsPage = lazy(() => import('../reports/MarketingAnalyticsPage'));

/**
 * Module 9 - Reports.
 *
 * Two sibling blocks, one per surface, each inside ProtectedRoute(all four roles), the app-wide sign-in gate that
 * wraps App.tsx's whole authenticated tree (it turns nobody away on role):
 *
 *   /reports, /reports/:slug   Open on switches, never on a role name (Roles & Permissions, PRD 2): Reports and every
 *                              report page on Access Reports, and the unpaid-invoices report, which is Billing, on
 *                              Access Billing or Access Reports (`RequireReportAccess`). A person without the switch
 *                              is sent to their dashboard. The server decides every report request on the same
 *                              switches, and the per-card and per-page gating inside the pages is CASL plus the
 *                              entitlement axis (`isReportVisible` / `canShowReport`), imported from the legacy
 *                              catalog rather than restated.
 *
 *   /marketing                 Access Marketing, with the demo-company rollout limit kept on top: `DemoOnlyRoute`
 *                              redirects real organizations to the dashboard, because the page is a mock with no
 *                              `/api/marketing` behind it. `DemoOnlyRoute` is not a substitute for the sign-in guard
 *                              (it only ever checks `useIsDemoOrg()`), so the stack keeps both.
 *
 * There is deliberately no `RequireFeature` on any of the three: `App.tsx` has none. Reports' entitlement gating is
 * per-report (`ReportDef.feature`, e.g. `inventory-usage` -> `inventory`) and is enforced inside `ReportRoute`, which
 * shows the "not in your plan" stub rather than a route-level bounce.
 *
 * The CHROME is the only substitution: V2AppLayout stands in for AppLayout.
 */
export function reportsV2Routes() {
  return (
    <>
      <Route element={<ProtectedRoute allowedRoles={['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN']} />}>
        <Route element={<V2AppLayout />}>
          <Route element={<RequirePageAccess all={['access_reports']} />}>
            <Route path="/reports" element={<ReportsPage />} />
          </Route>
          <Route element={<RequireReportAccess />}>
            <Route path="/reports/:slug" element={<ReportRoute />} />
          </Route>
        </Route>
      </Route>
      <Route element={<ProtectedRoute allowedRoles={['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN']} />}>
        <Route element={<V2AppLayout />}>
          <Route element={<RequirePageAccess all={['access_marketing']} />}>
            <Route element={<DemoOnlyRoute />}>
              <Route path="/marketing" element={<MarketingAnalyticsPage />} />
            </Route>
          </Route>
        </Route>
      </Route>
    </>
  );
}
