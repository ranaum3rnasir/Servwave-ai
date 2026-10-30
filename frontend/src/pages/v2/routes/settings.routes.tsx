import { lazy } from 'react';
import { Navigate, Route } from 'react-router-dom';

import ProtectedRoute from '@/components/ProtectedRoute';
import RequireAdmin from '@/components/RequireAdmin';

import { useAuthStore } from '@/stores/auth.store';

import V2AppLayout from '../V2AppLayout';

const SettingsLayout = lazy(() => import('../settings/SettingsLayout'));
const CompanyProfilePage = lazy(() => import('../settings/CompanyProfilePage'));
const BrandingPage = lazy(() => import('../settings/BrandingPage'));
const LocationsPage = lazy(() => import('../settings/LocationsPage'));
const UsersTeamsPage = lazy(() => import('../settings/UsersTeamsPage'));
const RolesPage = lazy(() => import('../settings/RolesPage'));
const PersonPermissionsPage = lazy(() => import('../settings/PersonPermissionsPage'));
const SecurityPage = lazy(() => import('../settings/SecurityPage'));
const ServwavePaymentsRoute = lazy(() => import('../settings/ServwavePaymentsRoute'));
const LegacyPaymentsRedirect = lazy(() =>
  import('../settings/LegacySettingsRedirects').then((m) => ({ default: m.LegacyPaymentsRedirect })),
);
const LegacyPayoutAccountRedirect = lazy(() =>
  import('../settings/LegacySettingsRedirects').then((m) => ({ default: m.LegacyPayoutAccountRedirect })),
);
const ListsPage = lazy(() => import('../settings/ListsPage'));
const JobSubStatusesPage = lazy(() => import('../settings/JobSubStatusesPage'));
const DeclineReasonsPage = lazy(() => import('../settings/DeclineReasonsPage'));
const JobCancelReasonsPage = lazy(() => import('../settings/JobCancelReasonsPage'));
const PhoneSmsPage = lazy(() => import('../settings/PhoneSmsPage'));
const PhoneNumbersSettingsPage = lazy(() => import('../settings/PhoneNumbersSettingsPage'));
const InventorySettingsPage = lazy(() => import('../settings/InventorySettingsPage'));
const ScheduleColorsPage = lazy(() => import('../settings/ScheduleColorsPage'));
const MyProfilePage = lazy(() => import('../settings/MyProfilePage'));

/**
 * The settings tabs that were never rebuilt on the kit, mounted from their
 * ORIGINAL modules - the only place in the route table that still does this.
 *
 * They cannot stay in App.tsx. This file now owns `path="/settings"`, and a
 * second `path="/settings"` parent there holding only these would make the
 * bare `/settings` URL resolve on React Router's ranking between two branches
 * instead of on a declaration. The pages themselves are untouched: they render
 * inside this shell's `<Outlet/>` exactly as they rendered inside the original
 * one, and `settings/SettingsLayout.tsx` carries a nav row for each so they are
 * reachable by clicking and not only by typing.
 *
 * Each will be deleted here the moment a kit rebuild lands beside its sibling.
 */
const TaxRatesPage = lazy(() => import('@/pages/settings/TaxRatesPage'));
const EmailSenderPage = lazy(() => import('@/pages/settings/EmailSenderPage'));
// CustomFieldsPage is deliberately NOT mounted - see the nav list in
// `settings/SettingsLayout.tsx` for why. Held out of the 2026-08-17 release.

/**
 * Module 11 - Settings & Users.
 *
 * The GUARD stack mirrors App.tsx exactly, and the asymmetry between the two
 * blocks below is the whole point:
 *
 *   /users              ProtectedRoute(all four roles) - the app-wide gate that
 *                       wraps App.tsx's whole authenticated tree - then a bare
 *                       redirect to /settings/users. The admin-only "Users" stub
 *                       page is gone (PRD 2, S02.5); /settings/users decides
 *                       (Admins only, AL-18).
 *   /settings/*         NO route-level ROLE guard on the pages that have a
 *                       door of their own: My Profile, Login & Security (every
 *                       person's own password and email code), Locations (its own
 *                       switch) and ServWave Payments (the payout switch). The
 *                       rest is the Admin flag's alone (AL-18, ticket 36, 36b):
 *                       Users & Teams, Roles & Permissions, a person's
 *                       Permissions, the company's details, branding, lists, statuses, reasons, tax rates, phone,
 *                       sender address, inventory and schedule colours all sit
 *                       under one RequireAdmin, so for anyone who is not an
 *                       Admin those addresses render nothing and none of the
 *                       page's reads are made. The nav LIST in SettingsLayout
 *                       shows an Admin-only row to Admins alone. The server
 *                       refuses every one of their writes the same way.
 *
 * There is no RequireFeature on any settings route in App.tsx either, including
 * the two comm-gated tabs: the `phone` entitlement gates their NAV ENTRY and
 * each of those two PAGES gates itself (`if (!gated) return null`). That split
 * is reproduced rather than tightened into a route guard.
 *
 * Child paths are written ABSOLUTE (`/settings/company`, not `company`)
 * because `uiV2.test.ts` collects `path="/…"` literals to prove every
 * registered path has a route; a relative child would register as unmatched.
 *
 * `/settings/organization` has no block here: the page was deleted and App.tsx
 * no longer routes it.
 *
 * The CHROME is the only substitution: V2AppLayout stands in for the app's
 * AppLayout. Guards decide who may enter, the layout only decides what frames
 * the page, so swapping the second changes no permission.
 */
/** The bare /settings: an Admin opens the company's details, anyone else the one page every signed-in person has. */
function SettingsHome() {
  const isAdmin = useAuthStore((s) => s.user?.is_admin === true);
  return <Navigate to={isAdmin ? '/settings/company' : '/settings/profile'} replace />;
}

export function settingsV2Routes() {
  return (
    <>
      <Route element={<ProtectedRoute allowedRoles={['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN']} />}>
        {/* The old admin-only "Users" stub is gone. Its address goes to Users & Teams, which sends anyone who
            cannot see that page to their dashboard. */}
        <Route path="/users" element={<Navigate to="/settings/users" replace />} />
      </Route>

      {/* The two retired Settings addresses (Payments & Lists, Payout account & verification). Saved bell rows, emails and
          the hosted-setup return still carry them, so they stay routed and land on ServWave Payments with the query
          string (or the #payout-account hash) kept. They sit outside the Settings shell: a redirect has no reason to draw
          it or arm its unsaved-changes guard. */}
      <Route element={<ProtectedRoute allowedRoles={['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN']} />}>
        <Route path="/settings/payments" element={<LegacyPaymentsRedirect />} />
        <Route path="/settings/payout-account" element={<LegacyPayoutAccountRedirect />} />
      </Route>

      {/* Organization Settings module - CASL-filtered per menu item (not ADMIN-gated) */}
      <Route element={<ProtectedRoute allowedRoles={['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN']} />}>
        <Route element={<V2AppLayout />}>
          <Route path="/settings" element={<SettingsLayout />}>
            <Route index element={<SettingsHome />} />
            {/* Setting up the company, and managing its people and roles, are the Admin flag's alone (AL-18, ticket 36, 36b): for anyone
                else every one of these addresses renders nothing, and none of the page's reads are made. */}
            <Route element={<RequireAdmin />}>
              <Route path="/settings/company" element={<CompanyProfilePage />} />
              <Route path="/settings/branding" element={<BrandingPage />} />
              <Route path="/settings/users" element={<UsersTeamsPage />} />
              <Route path="/settings/roles" element={<RolesPage />} />
              {/* A person's own switches: opened from the Permissions action on their Users & Teams row. */}
              <Route path="/settings/users/:userId/permissions" element={<PersonPermissionsPage />} />
              <Route path="/settings/lists" element={<ListsPage />} />
              <Route path="/settings/job-sub-statuses" element={<JobSubStatusesPage />} />
              <Route path="/settings/decline-reasons" element={<DeclineReasonsPage />} />
              <Route path="/settings/job-cancel-reasons" element={<JobCancelReasonsPage />} />
              <Route path="/settings/phone-sms" element={<PhoneSmsPage />} />
              <Route path="/settings/phone-numbers" element={<PhoneNumbersSettingsPage />} />
              <Route path="/settings/inventory" element={<InventorySettingsPage />} />
              <Route path="/settings/schedule-colors" element={<ScheduleColorsPage />} />
              <Route path="/settings/tax-rates" element={<TaxRatesPage />} />
              <Route path="/settings/email-sender" element={<EmailSenderPage />} />
            </Route>
            <Route path="/settings/locations" element={<LocationsPage />} />
            {/* Login & Security is every person's own sign-in (their password and email code); the company's two-step policy on it is
                drawn for an Admin alone, and the server refuses its write to anyone else. */}
            <Route path="/settings/security" element={<SecurityPage />} />
            {/* ServWave Payments: an old ?tab= link still goes to the Payments page, anything else is the settings page. It is the
                one setup page with a second door: the payout switch also opens it, and the page checks both itself. */}
            <Route path="/settings/servwave-payments" element={<ServwavePaymentsRoute />} />
            <Route path="/settings/profile" element={<MyProfilePage />} />
            {/* Lead statuses are fixed, so the Lead Statuses tab is gone. An old bookmark
                lands on the settings home rather than falling through to the catch-all. */}
            <Route path="/settings/lead-statuses" element={<Navigate to="/settings" replace />} />
          </Route>
        </Route>
      </Route>
    </>
  );
}
