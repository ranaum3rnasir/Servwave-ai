import { Navigate, useLocation } from 'react-router-dom';

/**
 * The old Settings > Payments & Lists address. Saved notification rows, emails and the hosted-setup return all carry it,
 * so it stays routed and lands on ServWave Payments. The query string travels with it: `?onboarding=return` is what
 * tells the page to refresh the account status once. A static `to` string would drop it.
 */
export function LegacyPaymentsRedirect() {
  const location = useLocation();
  return <Navigate replace to={{ pathname: '/settings/servwave-payments', search: location.search }} />;
}

/** The old Payout account & verification address: now a card on ServWave Payments, reached by its hash. */
export function LegacyPayoutAccountRedirect() {
  return <Navigate replace to="/settings/servwave-payments#payout-account" />;
}
