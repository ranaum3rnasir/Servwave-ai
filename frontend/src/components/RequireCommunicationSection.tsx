import { Navigate, Outlet } from 'react-router-dom';
import { useAppAbility } from '@/contexts/AbilityContext';

/**
 * Route guard for the org-wide Communication SECTION (`/communication/*` — the
 * sidebar group's own pages: the inbox, call log, WhatsApp and phone settings).
 * A different surface from the Communication TAB on a lead/job/customer record,
 * which is not behind this guard and keeps working on the shared-baseline
 * `read`/`create Communication` grants alone.
 *
 * Gates on a single CASL grant — never a hardcoded list of who may hold it —
 * so a future role inherits or loses access with zero code changes here.
 * Whoever fails the check is redirected to the app home, mounting neither the
 * shell nor the page and firing no request.
 */
export default function RequireCommunicationSection() {
  const ability = useAppAbility();
  if (!ability.can('access_inbox', 'Communication')) {
    return <Navigate to="/" replace />;
  }
  return <Outlet />;
}
