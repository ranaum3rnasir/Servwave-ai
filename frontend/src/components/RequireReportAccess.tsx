import { useParams } from 'react-router-dom';
import RequirePageAccess from '@/components/RequirePageAccess';
import { getDestination } from '@/components/layout/nav-registry';

/** The one report page Billing opens: the Billing menu entry's own address, `/reports/<slug>`. */
const BILLING_SLUG = getDestination('billing')?.href.split('/').pop();

/**
 * Route guard for the report pages (`/reports/:slug`). Every report opens on Access Reports; the unpaid-invoices report
 * is also what Billing opens, so either Access Billing or Access Reports opens it (the server's report endpoint takes
 * either, too). Anyone refused is sent to their dashboard.
 */
export default function RequireReportAccess() {
  const { slug } = useParams<{ slug: string }>();
  if (slug && slug === BILLING_SLUG) {
    return <RequirePageAccess any={['access_billing', 'access_reports']} />;
  }
  return <RequirePageAccess all={['access_reports']} />;
}
