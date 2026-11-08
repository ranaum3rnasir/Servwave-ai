/**
 * inlineActions.ts
 *
 * Maps each notification action_type to an async handler.
 *
 * Contract:
 *   - Each handler receives the full NotificationView item.
 *   - If the handler resolves without throwing, the caller stamps acted_at
 *     via useMarkActed and invalidates ['notifications'].
 *   - If the handler throws, the caller surfaces a toast and does NOT stamp
 *     acted_at — the item stays actionable.
 *   - SCHEDULE_JOB and VIEW are "navigate only" — they never throw (just
 *     call navigate) and are stamped acted immediately after navigation.
 */

import type { NavigateFunction } from 'react-router-dom';
import api from '@/lib/axios';
import type { NotificationView } from '@/lib/api/notifications';
import { notificationDeepLink } from './NotificationItem';

export type ActionResult = { skipActed?: boolean } | void;
export type ActionHandler = (
  item: NotificationView,
  navigate: NavigateFunction,
) => Promise<ActionResult>;

// ---------------------------------------------------------------------------
// Individual handlers
// ---------------------------------------------------------------------------

/**
 * SCHEDULE_JOB — land on the lead and open its estimate-picker modal
 * (?createJob=<estimateId>). The notification is NOT marked done here; it
 * clears only when a job is actually created (backend resolveScheduleJobNotifications).
 * Falls back to the estimate page for legacy payloads without lead_id.
 *
 * Backend emits: object: {type:'ESTIMATE', id: <estimate_id>}, data: { object_label, lead_id }
 * — B1 added lead_id to the payload; older payloads without it fall back to
 * the estimate page (or /jobs?action=new-job if no id is available at all).
 */
async function handleScheduleJob(
  item: NotificationView,
  navigate: NavigateFunction,
): Promise<ActionResult> {
  const estimateId = (item.data.estimate_id as string | undefined) ?? item.object_id;
  const leadId = item.data.lead_id as string | undefined;
  if (leadId) {
    navigate(`/leads/${leadId}?createJob=${estimateId ?? ''}`);
  } else if (estimateId) {
    navigate(`/estimates/${estimateId}`);
  } else {
    navigate('/jobs?action=new-job');
  }
  return { skipActed: true };
}

/**
 * APPROVE_OT — approve an overtime punch override.
 */
async function handleApproveOt(item: NotificationView): Promise<void> {
  const punchId = item.data.punch_id as string;
  await api.post(`/api/timeclock/punches/${punchId}/override/approve`);
}

/**
 * DENY_OT — reject an overtime punch override.
 */
async function handleDenyOt(item: NotificationView): Promise<void> {
  const punchId = item.data.punch_id as string;
  await api.post(`/api/timeclock/punches/${punchId}/override/reject`);
}

/**
 * APPROVE_STOCK — approve a stock-level approval request.
 */
async function handleApproveStock(item: NotificationView): Promise<void> {
  const approvalId = item.data.approval_id as string;
  await api.post('/api/inventory/stock-approvals/decide', {
    id: approvalId,
    decision: 'approved',
  });
}

/**
 * DENY_STOCK — reject a stock-level approval request.
 */
async function handleDenyStock(item: NotificationView): Promise<void> {
  const approvalId = item.data.approval_id as string;
  await api.post('/api/inventory/stock-approvals/decide', {
    id: approvalId,
    decision: 'rejected',
  });
}

/**
 * SEND_REMINDER — resend an invoice reminder email.
 *
 * Backend emits: object: {type:'INVOICE', id: <invoice_id>}, data: { due_date, object_label }
 * — no invoice_id in data.  Use object_id as the canonical source; fall back
 * to data.invoice_id for any legacy payloads that included it.
 */
async function handleSendReminder(item: NotificationView): Promise<void> {
  const invoiceId = (item.data.invoice_id as string | undefined) ?? item.object_id;
  await api.post(`/api/invoices/${invoiceId}/resend`, {});
}

/**
 * VIEW — navigate to the deep-link for this notification.
 * No API call; stamped acted on navigate.
 */
async function handleView(
  item: NotificationView,
  navigate: NavigateFunction,
): Promise<void> {
  navigate(notificationDeepLink(item));
}

// ---------------------------------------------------------------------------
// Exported map: action_type (uppercased) → handler
// ---------------------------------------------------------------------------

export const ACTION_HANDLERS: Record<string, ActionHandler> = {
  SCHEDULE_JOB: handleScheduleJob,
  APPROVE_OT: handleApproveOt,
  DENY_OT: handleDenyOt,
  APPROVE_STOCK: handleApproveStock,
  DENY_STOCK: handleDenyStock,
  SEND_REMINDER: handleSendReminder,
  VIEW: handleView,
};
