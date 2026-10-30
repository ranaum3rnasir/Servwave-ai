import { lazy } from 'react';
import { Navigate, Route } from 'react-router-dom';

import ProtectedRoute from '@/components/ProtectedRoute';
import RequireFeature from '@/components/RequireFeature';
import RequirePageAccess from '@/components/RequirePageAccess';

import V2AppLayout from '../V2AppLayout';

const AutomationsHomePage = lazy(() => import('../automations/AutomationsHomePage'));
const AutomationBuilderPage = lazy(() => import('../automations/AutomationBuilderPage'));

/**
 * Module 14 - Automations.
 *
 * The GUARD stack mirrors App.tsx, with the role-name lock replaced by switches (Roles & Permissions, PRD 2), and
 * the NESTING ORDER is load-bearing:
 *
 *   ProtectedRoute(all four roles)          <- the app-wide sign-in gate
 *     V2AppLayout                            <- chrome only
 *       RequireFeature("automations")        <- the plan check
 *         RequirePageAccess                  <- the person's switches
 *
 * The plan check is the OUTER of the two, so a person on a plan without automations sees the upgrade page whatever
 * their switches, rather than being sent to the dashboard. The list opens on View automations plus Show Automations
 * page; the builder for an existing automation on View automations; a new automation on Create automations. Anyone
 * refused is sent to their dashboard. The backend decides every workflow request on the same View, Create and Edit
 * switches.
 *
 * `RequireFeature("automations")` resolves `minPlan: PRO` from the entitlement
 * catalog and redirects to /upgrade when the org lacks it.
 *
 * `relative="path"` on the /edit redirect is load-bearing for the same reason
 * it is in App.tsx: every parent route here is pathless (V2AppLayout, the
 * guards), so with the default relative="route" a single ".." strips the whole
 * "automations/:id/edit" leaf and resolves to "/" rather than to the builder for
 * that id. It is also declared LAST, after its `/v2/automations/:id` sibling,
 * exactly as App.tsx orders them.
 *
 * The CHROME is the only substitution: V2AppLayout stands in for the app's
 * AppLayout. Guards decide who may enter, the layout only decides what frames
 * the page, so swapping the second changes no permission.
 */
export function automationsV2Routes() {
  return (
    <Route element={<ProtectedRoute allowedRoles={['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN']} />}>
      <Route element={<V2AppLayout />}>
        <Route element={<RequireFeature feature="automations" />}>
          <Route element={<RequirePageAccess all={['view_automations']} />}>
            <Route path="/automations" element={<AutomationsHomePage />} />
          </Route>
          <Route element={<RequirePageAccess all={['create_automations']} />}>
            <Route path="/automations/new" element={<AutomationBuilderPage />} />
          </Route>
          <Route element={<RequirePageAccess all={['view_automations']} />}>
            <Route path="/automations/:id" element={<AutomationBuilderPage />} />
            <Route path="/automations/:id/edit" element={<Navigate to=".." relative="path" replace />} />
          </Route>
        </Route>
      </Route>
    </Route>
  );
}
