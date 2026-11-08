import { lazy } from 'react';
import { Route } from 'react-router-dom';

import ProtectedRoute from '@/components/ProtectedRoute';

import V2AppLayout from '../V2AppLayout';

const InvoicesPage = lazy(() => import('../invoices/InvoicesPage'));
const StandaloneInvoiceFormPage = lazy(() => import('../invoices/StandaloneInvoiceFormPage'));
const InvoiceDetailPage = lazy(() => import('../invoices/InvoiceDetailPage'));

/**
 * Module 6 - Invoices.
 *
 * The GUARD stack mirrors App.tsx exactly:
 *  - ProtectedRoute(all four roles) wraps all three pages;
 *  - `/invoices/new` carries a SECOND, nested ProtectedRoute limited to
 *    ADMIN + DISPATCHER with `fallback`, so a SALES or TECHNICIAN user who deep
 *    links there renders NotAuthorizedPage rather than being redirected. That
 *    mirrors the backend, which 403s any other role on the standalone anchor;
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
        <Route path="/invoices" element={<InvoicesPage />} />
        <Route element={<ProtectedRoute allowedRoles={['ADMIN', 'DISPATCHER']} fallback />}>
          <Route path="/invoices/new" element={<StandaloneInvoiceFormPage />} />
        </Route>
        <Route path="/invoices/:id" element={<InvoiceDetailPage />} />
      </Route>
    </Route>
  );
}
