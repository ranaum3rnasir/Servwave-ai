/**
 * Module 11 - Settings & Users. Every path this module claims.
 *
 * `/settings` itself is listed as well as each child: the route mounts the
 * layout with an index redirect to `company`, so the bare path is a real
 * destination and not just a prefix.
 *
 * `/settings/organization` is deliberately ABSENT. The map for this module lists
 * it, but `OrganizationSettingsPage.tsx` has been deleted and no route declares
 * it - registering a path with no route would make the registry describe a page
 * that does not exist.
 */
export const SETTINGS_V2_PATHS = [
  '/users',
  '/settings',
  '/settings/company',
  '/settings/branding',
  '/settings/locations',
  '/settings/users',
  '/settings/roles',
  '/settings/security',
  '/settings/payments',
  '/settings/job-sub-statuses',
  '/settings/decline-reasons',
  '/settings/phone-sms',
  '/settings/phone-numbers',
  // No '/settings/email': the Gmail connect surface it pointed at was deleted
  // upstream, so the page and its route went with it.
  '/settings/inventory',
  '/settings/schedule-colors',
  '/settings/profile',
  // The retired Lead Statuses tab: still claimed, because `settings.routes.tsx` declares a
  // redirect from it to the settings home so an old bookmark does not fall through to "/".
  '/settings/lead-statuses',
  // The two tabs with no kit rebuild yet. Registered because this module
  // DECLARES a route for each - `settings.routes.tsx` mounts the original page
  // components under the same `/settings` parent - and the registry's job is to
  // list every path this module claims, so no other module can claim one too.
  //
  // `/settings/custom-fields` is deliberately NOT claimed: the tab is held out of
  // the 2026-08-17 release, so no route declares it.
  '/settings/tax-rates',
  '/settings/email-sender',
] as const;
