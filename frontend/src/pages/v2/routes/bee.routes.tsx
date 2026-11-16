import { lazy } from 'react';
import { Route, Navigate } from 'react-router-dom';

import ProtectedRoute from '@/components/ProtectedRoute';
import V2AppLayout from '../V2AppLayout';
import { useIsBeeAllowed } from '@/lib/useIsBeeAllowed';

const BeeAgentView = lazy(() => import('../bee/BeeAgentView'));

function BeeRouteGuard() {
  const isAllowed = useIsBeeAllowed();
  if (!isAllowed) {
    return <Navigate to="/" replace />;
  }
  return <BeeAgentView />;
}

export function beeV2Routes() {
  return (
    <Route element={<ProtectedRoute allowedRoles={['ADMIN']} />}>
      <Route element={<V2AppLayout />}>
        <Route path="/bee" element={<BeeRouteGuard />} />
      </Route>
    </Route>
  );
}

