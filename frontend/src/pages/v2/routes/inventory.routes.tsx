import { lazy } from 'react';
import { Navigate, Route } from 'react-router-dom';

import ProtectedRoute from '@/components/ProtectedRoute';
import RequireFeature from '@/components/RequireFeature';

import V2AppLayout from '../V2AppLayout';
import { v2Path } from '../uiV2';

const InventoryPage = lazy(() => import('../inventory/InventoryPage'));
const InventoryPriceBookPage = lazy(() => import('../inventory/PriceBookPage'));
const PurchaseOrdersPage = lazy(() => import('../inventory/PurchaseOrdersPage'));
const VendorsPage = lazy(() => import('../inventory/VendorsPage'));

/**
 * Module 10 - Inventory.
 *
 * The GUARD stack mirrors App.tsx exactly: the module-wide
 * `ProtectedRoute(all four roles)` that wraps the whole authenticated tree
 * there, then `RequireFeature("inventory")` over every inventory route. No
 * inventory route carries a ProtectedRoute of its own in App.tsx, so none
 * carries one here.
 *
 * Route ORDER is App.tsx's, including the two things that are easy to lose:
 *
 *  - ONE page component serves six paths (`/inventory` plus staging, assets,
 *    low-stock, activity, logistic-orders). The active view is derived from
 *    the URL inside the page, never from state, so the tabs stay deep-linkable
 *    for the alert bus. This IS the decided model for SRVW-257 ("tabs of one
 *    page with a shared shell", not separately routed pages) - it was already
 *    correct here. The bug that ticket reported (switching tabs felt like
 *    leaving for a different page - filters, search and scroll all reset) did
 *    not come from these six Route entries; a probe test proved React does
 *    not remount InventoryPage when the match changes among them, since it is
 *    the same component reference at every path. The actual cause was
 *    `V2AppLayout.tsx`'s `moduleKeyOf`, which forced a fresh Suspense boundary
 *    (and everything under it) on every one of these six paths. Fixed there;
 *    see that file's comment.
 *  - `/inventory/approvals` is a REDIRECT, not a view. Stock-approvals is
 *    feature-parked (P0 SS C / QA-901), so the page was replaced with a
 *    `<Navigate to="/inventory" replace />` and there are no dead deep-links.
 *    Carried over rather than dropped: without it `/inventory/approvals` falls
 *    through to `path="*"` and bounces to "/", instead of landing the user on
 *    the stock list.
 *
 * The CHROME is the only substitution: V2AppLayout stands in for the app's
 * AppLayout. Guards decide who may enter, the layout only decides what frames
 * the page, so swapping the second changes no permission.
 */
export function inventoryV2Routes() {
  return (
    <Route element={<ProtectedRoute allowedRoles={['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN']} />}>
      <Route element={<V2AppLayout />}>
        <Route element={<RequireFeature feature="inventory" />}>
          <Route path="/inventory" element={<InventoryPage />} />
          <Route path="/inventory/staging" element={<InventoryPage />} />
          <Route path="/inventory/assets" element={<InventoryPage />} />
          <Route path="/inventory/low-stock" element={<InventoryPage />} />
          <Route path="/inventory/activity" element={<InventoryPage />} />
          <Route path="/inventory/logistic-orders" element={<InventoryPage />} />
          <Route
            path="/inventory/approvals"
            element={<Navigate to={v2Path('/inventory')} replace />}
          />
          <Route path="/inventory/price-book" element={<InventoryPriceBookPage />} />
          <Route path="/inventory/purchase-orders" element={<PurchaseOrdersPage />} />
          <Route path="/inventory/vendors" element={<VendorsPage />} />
        </Route>
      </Route>
    </Route>
  );
}
