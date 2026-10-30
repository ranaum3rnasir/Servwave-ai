import { lazy } from 'react';
import { Route } from 'react-router-dom';

import ProtectedRoute from '@/components/ProtectedRoute';
import RequirePageAccess from '@/components/RequirePageAccess';

import V2AppLayout from '../V2AppLayout';

const SchedulePage = lazy(() => import('../schedule/SchedulePage'));

/**
 * Module 7 - Schedule.
 *
 * The GUARD stack mirrors `App.tsx` exactly. `/schedule` (App.tsx:174) sits
 * directly inside `ProtectedRoute(all four roles)` with NO `RequireFeature`
 * wrapper and no nested `ProtectedRoute`: scheduling is Starter core, so there
 * is no entitlement key to gate on, and what each role may DO on the board is
 * decided inside the page by `boardCapabilitiesFor(ability)`, from switches rather than the
 * role's name - a person with none of the moving switches gets a read-only board, not a
 * redirect. Route ORDER is trivial here - one path, no params.
 *
 * The CHROME is the only substitution: V2AppLayout stands in for AppLayout.
 * Guards decide who may enter, the layout only decides what frames the page, so
 * swapping the second changes no permission.
 *
 * Page switch: `/schedule` opens on Access Schedule. A person without it is sent to their dashboard, which is
 * everyone's home page (Roles & Permissions, PRD 2).
 */
export function scheduleV2Routes() {
  return (
    <Route element={<ProtectedRoute allowedRoles={['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN']} />}>
      <Route element={<V2AppLayout />}>
        <Route element={<RequirePageAccess all={['access_schedule']} />}>
          <Route path="/schedule" element={<SchedulePage />} />
        </Route>
      </Route>
    </Route>
  );
}
