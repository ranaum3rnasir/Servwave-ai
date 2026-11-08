import { lazy } from 'react';
import { Route } from 'react-router-dom';

import ProtectedRoute from '@/components/ProtectedRoute';
import RequireFeature from '@/components/RequireFeature';

import V2AppLayout from '../V2AppLayout';

const LeadsPage = lazy(() => import('../leads/LeadsPage'));
const LeadFormPage = lazy(() => import('../leads/LeadFormPage'));
const LeadDetailPage = lazy(() => import('../leads/LeadDetailPage'));

/**
 * Module 2 - Leads.
 *
 * The GUARD stack mirrors App.tsx exactly - ProtectedRoute(all four roles) >
 * RequireFeature("leads") - and `/v2/leads/:id/edit` is declared BEFORE
 * `/v2/leads/:id` for the same reason it is there.
 *
 * The CHROME is the only substitution: V2AppLayout stands in for the app's
 * AppLayout. Guards decide who may enter, the layout only decides what frames
 * the page, so swapping the second changes no permission.
 */
export function leadsV2Routes() {
  return (
    <Route element={<ProtectedRoute allowedRoles={['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN']} />}>
      <Route element={<V2AppLayout />}>
        <Route element={<RequireFeature feature="leads" />}>
          <Route path="/leads" element={<LeadsPage />} />
          <Route path="/leads/new" element={<LeadFormPage />} />
          <Route path="/leads/:id/edit" element={<LeadFormPage />} />
          <Route path="/leads/:id" element={<LeadDetailPage />} />
        </Route>
      </Route>
    </Route>
  );
}
