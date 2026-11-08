import { lazy } from 'react';
import { Route } from 'react-router-dom';

import ProtectedRoute from '@/components/ProtectedRoute';
import RequireFeature from '@/components/RequireFeature';

import V2AppLayout from '../V2AppLayout';

const ServicePlansPage = lazy(() => import('../service-plans/ServicePlansPage'));

/**
 * Module 15 - Service Plans.
 *
 * The GUARD stack mirrors App.tsx exactly - ProtectedRoute(all four roles) >
 * RequireFeature("service_plans"). There is deliberately NO role sub-gate,
 * because App.tsx has none either: `read ServicePlan` is granted to DISPATCHER
 * (and ADMIN through `manage all`) and to nobody else, so a SALES or TECHNICIAN
 * user who types the URL renders the page and then sees an empty list where the
 * API 403s. That hole is real, it is today's behaviour, and closing it here
 * would change who can reach a page inside a restyle. It is recorded in the
 * module's gap ledger instead.
 *
 * The CHROME is the only substitution: V2AppLayout stands in for the app's
 * AppLayout. Guards decide who may enter, the layout only decides what frames
 * the page, so swapping the second changes no permission.
 */
export function servicePlansV2Routes() {
  return (
    <Route element={<ProtectedRoute allowedRoles={['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN']} />}>
      <Route element={<V2AppLayout />}>
        <Route element={<RequireFeature feature="service_plans" />}>
          <Route path="/service-plans" element={<ServicePlansPage />} />
        </Route>
      </Route>
    </Route>
  );
}
