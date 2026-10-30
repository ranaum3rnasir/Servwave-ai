import { lazy } from 'react';
import { Navigate, Route } from 'react-router-dom';

import ProtectedRoute from '@/components/ProtectedRoute';
import RequireManageRoles from '@/components/RequireManageRoles';
import RequireUsersTeamsPage from '@/components/RequireUsersTeamsPage';

import V2AppLayout from '../V2AppLayout';

const SettingsLayout = lazy(() => import('../settings/SettingsLayout'));
const CompanyProfilePage = lazy(() => import('../settings/CompanyProfilePage'));
const BrandingPage = lazy(() => import('../settings/BrandingPage'));
const LocationsPage = lazy(() => import('../settings/LocationsPage'));
const UsersTeamsPage = lazy(() => import('../settings/UsersTeamsPage'));
const RolesPage = lazy(() => import('../settings/RolesPage'));
const PersonPermissionsPage = lazy(() => import('../settings/PersonPermissionsPage'));
const SecurityPage = lazy(() => import('../settings/SecurityPage'));
const ServwavePaymentsRedirect = lazy(() => import('../settings/ServwavePaymentsRedirect'));
const PaymentsListsRoute = lazy(() => import('../settings/PaymentsListsRoute'));
const PayoutAccountPage = lazy(() => import('../settings/PayoutAccountPage'));
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
 *                       page is gone (PRD 2, S02.5); /settings/users decides,
 *                       on Show Users & Teams page, who stays and who goes home.
 *   /settings/*         NO route-level ROLE guard. Every authenticated
 *                       user of any role can deep-link to any settings tab,
 *                       EXCEPT the two that follow a switch (PRD 2, S02.5):
 *                       /settings/users (Show Users & Teams page) and
 *                       /settings/roles (Manage roles and permissions) send
 *                       anyone without theirs to the dashboard. Every other
 *                       tab is open as described next. The
 *                       nav LIST is CASL-filtered inside SettingsLayout, but the
 *                       routes are open, so a technician who types
 *                       /settings/inventory mounts the page with no redirect and
 *                       no toast. Adding a guard here would change who can reach a
 *                       page - a behaviour change, not a restyle.
 *
 *                       WHAT THAT USER THEN SEES IS PER-PAGE, and "the API 403s
 *                       the read, so the page comes up empty" is NOT a rule to
 *                       rely on. It holds only where a page's READ is gated as
 *                       tightly as its writes. /settings/decline-reasons is the
 *                       counter-example that proves it: its GET is the coarser
 *                       `read Estimate` on purpose (slice C needs a rep to read
 *                       these words while declining their own estimate), so a
 *                       SALES user reached a FULLY POPULATED list - rename
 *                       fields, toggles, drag handles, an Add button - every
 *                       control of which 403s. Not an empty list; a working-
 *                       looking one. A page whose read and write gates differ
 *                       has to gate ITSELF, and that one now does: `update
 *                       Organization`, the same pair as its writes, rendering
 *                       NotAuthorizedPage.
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
export function settingsV2Routes() {
  return (
    <>
      <Route element={<ProtectedRoute allowedRoles={['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN']} />}>
        {/* The old admin-only "Users" stub is gone. Its address goes to Users & Teams, which sends anyone who
            cannot see that page to their dashboard. */}
        <Route path="/users" element={<Navigate to="/settings/users" replace />} />
      </Route>

      {/* The old Settings > ServWave Payments address (payments go-live P8): the area moved to the Payments page, and
          this stays as a redirect so email links and bell notifications from before the move still land. It sits
          outside the Settings shell, which a redirect has no reason to draw. */}
      <Route element={<ProtectedRoute allowedRoles={['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN']} />}>
        <Route path="/settings/servwave-payments" element={<ServwavePaymentsRedirect />} />
      </Route>

      {/* Organization Settings module - CASL-filtered per menu item (not ADMIN-gated) */}
      <Route element={<ProtectedRoute allowedRoles={['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN']} />}>
        <Route element={<V2AppLayout />}>
          <Route path="/settings" element={<SettingsLayout />}>
            <Route index element={<Navigate to="/settings/company" replace />} />
            <Route path="/settings/company" element={<CompanyProfilePage />} />
            <Route path="/settings/branding" element={<BrandingPage />} />
            <Route path="/settings/locations" element={<LocationsPage />} />
            {/* Users & Teams follows Show Users & Teams page; Roles & Permissions follows Manage roles and
                permissions. Anyone else lands on their dashboard (PRD 2, S02.5). */}
            <Route element={<RequireUsersTeamsPage />}>
              <Route path="/settings/users" element={<UsersTeamsPage />} />
            </Route>
            <Route element={<RequireManageRoles />}>
              <Route path="/settings/roles" element={<RolesPage />} />
              {/* A person's own switches: opened from the Permissions action on their Users & Teams row. */}
              <Route path="/settings/users/:userId/permissions" element={<PersonPermissionsPage />} />
            </Route>
            <Route path="/settings/security" element={<SecurityPage />} />
            <Route path="/settings/payments" element={<PaymentsListsRoute />} />
            <Route path="/settings/payout-account" element={<PayoutAccountPage />} />
            <Route path="/settings/job-sub-statuses" element={<JobSubStatusesPage />} />
            <Route path="/settings/decline-reasons" element={<DeclineReasonsPage />} />
            <Route path="/settings/job-cancel-reasons" element={<JobCancelReasonsPage />} />
            <Route path="/settings/phone-sms" element={<PhoneSmsPage />} />
            <Route path="/settings/phone-numbers" element={<PhoneNumbersSettingsPage />} />
            <Route path="/settings/inventory" element={<InventorySettingsPage />} />
            <Route path="/settings/schedule-colors" element={<ScheduleColorsPage />} />
            <Route path="/settings/profile" element={<MyProfilePage />} />
            {/* Lead statuses are fixed, so the Lead Statuses tab is gone. An old bookmark
                lands on the settings home rather than falling through to the catch-all. */}
            <Route path="/settings/lead-statuses" element={<Navigate to="/settings" replace />} />
            {/* The two not-yet-rebuilt tabs - see the comment on their imports.
                Same guard stack and same URLs as every sibling above; only the
                page component comes from the original module. */}
            <Route path="/settings/tax-rates" element={<TaxRatesPage />} />
            <Route path="/settings/email-sender" element={<EmailSenderPage />} />
          </Route>
        </Route>
      </Route>
    </>
  );
}
