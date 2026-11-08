/// <reference types="@testing-library/jest-dom/vitest" />
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';

import { HISTORY_CAP, TRAIL_LENGTH, fallbackLabelFor, useNavHistory } from '../navHistory.store';
import { V2Breadcrumbs, useRecordVisit } from '../pageBreadcrumbs';

/**
 * The v2 breadcrumb is a visit trail, not a nav hierarchy, so what it renders
 * is a consequence of where the user has been. The rules that decide that live
 * in the store and are tested there directly; the component is tested for the
 * two things only it can get wrong - which crumb is a link, and what a trail of
 * one looks like.
 */

const visit = (path: string, label: string) => useNavHistory.getState().visit(path, label);
const paths = () => useNavHistory.getState().visits.map((entry) => entry.path);
const labels = () => useNavHistory.getState().visits.map((entry) => entry.label);

/**
 * The layout's arrangement, in miniature: a page that RECORDS itself, and the
 * trail rendered beside it rather than by it. Recording and rendering were one
 * component until the trail moved into `V2AppLayout`; keeping the test harness
 * shaped like the real thing is what makes it able to catch a page that records
 * nothing.
 */
function renderCrumbs(path: string, navKey: string, label?: string) {
  function Page() {
    useRecordVisit(navKey, label);
    return null;
  }
  return render(
    <MemoryRouter initialEntries={[path]}>
      <V2Breadcrumbs />
      <Page />
    </MemoryRouter>,
  );
}

/** Every crumb, in render order. */
const crumbs = () =>
  Array.from(document.querySelectorAll('[data-slot="breadcrumb-item"]')).map(
    (item) => item.textContent ?? '',
  );

beforeEach(() => {
  useNavHistory.getState().clear();
});

describe('the nav-history trail', () => {
  it('appends each new page, oldest first', () => {
    visit('/leads', 'Leads');
    visit('/jobs', 'Jobs');

    expect(paths()).toEqual(['/leads', '/jobs']);
  });

  it('renames the page you are already on rather than repeating it', () => {
    // A detail page arrives with no data, so its first label is the fallback
    // and the real one lands a tick later. That must not be a second crumb.
    visit('/leads/abc', 'Leads');
    visit('/leads/abc', 'L00042');

    expect(paths()).toEqual(['/leads/abc']);
    expect(labels()).toEqual(['L00042']);
  });

  it('is a no-op for a repeat of the same visit, so the effect cannot loop', () => {
    visit('/leads', 'Leads');
    const before = useNavHistory.getState().visits;

    visit('/leads', 'Leads');

    expect(useNavHistory.getState().visits).toBe(before);
  });

  it('truncates back to a page you return to, so A - B - A - B stays two', () => {
    visit('/a', 'A');
    visit('/b', 'B');
    visit('/a', 'A');

    expect(paths()).toEqual(['/a']);

    visit('/b', 'B');
    expect(paths()).toEqual(['/a', '/b']);
  });

  it('records nothing for the routes that are not part of a journey', () => {
    for (const excluded of ['/login', '/auth/callback', '/accept-invite', '/p/estimate/tok']) {
      visit(excluded, 'Nope');
    }

    expect(paths()).toEqual([]);
  });

  it('keeps more history than it renders, so stepping back re-reveals context', () => {
    expect(HISTORY_CAP).toBeGreaterThan(TRAIL_LENGTH);

    for (let i = 0; i < HISTORY_CAP + 3; i += 1) visit(`/p${i}`, `P${i}`);

    expect(paths()).toHaveLength(HISTORY_CAP);
    expect(paths()[0]).toBe(`/p${3}`);
  });
});

describe('the rendered trail', () => {
  it('renders nothing on the first page of a session', () => {
    const { container } = renderCrumbs('/leads', 'leads');

    expect(container).toBeEmptyDOMElement();
    expect(paths()).toEqual(['/leads']);
  });

  it('links every crumb but the last, which is the current page', () => {
    visit('/leads', 'Leads');
    renderCrumbs('/jobs', 'jobs');

    const back = screen.getByRole('link', { name: 'Leads' });
    expect(back).toHaveAttribute('href', '/leads');

    const here = screen.getByText('Jobs');
    expect(here.closest('[data-slot="breadcrumb-page"]')).not.toBeNull();
    // Not merely un-anchored by accident: there is no anchor to here at all.
    // (The kit's current-page crumb keeps role="link" with aria-disabled, so
    // this has to be asked of the DOM rather than of the role.)
    expect(here.closest('a')).toBeNull();
    expect(document.querySelector('a[href="/jobs"]')).toBeNull();
  });

  it('registers this page under the label it was given, not the registry one', () => {
    visit('/leads', 'Leads');
    renderCrumbs('/inventory/staging', 'inventory', 'Staging');

    expect(crumbs()).toEqual(['Leads', 'Staging']);
    expect(labels()).toEqual(['Leads', 'Staging']);
  });

  it('falls back to the destination label when the page gives none', () => {
    visit('/leads', 'Leads');
    renderCrumbs('/customers', 'clients');

    expect(crumbs()).toEqual(['Leads', 'Customers']);
  });

  it('shows only the last four pages', () => {
    for (const [path, label] of [
      ['/a', 'A'], ['/b', 'B'], ['/c', 'C'], ['/d', 'D'],
    ] as const) {
      visit(path, label);
    }

    renderCrumbs('/jobs', 'jobs');

    expect(crumbs()).toEqual(['B', 'C', 'D', 'Jobs']);
  });
});

/**
 * The trail outlives the tab, and belongs to ONE user.
 *
 * Both halves matter. A trail that lives only in memory is wiped by every
 * reload, which is exactly what "the crumbs start from scratch" was. And a
 * trail that outlives a reload but not the SIGNED-IN USER would hand the next
 * person at a shared front-desk machine a record of where the last one had
 * been.
 */
describe('persistence', () => {
  const trailFor = (userId: string) =>
    window.localStorage.getItem(`servwave_v2_nav_trail:${userId}`);

  beforeEach(() => {
    window.localStorage.clear();
    useNavHistory.getState().hydrate(null);
  });

  it('writes the trail under the hydrated user, and reads it back', () => {
    useNavHistory.getState().hydrate('user-1');
    visit('/leads', 'Leads');
    visit('/jobs', 'Jobs');

    // A reload: same key, fresh in-memory store.
    useNavHistory.setState({ visits: [] });
    useNavHistory.getState().hydrate('user-1');

    expect(paths()).toEqual(['/leads', '/jobs']);
    expect(labels()).toEqual(['Leads', 'Jobs']);
  });

  it('keeps each user to their own trail', () => {
    useNavHistory.getState().hydrate('user-1');
    visit('/leads', 'Leads');

    useNavHistory.getState().hydrate('user-2');
    expect(paths()).toEqual([]);

    visit('/invoices', 'Invoices');
    expect(trailFor('user-1')).toContain('/leads');
    expect(trailFor('user-2')).not.toContain('/leads');
  });

  it('stays in memory when there is no user to key on', () => {
    visit('/leads', 'Leads');

    expect(paths()).toEqual(['/leads']);
    expect(window.localStorage.length).toBe(0);
  });

  it('survives a stored value that is corrupt or the wrong shape', () => {
    window.localStorage.setItem('servwave_v2_nav_trail:user-1', '{not json');
    useNavHistory.getState().hydrate('user-1');
    expect(paths()).toEqual([]);

    window.localStorage.setItem('servwave_v2_nav_trail:user-1', '[{"path":1}]');
    useNavHistory.getState().hydrate('user-1');
    expect(paths()).toEqual([]);
  });
});

/**
 * The safety net. A page that records nothing used to be a hole in everyone
 * else's trail, and "remember to add a crumb" held for fifteen pages out of
 * forty. The layout records a path-derived name for anything unclaimed.
 */
describe('the layout fallback', () => {
  it('names a page after its module when the page named itself nothing', () => {
    useNavHistory.getState().visitFallback('/schedule', fallbackLabelFor('/schedule'));

    expect(labels()).toEqual(['Schedule']);
  });

  it('leaves a page that DID name itself alone', () => {
    visit('/leads/abc', 'L00042');
    useNavHistory.getState().visitFallback('/leads/abc', fallbackLabelFor('/leads/abc'));

    expect(labels()).toEqual(['L00042']);
  });

  it('title-cases a path with no registry entry', () => {
    expect(fallbackLabelFor('/service-plans')).toBe('Service Plans');
  });

  it('never records a public or auth route', () => {
    useNavHistory.getState().visitFallback('/login', 'Login');
    useNavHistory.getState().visitFallback('/p/abc', 'Public');

    expect(paths()).toEqual([]);
  });
});

/**
 * Inventory is one page with deep-linkable tabs, so a tab click changes the
 * pathname the trail keys on. Looking around a page is not a journey across
 * pages, and it should leave the trail exactly as it found it.
 */
describe('tabs of one page', () => {
  it('does not add a crumb for each inventory tab', () => {
    visit('/jobs', 'Jobs');
    visit('/inventory', 'Inventory');

    for (const tab of ['/inventory/staging', '/inventory/assets', '/inventory/low-stock',
      '/inventory/activity', '/inventory/logistic-orders']) {
      visit(tab, 'Inventory');
    }

    expect(paths()).toEqual(['/jobs', '/inventory']);
  });

  it('does not let the layout fallback re-add a tab the page collapsed', () => {
    visit('/inventory', 'Inventory');
    useNavHistory.getState().visitFallback('/inventory/assets', fallbackLabelFor('/inventory/assets'));

    expect(paths()).toEqual(['/inventory']);
  });

  it('keeps the sibling inventory PAGES as crumbs of their own', () => {
    visit('/inventory', 'Inventory');
    visit('/inventory/vendors', 'Vendors');
    visit('/inventory/price-book', 'Price Book');

    expect(paths()).toEqual(['/inventory', '/inventory/vendors', '/inventory/price-book']);
  });
});
