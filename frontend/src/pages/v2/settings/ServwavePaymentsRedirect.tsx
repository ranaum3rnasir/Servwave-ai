import { Navigate, useSearchParams } from 'react-router-dom';

/**
 * Where each old tab of Settings > ServWave Payments lives now (payments go-live P8). The area moved to the Payments
 * page; the address stays, as a redirect, so every email link and bell notification from before the move still lands.
 * Disputes are a filter of the Payments tab, not a tab of their own.
 */
const TARGETS: Record<string, string> = {
  payments: '/payments?tab=payments',
  payouts: '/payments?tab=payouts',
  documents: '/payments?tab=documents',
  disputes: '/payments?tab=payments&chip=disputed',
};

function servwavePaymentsTarget(tab: string | null): string {
  return (tab && Object.prototype.hasOwnProperty.call(TARGETS, tab) ? TARGETS[tab] : null) ?? '/payments';
}

/**
 * Renders no Settings shell on the way: the route sits outside it. Who may stay is the Payments page's own guard (View
 * payments and payouts plus Show Payments page); anyone else ends on their dashboard.
 */
export default function ServwavePaymentsRedirect() {
  const [params] = useSearchParams();
  return <Navigate to={servwavePaymentsTarget(params.get('tab'))} replace />;
}
