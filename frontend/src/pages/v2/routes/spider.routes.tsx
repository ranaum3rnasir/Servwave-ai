import { lazy } from 'react';
import { Route, Navigate } from 'react-router-dom';

import ProtectedRoute from '@/components/ProtectedRoute';
import V2AppLayout from '../V2AppLayout';
import { useIsSpiderAllowed } from '@/lib/useIsSpiderAllowed';

const SpiderWatcherPage = lazy(() => import('../spider/SpiderWatcherPage'));

function SpiderRouteGuard() {
  const isAllowed = useIsSpiderAllowed();
  if (!isAllowed) {
    return <Navigate to="/" replace />;
  }
  return <SpiderWatcherPage />;
}

export function spiderV2Routes() {
  return (
    <Route element={<ProtectedRoute allowedRoles={['ADMIN']} />}>
      <Route element={<V2AppLayout />}>
        <Route path="/spider" element={<SpiderRouteGuard />} />
      </Route>
    </Route>
  );
}

