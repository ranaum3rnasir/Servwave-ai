import { lazy } from 'react';
import { Route } from 'react-router-dom';

import ProtectedRoute from '@/components/ProtectedRoute';

import V2AppLayout from '../V2AppLayout';

const TasksHubPage = lazy(() => import('../tasks/TasksHubPage'));

/**
 * Module 8 - Tasks.
 *
 * The GUARD stack mirrors `App.tsx` exactly: `/tasks` sits directly inside
 * `ProtectedRoute(all four roles)` with NO `RequireFeature` wrapper and no
 * nested `ProtectedRoute`. Tasks carries no entitlement gate; the sidebar entry
 * is CASL-filtered on `read Task` and the API enforces
 * `canDo('create'|'update'|'delete', 'Task')`, neither of which is a route
 * concern. Route ORDER is trivial here - one path, no params.
 *
 * The CHROME is the only substitution: V2AppLayout stands in for AppLayout.
 * Guards decide who may enter, the layout only decides what frames the page, so
 * swapping the second changes no permission.
 *
 * Landing-page note: `/` renders `V2HomeRoute`, which redirects a user without
 * `read Dashboard` to the first reachable entry of `DEFAULT_LAYOUT_KEYS`. That
 * is shared logic in `nav-registry` pointed at `/tasks`, which used to mean a
 * different page from this one and now means this one, so such a user lands here
 * without the registry being touched.
 */
export function tasksV2Routes() {
  return (
    <Route element={<ProtectedRoute allowedRoles={['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN']} />}>
      <Route element={<V2AppLayout />}>
        <Route path="/tasks" element={<TasksHubPage />} />
      </Route>
    </Route>
  );
}
