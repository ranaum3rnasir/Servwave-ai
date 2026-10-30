import { Navigate, Outlet } from 'react-router-dom';
import { routeAccess, switchOn, useMySwitchesStatus } from '@/lib/api/mySwitches';

interface Props {
  /** Switches that must ALL be on (a list page: its View and its Show; a page: its Access switch). */
  all?: string[];
  /** Switches of which AT LEAST ONE must be on (a page two switches open). */
  any?: string[];
}

/**
 * Route guard for the pages a person's switches take out of the menu: a list page follows its module's View and Show
 * switches, a page that is not a record type follows its Access switch. Anyone refused is sent to their dashboard,
 * which every person has. Show and Access are display only (the server never checks them), so they are read from the
 * person's own resolved switches rather than from a rule; the server still decides every record and every request.
 *
 * It draws nothing while the person's answer is on its way and refuses only on an answer that is fresh (see
 * `routeAccess`), so a person whose switch was turned on since their last visit is not bounced.
 */
export default function RequirePageAccess({ all = [], any }: Props) {
  const status = useMySwitchesStatus();
  const access = routeAccess(status, (values) =>
    all.every((key) => switchOn(values, key)) && (!any || any.some((key) => switchOn(values, key))));
  if (access === 'wait') return null;
  if (access === 'refuse') return <Navigate to="/" replace />;
  return <Outlet />;
}
