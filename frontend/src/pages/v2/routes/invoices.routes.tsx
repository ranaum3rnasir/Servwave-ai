import { lazy } from 'react';
import { Route } from 'react-router-dom';

import ProtectedRoute from '@/components/ProtectedRoute';
import RequirePageAccess from '@/components/RequirePageAccess';

import V2AppLayout from '../V2AppLayout';

const InvoicesPage = lazy(() => import('../invoices/InvoicesPage'));
const StandaloneInvoiceFormPage = lazy(() => import('../invoices/StandaloneInvoiceFormPage'));
const InvoiceDetailPage = lazy(() => import('../invoices/InvoiceDetailPage'));

/**
 * Module 6 - Invoices.
 *
 * The GUARD stack mirrors App.tsx exactly:
 *  - ProtectedRoute(all four roles) wraps all three pages;
 *  - `/invoices/new` (the standalone New invoice) opens on Standalone invoices
 *    never on a role name: a person without it is
 *    sent to their dashboard. The backend decides the create on Standalone
 *    invoices (which requires Create invoices);
 *  - `/invoices/new` is declared BEFORE `/invoices/:id`, as it must be.
 *
 * There is NO RequireFeature here, because App.tsx has none for Invoices - no
 * entitlement gates this module.
 *
 * The CHROME is the only substitution: V2AppLayout stands in for the app's
 * AppLayout. Guards decide who may enter, the layout only decides what frames
 * the page, so swapping the second changes no permission.
 */
export function invoicesV2Routes() {
  return (
    <Route element={<ProtectedRoute allowedRoles={['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN']} />}>
      <Route element={<V2AppLayout />}>
        <Route element={<RequirePageAccess all={['view_invoices']} />}>
          <Route path="/invoices" element={<InvoicesPage />} />
        </Route>
        <Route element={<RequirePageAccess all={['standalone_invoices']} />}>
          <Route path="/invoices/new" element={<StandaloneInvoiceFormPage />} />
        </Route>
        <Route path="/invoices/:id" element={<InvoiceDetailPage />} />
      </Route>
    </Route>
  );
}
