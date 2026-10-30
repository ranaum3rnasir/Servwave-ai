import type { NotificationView } from '@/lib/api/notifications';
import { withPanel } from '@/lib/recordPanel';

/**
 * Where a notification points. Its own small module so the always-loaded code (the toast hook)
 * does not pull the whole notification list into the staff app's entry bundle; the panel and its
 * rows load the first time the bell opens.
 */
export function notificationDeepLink(item: NotificationView): string {
  // A notification can name the page where its work is done (a payment that could not be applied
  // is raised on an invoice, but acted on in Settings > Payments). Only an in-app path is followed.
  const named = item.data?.link_path;
  if (typeof named === 'string' && named.startsWith('/') && !named.startsWith('//')) return named;

  // It can also name a panel inside its record (the job's review panel). The link is the record's address with the panel
  // in it, the same for everyone; the record's page opens the panel only for a person who may see it.
  const path = recordPath(item);
  return path === '/' ? path : withPanel(path, item.data?.panel);
}

function recordPath(item: NotificationView): string {
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
    case 'LOGISTIC_ORDER':
      // The order's own page is a record route, outside the Logistic Orders list guard: an approver who has the list hidden
      // still opens the order they were asked to approve (the server decides whether they may see it).
      return `/inventory/logistic-orders/${object_id}`;
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
    case 'EMAIL_THREAD':
      // An inbound email alert names a conversation (an email_threads row), not a message, and the Inbox opens a message by its own
      // id, so the link lands on the Email page. What the page lists and opens is the server's single-read rule, so a person
      // whose access was removed after delivery finds the conversation is not there. It used to fall to the dashboard.
      return '/communication/inbox';
    case 'USER':
    case 'TIME_ENTRY':
      return '/settings';
    default:
      return '/';
  }
}
