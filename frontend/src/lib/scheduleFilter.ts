import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * The Schedule's named filters, kept in its address (Roles & Permissions, PRD 9, S09.12).
 *
 * The "No crew" filter is a view of the existing Schedule, not a page: `/schedule?filter=no_crew` shows the next 7
 * days and only the visits and walkthroughs nobody is on. It rides in the address so it can be bookmarked and
 * shared, and the dashboard's Missing crew tile and Needs Attention item link to it. The address only names the
 * filter; the server does the filtering (the board asks for `missing_crew=true`), and who may open the Schedule at all
 * is still the route's Access Schedule check. A name this page does not know is ignored.
 */
export const SCHEDULE_FILTER_PARAM = 'filter';
export const NO_CREW_FILTER = 'no_crew';

/** The Schedule's path with the "No crew" filter on, for a link to it. */
export const SCHEDULE_NO_CREW_PATH = `/schedule?${SCHEDULE_FILTER_PARAM}=${NO_CREW_FILTER}`;

/** Is the "No crew" filter on, and a setter that takes it out of the address (the rest of the address is kept). */
export function useScheduleNoCrewFilter() {
  const [params, setParams] = useSearchParams();
  const active = params.get(SCHEDULE_FILTER_PARAM) === NO_CREW_FILTER;
  const clear = useCallback(() => {
    setParams((current) => {
      const updated = new URLSearchParams(current);
      updated.delete(SCHEDULE_FILTER_PARAM);
      return updated;
    }, { replace: true });
  }, [setParams]);
  return { active, clear };
}
