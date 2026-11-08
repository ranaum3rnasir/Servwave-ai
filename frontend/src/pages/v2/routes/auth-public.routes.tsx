import { lazy } from 'react';
import { Route } from 'react-router-dom';

import ProtectedRoute from '@/components/ProtectedRoute';

import V2AppLayout from '../V2AppLayout';

const LoginPage = lazy(() => import('../auth-public/LoginPage'));
const AuthCallbackPage = lazy(() => import('../auth-public/AuthCallbackPage'));
const AcceptInvitePage = lazy(() => import('../auth-public/AcceptInvitePage'));
const PublicEstimatePage = lazy(() => import('../auth-public/PublicEstimatePage'));
const PublicInvoicePage = lazy(() => import('../auth-public/PublicInvoicePage'));
const UpgradePage = lazy(() => import('../auth-public/UpgradePage'));
const NotAuthorizedPage = lazy(() => import('../auth-public/NotAuthorizedPage'));

/**
 * Module 13 - Auth & Public.
 *
 * THE GUARD STACK MIRRORS App.tsx EXACTLY, and for this module that mostly
 * means the ABSENCE of guards and the absence of a layout:
 *
 *  - `/login`, `/auth/callback`, `/accept-invite`, `/p/estimates/:id` and
 *    `/p/invoices/:id` sit at the TOP of App.tsx's route table, outside
 *    `ProtectedRoute` and outside `AppLayout`. They are reproduced the same
 *    way: no guard, and NOT nested under `V2AppLayout`. Two of them are the
 *    only pages in this product a customer ever sees, and a sidebar appearing
 *    on a public estimate would leak the shape of the app to a homeowner.
 *  - `/upgrade` carries a BARE `ProtectedRoute` with no `allowedRoles`, inside
 *    the app shell. That is deliberate in App.tsx and copied here: the 402
 *    interceptor is global, so a TECHNICIAN who trips one must be able to land
 *    on this page rather than be bounced by a role list.
 *
 * `/v2/auth/callback` is declared here but NOT registered in
 * `auth-public.paths.ts`, so the flag never redirects the real OAuth return to
 * it. The reason is `lib/auth-listener.ts`'s exact-pathname skip - the long
 * version is in the paths file. The route exists so the page is reviewable and
 * ready for cutover.
 *
 * `/v2/not-authorized` is likewise declared and not registered, because the
 * legacy surface has NO route: `ProtectedRoute` renders it in place of
 * `<Outlet/>`. That import now points at `components/NotAuthorizedPage` rather
 * than at a legacy page, but it is still the legacy-styled surface a failed
 * v2 role check renders - switching the guard to this component is a cutover
 * decision, not a re-homing one. The route is placed inside ProtectedRoute and
 * V2AppLayout because that is where the other surface renders today.
 */
export function authPublicV2Routes() {
  return (
    <>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/auth/callback" element={<AuthCallbackPage />} />
      <Route path="/accept-invite" element={<AcceptInvitePage />} />
      <Route path="/p/estimates/:id" element={<PublicEstimatePage />} />
      <Route path="/p/invoices/:id" element={<PublicInvoicePage />} />

      <Route element={<ProtectedRoute />}>
        <Route element={<V2AppLayout />}>
          <Route path="/upgrade" element={<UpgradePage />} />
          <Route path="/not-authorized" element={<NotAuthorizedPage />} />
        </Route>
      </Route>
    </>
  );
}
