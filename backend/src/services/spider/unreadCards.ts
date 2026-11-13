/**
 * One unread Spider alert as the pop-up card reads it: the ONE serializer behind both the unread-alerts read
 * (controllers/spider.controller.ts getMyUnreadSpiderAlerts) and the live line's "alert added" message
 * (liveMessages.ts), so a card that arrives on the line is exactly the card the next read returns (#3472).
 */
import { isWatchedStatus, type SpiderStatus } from './config';
import { SPIDER_STAGE_NAME } from './messages';

/** The card fields every alert carries from the moment it was raised (the notification data). */
const CARD_FIELDS = [
  'lead_number',
  'customer_name',
  'company_name',
  'status',
  'status_label',
  'stage_name',
  'service_location',
  'service_request',
  'assigned_to',
  'address',
  'owner_name',
  'entered_status_at',
  'stage_entered_at',
  'lead_created_at',
  'counted_from',
  'time_in_status',
] as const;

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** One person's row of an alert: its id (the recipient row), when it was written, and the alert's stored record. */
export interface SpiderCardRow {
  id: string;
  created_at: Date;
  notification: { object_id: string; data: unknown };
}

/**
 * The card for one person's alert. `leadStatus` is the lead's own status now (undefined when unknown): his click routes
 * on it, "Estimate" once the lead is Estimate Sent.
 */
export function spiderAlertCard(row: SpiderCardRow, leadStatus: string | undefined): Record<string, unknown> {
  const leadId = row.notification.object_id;
  const data = (row.notification.data ?? {}) as Record<string, unknown>;
  const card: Record<string, unknown> = {};
  for (const k of CARD_FIELDS) card[k] = data[k] ?? null;
  // Alerts raised before the contractor's fields were stored fall back to what they carry.
  const stageName =
    str(data.stage_name) ?? (isWatchedStatus(String(data.status)) ? SPIDER_STAGE_NAME[data.status as SpiderStatus] : null);
  return {
    id: row.id,
    created_at: row.created_at.toISOString(),
    ...card,
    lead_id: leadId,
    stage_name: stageName,
    current_stage: leadStatus === 'ESTIMATED' ? 'Estimate' : stageName,
    service_location: str(data.service_location) ?? str(data.address),
    assigned_to: str(data.assigned_to) ?? str(data.owner_name),
    stage_entered_at: str(data.stage_entered_at) ?? str(data.entered_status_at),
    message: str(data.body),
  };
}
