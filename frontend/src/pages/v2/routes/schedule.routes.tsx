import { lazy } from 'react';
import { Route } from 'react-router-dom';

import ProtectedRoute from '@/components/ProtectedRoute';

import V2AppLayout from '../V2AppLayout';

const SchedulePage = lazy(() => import('../schedule/SchedulePage'));

/**
 * Module 7 - Schedule.
 *
 * The GUARD stack mirrors `App.tsx` exactly. `/schedule` (App.tsx:174) sits
 * directly inside `ProtectedRoute(all four roles)` with NO `RequireFeature`
 * wrapper and no nested `ProtectedRoute`: scheduling is Starter core, so there
 * is no entitlement key to gate on, and what each role may DO on the board is
 * decided inside the page by `boardCapabilitiesFor(role)` - a technician gets a
 * read-only board, not a redirect. Route ORDER is trivial here - one path, no
 * params.
 *
 * The CHROME is the only substitution: V2AppLayout stands in for AppLayout.
 * Guards decide who may enter, the layout only decides what frames the page, so
 * swapping the second changes no permission.
 *
 * Landing-page note: `/` renders `V2HomeRoute`, which sends a user without
 * `read Dashboard` to the first reachable entry of `DEFAULT_LAYOUT_KEYS` - and
 * for a TECHNICIAN that entry is `schedule`. That redirect is shared logic in
 * `nav-registry` pointed at `/schedule`, which used to mean a different page
 * from this one and now means this one, so the technician landing screen
 * resolves here without the registry being touched.
 */
export function scheduleV2Routes() {
  return (
    <Route element={<ProtectedRoute allowedRoles={['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN']} />}>
      <Route element={<V2AppLayout />}>
        <Route path="/schedule" element={<SchedulePage />} />
      </Route>
    </Route>
  );
}
