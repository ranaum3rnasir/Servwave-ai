import { Navigate, Outlet } from 'react-router-dom';
import { useAppAbility } from '@/contexts/AbilityContext';

/**
 * Route guard for Settings > Roles & Permissions. Opens only for a holder of Manage roles and permissions; anyone else
 * is sent to their dashboard, with no read-only view, so nobody can reach these screens to raise their own access.
 *
 * Gates on the one grant that switch stands for, never on a role name, so a custom role given the switch opens the
 * page and a built-in role without it does not. The page and its reads are never mounted for anyone refused here.
 */
export default function RequireManageRoles() {
  const ability = useAppAbility();
  if (!ability.can('manage_roles', 'Role')) {
    return <Navigate to="/" replace />;
  }
  return <Outlet />;
}
