import { Navigate, Outlet } from 'react-router-dom';
import { useAuthStore } from '@/stores/auth.store';
import NotAuthorizedPage from '@/components/NotAuthorizedPage';

interface ProtectedRouteProps {
  allowedRoles?: Array<'ADMIN' | 'SALES' | 'DISPATCHER' | 'TECHNICIAN'>;
  // When true, a role-check failure renders NotAuthorizedPage instead of bouncing to "/" — for
  // an in-app deep-link (e.g. a sidebar-hidden, API-403'd route) so the user sees why, rather
  // than being silently redirected. The unauthenticated case always still bounces to /login.
  fallback?: boolean;
}

export default function ProtectedRoute({ allowedRoles, fallback }: ProtectedRouteProps) {
  const { isAuthenticated, isLoading, user } = useAuthStore();

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-text-secondary">Loading...</div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  if (allowedRoles && user && !allowedRoles.includes(user.role)) {
    return fallback ? <NotAuthorizedPage /> : <Navigate to="/" replace />;
  }

  return <Outlet />;
}
