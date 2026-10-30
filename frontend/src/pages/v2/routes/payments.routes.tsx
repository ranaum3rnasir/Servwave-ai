import { lazy } from 'react';
import { Route } from 'react-router-dom';

import ProtectedRoute from '@/components/ProtectedRoute';
import RequirePageAccess from '@/components/RequirePageAccess';

import V2AppLayout from '../V2AppLayout';

const PaymentsPage = lazy(() => import('../payments/PaymentsPage'));

/**
 * Payments go-live P5 - the Payments page (payments, payouts, documents).
 *
 * The guard mirrors Invoices: every base role may reach the ProtectedRoute, and the page opens on View payments and
 * payouts, never on a role name. There is no RequireFeature: the page lists history even when
 * the plan lacks online payments, and an org with no payout account sees the not-set-up state instead.
 */
export function paymentsV2Routes() {
  return (
    <Route element={<ProtectedRoute allowedRoles={['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN']} />}>
      <Route element={<V2AppLayout />}>
        <Route element={<RequirePageAccess all={['view_payments']} />}>
          <Route path="/payments" element={<PaymentsPage />} />
        </Route>
      </Route>
    </Route>
  );
}
