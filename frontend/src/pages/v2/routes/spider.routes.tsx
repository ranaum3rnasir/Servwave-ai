import { lazy } from 'react';
import { Route } from 'react-router-dom';
import ProtectedRoute from '@/components/ProtectedRoute';
import RequireSpider from '@/components/RequireSpider';
import V2AppLayout from '../V2AppLayout';

const SpiderPage = lazy(() => import('../spider/SpiderPage'));

/** Spider, the AI Center's lead watcher (#2619): Admin-only, behind the Spider gate. */
export function spiderV2Routes() {
  return (
    <Route element={<ProtectedRoute allowedRoles={['ADMIN']} />}>
      <Route element={<V2AppLayout />}>
        <Route element={<RequireSpider />}>
          <Route path="/spider" element={<SpiderPage />} />
        </Route>
      </Route>
    </Route>
  );
}
