import { Outlet } from 'react-router-dom';
import { useAuthStore } from '@/stores/auth.store';

/**
 * Route guard for Settings > Users & Teams, Roles & Permissions and a person's Permissions page: user and role management is
 * Admin-only (AL-18). An Admin is the flag on the signed-in person, never a switch or a role name. For anyone else the address
 * renders nothing: no page, no redirect, and none of the page's reads are made. The server refuses every one of these routes
 * to a non-Admin; this only keeps the screen in step with it.
 */
export default function RequireAdmin() {
  const isAdmin = useAuthStore((s) => s.user?.is_admin === true);
  return isAdmin ? <Outlet /> : null;
}
