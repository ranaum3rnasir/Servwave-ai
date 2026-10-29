import { Suspense, useEffect } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';

import { ErrorBoundary } from '@/components/ErrorBoundary';
import { replaceLocation } from '@/lib/platform/replaceLocation';
// Imported statically on purpose. A customer opening either link needs its page before anything
// can paint, so a lazy chunk here would only add a second request in front of the first paint
// and hide the page's weight from the budget check, which counts what the HTML loads up front.
import PublicEstimatePage from '@/pages/v2/auth-public/PublicEstimatePage';
import PublicInvoicePage from '@/pages/v2/auth-public/PublicInvoicePage';

/**
 * The app that answers a customer's link: `/p/estimates/:id` and `/p/invoices/:id`.
 *
 * It exists separately from `App.tsx` so that a homeowner opening an estimate on a phone
 * downloads this and nothing else. `App.tsx` builds the staff route table with an eager glob of
 * every module's routes, which statically imports the staff layout and, through it, most of the
 * product. Mounted from `public-main.tsx`, which `public.html` loads; Vercel serves that page for
 * `/p/*` (see `vercel.json`). Mobile slice 47.
 *
 * WHAT IS DELIBERATELY ABSENT, and why each would be a mistake to add back:
 *  - the auth store, the signed-in axios client and the auth listener. The page has no session;
 *    the `?token=` in the link is the only credential, and the pages speak to the API with bare
 *    `fetch`. Importing the auth machinery would drag the identity SDK into the customer's page.
 *  - the permission provider, the query client, the toaster and the tooltip provider. Nothing on
 *    these two pages reads them. `publicEntryGraph.test.tsx` and the build's public-bundle check
 *    (`scripts/check-public-bundle-budget.mjs`) fail if the entry's imports or its 200 KB budget
 *    are broken.
 *  - a service worker. The staff entry registers it; this one never does.
 *
 * The two public paths are also declared in `pages/v2/routes/auth-public.routes.tsx` for the
 * staff app, so a link followed from inside the staff app still resolves.
 * `publicEntryGraph.test.tsx` keeps the two declarations identical.
 */

function PageLoader() {
  return (
    <div className="flex items-center justify-center py-12">
      <div className="text-text-secondary">Loading...</div>
    </div>
  );
}

/**
 * Any other `/p/...` URL is not a page this app has. The staff app owns every other path, so
 * hand the visit to it with a full load (a client-side `<Navigate>` would stay inside this
 * entry, which has no staff routes to render).
 */
function LeaveForStaffApp() {
  useEffect(() => {
    replaceLocation('/');
  }, []);
  return <PageLoader />;
}

export function PublicRoutes() {
  return (
    <Suspense fallback={<PageLoader />}>
      <Routes>
        <Route path="/p/estimates/:id" element={<PublicEstimatePage />} />
        <Route path="/p/invoices/:id" element={<PublicInvoicePage />} />
        <Route path="*" element={<LeaveForStaffApp />} />
      </Routes>
    </Suspense>
  );
}

export default function PublicApp() {
  return (
    <BrowserRouter>
      <ErrorBoundary>
        <PublicRoutes />
      </ErrorBoundary>
    </BrowserRouter>
  );
}
