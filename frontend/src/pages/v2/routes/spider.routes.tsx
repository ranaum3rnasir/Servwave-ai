import { lazy } from 'react';
import { Route } from 'react-router-dom';
import ProtectedRoute from '@/components/ProtectedRoute';
import RequireSpider from '@/components/RequireSpider';
import V2AppLayout from '../V2AppLayout';

const SpiderPage = lazy(() => import('../spider/SpiderPage'));
const SpiderSummaryPage = lazy(() => import('../spider/SpiderSummaryPage'));

/**
 * Spider, the AI Center's lead watcher (#2619), behind the Spider gate. Its page is Admin-only; the
 * starting summary (#2794) opens for every role, each person reading only their own leads.
 */
export function spiderV2Routes() {
  return (
    <>
      <Route element={<ProtectedRoute allowedRoles={['ADMIN']} />}>
        <Route element={<V2AppLayout />}>
          <Route element={<RequireSpider />}>
            <Route path="/spider" element={<SpiderPage />} />
          </Route>
        </Route>
      </Route>
      <Route element={<ProtectedRoute />}>
        <Route element={<V2AppLayout />}>
          <Route element={<RequireSpider />}>
            <Route path="/spider/summary" element={<SpiderSummaryPage />} />
          </Route>
        </Route>
      </Route>
    </>
  );
}
