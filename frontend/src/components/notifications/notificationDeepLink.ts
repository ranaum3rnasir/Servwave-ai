import type { NotificationView } from '@/lib/api/notifications';

/**
 * Where a notification points. Its own small module so the always-loaded code (the toast hook)
 * does not pull the whole notification list into the staff app's entry bundle; the panel and its
 * rows load the first time the bell opens.
 */
export function notificationDeepLink(item: NotificationView): string {
  const { object_type, object_id } = item;
  const type = object_type?.toUpperCase() ?? '';

  switch (type) {
    case 'JOB':
      return `/jobs/${object_id}`;
    case 'JOB_STAGE':
      // Staging notifications carry a JobStage id (NOT a Job id) — linking to
      // /jobs/:id 404'd. Land on the staging view instead (P5 §4).
      return '/inventory/staging';
    case 'ESTIMATE':
      return `/estimates/${object_id}`;
    case 'LEAD':
      return `/leads/${object_id}`;
    case 'INVOICE':
      return `/invoices/${object_id}`;
    case 'PURCHASE_ORDER':
      // The PO page is its own route — don't lump it into /inventory (P5 §4).
      return '/inventory/purchase-orders';
    case 'TASK':
      // Every task.* verb carries a Task id, but Tasks is ONE route with no
      // `:id` child — the six views are component-local tabs and the detail is a
      // store-driven drawer, never a URL (tasks.paths.ts). `/tasks/:id` would
      // fall into the catch-all redirect, so the id rides as a query param the
      // hub consumes once and strips. `task.deleted` points at a row that is
      // gone by design; the hub degrades to the plain hub and says so.
      return object_id ? `/tasks?task=${object_id}` : '/tasks';
    case 'INVENTORY_ITEM':
    case 'STOCK_APPROVAL':
      return '/inventory';
    case 'CALL':
      return '/communication/phone';
    case 'MESSAGE_THREAD':
      // The Text inbox deep-links to an exact thread via ?threadId= (see
      // SmsInboxView's deep-link effect); unknown ids fall back gracefully
      // to the page-level view.
      return object_id ? `/communication/text?threadId=${object_id}` : '/communication/text';
    case 'USER':
    case 'TIME_ENTRY':
      return '/settings';
    default:
      return '/';
  }
}
