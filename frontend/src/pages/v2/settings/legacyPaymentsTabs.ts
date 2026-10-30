/**
 * Where each old tab of Settings > ServWave Payments lives now (payments go-live P8). The area moved to the Payments
 * page; the `?tab=` address still works, as a redirect, so every email link and bell notification from before the move
 * still lands. Disputes are a filter of the Payments tab, not a tab of their own.
 */
export const LEGACY_PAYMENTS_TAB_TARGETS: Record<string, string> = {
  payments: '/payments?tab=payments',
  payouts: '/payments?tab=payouts',
  documents: '/payments?tab=documents',
  disputes: '/payments?tab=payments&chip=disputed',
};

/** Is this `tab` value one of the old tabs? Anything else (none, or an unknown value) belongs to the settings page. */
export function isLegacyPaymentsTab(tab: string | null): tab is string {
  return Boolean(tab) && Object.prototype.hasOwnProperty.call(LEGACY_PAYMENTS_TAB_TARGETS, tab as string);
}
