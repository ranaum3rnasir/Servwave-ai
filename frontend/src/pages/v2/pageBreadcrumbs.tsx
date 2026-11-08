import { Fragment, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';

import {
  Breadcrumbs, BreadcrumbItem, BreadcrumbLink, BreadcrumbList,
  BreadcrumbPage, BreadcrumbSeparator,
} from '@/ui-kit/components/layout/nav/breadcrumbs';
import { getDestination } from '@/components/layout/nav-registry';

import { trailOf, useNavHistory } from './navHistory.store';

/**
 * Name THIS page for the trail, without drawing anything.
 *
 * Recording and rendering are separate, and only recording is a page's job.
 * The trail itself is drawn once, by `V2AppLayout`, above whatever the route
 * renders - see `V2Breadcrumbs` below for why.
 *
 * A page calls this when it can say something better about itself than its URL
 * can: a detail page knows its record's name, a form knows whether it is a
 * create or an edit. Pages that have nothing to add do not need to call it at
 * all - the layout's fallback names them from the nav registry.
 */
export function useRecordVisit(navKey: string, label?: string): void {
  const { pathname } = useLocation();
  const dest = getDestination(navKey);
  const current = label ?? dest?.label ?? navKey;
  const visit = useNavHistory((state) => state.visit);

  // In an effect, not in render, because recording is a write to shared state.
  // `label` arriving late (a detail page waiting on its data) simply re-runs
  // this and renames the crumb in place - the store returns the same state for
  // a repeat of the same visit, so no re-render feeds back into the effect.
  useEffect(() => {
    visit(pathname, current);
  }, [visit, pathname, current]);
}

/**
 * The trail: the last few pages the user visited, oldest to newest, ending on
 * this one.
 *
 * MOUNTED ONCE, BY THE LAYOUT, and never by a page. It used to be a prop each
 * page passed to its own `PageHeader`, and that arrangement could not hold:
 *
 *   - about a third of the routes never passed it, so walking through one made
 *     the trail appear to reset. Every detail page was in that group - the
 *     exact pages a trail exists for, since `/v2/jobs/J00042` is the one
 *     destination the sidebar cannot get you back to.
 *   - the pages that DID pass it disagreed about where it went. Several render
 *     their header inside a Card, so the crumb ended up inside the card with
 *     it, indented and boxed, reading as part of the record rather than as
 *     page chrome.
 *   - it was invisible on any page whose header was conditional on loaded data,
 *     which is most detail pages, so it appeared and disappeared as you moved.
 *
 * Drawing it here fixes all three at once and cannot regress: a route added
 * next month is covered without anyone remembering a rule.
 *
 * Only the last crumb is the current page, so only it is not a link. A trail of
 * one is just the page title again, so it renders nothing.
 */
export function V2Breadcrumbs() {
  const visits = useNavHistory((state) => state.visits);
  const trail = trailOf(visits);
  if (trail.length < 2) return null;

  return (
    <Breadcrumbs className="mb-4">
      <BreadcrumbList>
        {trail.map((entry, index) => (
          <Fragment key={entry.path}>
            {index > 0 && <BreadcrumbSeparator />}
            <BreadcrumbItem>
              {index === trail.length - 1 ? (
                <BreadcrumbPage>{entry.label}</BreadcrumbPage>
              ) : (
                <BreadcrumbLink asChild>
                  <Link to={entry.path}>{entry.label}</Link>
                </BreadcrumbLink>
              )}
            </BreadcrumbItem>
          </Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumbs>
  );
}
