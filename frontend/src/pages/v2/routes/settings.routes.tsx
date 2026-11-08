import { lazy } from 'react';
import { Navigate, Route } from 'react-router-dom';

import ProtectedRoute from '@/components/ProtectedRoute';

import V2AppLayout from '../V2AppLayout';

const SettingsLayout = lazy(() => import('../settings/SettingsLayout'));
const UsersPage = lazy(() => import('../settings/UsersPage'));
const CompanyProfilePage = lazy(() => import('../settings/CompanyProfilePage'));
const BrandingPage = lazy(() => import('../settings/BrandingPage'));
const LocationsPage = lazy(() => import('../settings/LocationsPage'));
const UsersTeamsPage = lazy(() => import('../settings/UsersTeamsPage'));
const RolesPage = lazy(() => import('../settings/RolesPage'));
const SecurityPage = lazy(() => import('../settings/SecurityPage'));
const PaymentsListsPage = lazy(() => import('../settings/PaymentsListsPage'));
const JobSubStatusesPage = lazy(() => import('../settings/JobSubStatusesPage'));
const DeclineReasonsPage = lazy(() => import('../settings/DeclineReasonsPage'));
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
 *                       wraps App.tsx's whole authenticated tree - then a nested
 *                       ProtectedRoute(['ADMIN'], fallback): a non-admin who
 *                       types it gets NotAuthorizedPage, not a redirect. The
 *                       outer wrapper was missing here for a while. It rejects
 *                       nobody on its own (its list is every role there is), but
 *                       leaving it out made this stack differ from its legacy
 *                       twin for no reason, and the rule is that the two match.
 *   /settings/*         NO route-level role guard AT ALL. Every authenticated
 *                       user of any role can deep-link to any settings tab. The
 *                       nav LIST is CASL-filtered inside SettingsLayout, but the
 *                       routes are open, so a technician who types
 *                       /settings/roles mounts the page with no redirect and no
 *                       toast. Adding a guard here would change who can reach a
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
        <Route element={<V2AppLayout />}>
          <Route element={<ProtectedRoute allowedRoles={['ADMIN']} fallback />}>
            <Route path="/users" element={<UsersPage />} />
          </Route>
        </Route>
      </Route>

      {/* Organization Settings module - CASL-filtered per menu item (not ADMIN-gated) */}
      <Route element={<ProtectedRoute allowedRoles={['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN']} />}>
        <Route element={<V2AppLayout />}>
          <Route path="/settings" element={<SettingsLayout />}>
            <Route index element={<Navigate to="/settings/company" replace />} />
            <Route path="/settings/company" element={<CompanyProfilePage />} />
            <Route path="/settings/branding" element={<BrandingPage />} />
            <Route path="/settings/locations" element={<LocationsPage />} />
            <Route path="/settings/users" element={<UsersTeamsPage />} />
            <Route path="/settings/roles" element={<RolesPage />} />
            <Route path="/settings/security" element={<SecurityPage />} />
            <Route path="/settings/payments" element={<PaymentsListsPage />} />
            <Route path="/settings/job-sub-statuses" element={<JobSubStatusesPage />} />
            <Route path="/settings/decline-reasons" element={<DeclineReasonsPage />} />
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
