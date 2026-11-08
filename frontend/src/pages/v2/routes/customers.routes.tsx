import { lazy } from 'react';
import { Route } from 'react-router-dom';

import ProtectedRoute from '@/components/ProtectedRoute';

import V2AppLayout from '../V2AppLayout';

const CustomersPage = lazy(() => import('../customers/CustomersPage'));
const CustomerFormPage = lazy(() => import('../customers/CustomerFormPage'));
const CustomerDetailPage = lazy(() => import('../customers/CustomerDetailPage'));
const StatementPage = lazy(() => import('../customers/StatementPage'));

/**
 * Module 3 - Customers.
 *
 * The GUARD stack mirrors App.tsx exactly: ProtectedRoute(all four roles) and
 * NO RequireFeature - the customer routes carry no entitlement gate in App.tsx
 * and `customer.routes.ts` has no `requireFeature` either. Route ORDER is
 * App.tsx's: `/customers/new` before `/customers/:id/edit` before
 * `/customers/:id`, with the statement route last.
 *
 * The CHROME is the only substitution: V2AppLayout stands in for the app's
 * AppLayout. Guards decide who may enter, the layout only decides what frames
 * the page, so swapping the second changes no permission.
 */
export function customersV2Routes() {
  return (
    <Route element={<ProtectedRoute allowedRoles={['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN']} />}>
      <Route element={<V2AppLayout />}>
        <Route path="/customers" element={<CustomersPage />} />
        <Route path="/customers/new" element={<CustomerFormPage />} />
        <Route path="/customers/:id/edit" element={<CustomerFormPage />} />
        <Route path="/customers/:id" element={<CustomerDetailPage />} />
        <Route path="/customers/:customerId/statement" element={<StatementPage />} />
      </Route>
    </Route>
  );
}
