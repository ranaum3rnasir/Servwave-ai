import { lazy } from 'react';
import { Route } from 'react-router-dom';

import ProtectedRoute from '@/components/ProtectedRoute';
import RequirePageAccess from '@/components/RequirePageAccess';

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
 * List switches: the Tasks list opens on View tasks. A person without it is sent to their
 * dashboard, which is everyone's home page (Roles & Permissions, PRD 2).
 */
export function tasksV2Routes() {
  return (
    <Route element={<ProtectedRoute allowedRoles={['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN']} />}>
      <Route element={<V2AppLayout />}>
        <Route element={<RequirePageAccess all={['view_tasks']} />}>
          <Route path="/tasks" element={<TasksHubPage />} />
        </Route>
      </Route>
    </Route>
  );
}
