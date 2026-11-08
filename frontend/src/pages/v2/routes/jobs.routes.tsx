import { lazy } from 'react';
import { Route } from 'react-router-dom';

import ProtectedRoute from '@/components/ProtectedRoute';

import V2AppLayout from '../V2AppLayout';

const JobsPage = lazy(() => import('../jobs/JobsPage'));
const JobFormPage = lazy(() => import('../jobs/JobFormPage'));
const JobDetailPage = lazy(() => import('../jobs/JobDetailPage'));
// The Customers module owns this file; it handles the customer AND the job
// scope from one component (`params.jobId ? 'job' : 'customer'`), which is
// exactly how App.tsx mounts the legacy `pages/StatementPage` on both routes.
// Pointing at it rather than copying it keeps the four scope-dependent
// differences in one place.
const StatementPage = lazy(() => import('../customers/StatementPage'));

/**
 * Module 5 - Jobs.
 *
 * The GUARD stack mirrors App.tsx exactly: ONE ProtectedRoute over all four
 * roles, and NO RequireFeature - App.tsx puts no entitlement gate on any job
 * route (unlike the `/leads` block immediately above it there). Route ORDER is
 * App.tsx's: `/jobs/new` before `/jobs/:id`, statement last.
 *
 * The `/jobs/new` ability redirect stays where App.tsx leaves it - inside
 * `JobFormPage`, which returns `<Navigate to="/jobs" replace />` when
 * `create Job` is absent. It is a page guard there, not a route guard, and
 * promoting it to one would change which component decides.
 *
 * The CHROME is the only substitution: V2AppLayout stands in for the app's
 * AppLayout. Guards decide who may enter, the layout only decides what frames
 * the page, so swapping the second changes no permission.
 */
export function jobsV2Routes() {
  return (
    <Route element={<ProtectedRoute allowedRoles={['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN']} />}>
      <Route element={<V2AppLayout />}>
        <Route path="/jobs" element={<JobsPage />} />
        <Route path="/jobs/new" element={<JobFormPage />} />
        <Route path="/jobs/:id" element={<JobDetailPage />} />
        <Route path="/jobs/:jobId/statement" element={<StatementPage />} />
      </Route>
    </Route>
  );
}
