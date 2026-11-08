/**
 * Shared presentational bits for the Logistic Order surfaces (LOList + LODetailSheet).
 * Kept in its own file so both the list and the detail sheet import these helpers without a
 * list↔sheet import cycle (LOList mounts LODetailSheet). The status badge itself now renders
 * through the shared StatusBadge (@/components/data/status-badge, domain="logisticOrder") —
 * see @/design-system/status-registry for the label/intent map.
 */
import type { LoAnchors } from '@/lib/api/logisticOrders';

/** Short calendar date for list rows / the actor trail. */
export function formatLoDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * The precedence-winning anchor (job > invoice > estimate > lead > customer > service plan) as a
 * label + optional route. Service plans have no detail route today, so they render as plain text
 * (`to` omitted). Returns null for a standalone LO.
 */
export function primaryAnchor(anchors: LoAnchors): { label: string; to?: string } | null {
  if (anchors.jobId) return { label: anchors.jobNumber ?? 'Job', to: `/jobs/${anchors.jobId}` };
  if (anchors.invoiceId)
    return { label: anchors.invoiceNumber ?? 'Invoice', to: `/invoices/${anchors.invoiceId}` };
  if (anchors.estimateId)
    return { label: anchors.estimateNumber ?? 'Estimate', to: `/estimates/${anchors.estimateId}` };
  if (anchors.leadId) return { label: anchors.leadNumber ?? 'Lead', to: `/leads/${anchors.leadId}` };
  if (anchors.customerId)
    return { label: anchors.customerNumber ?? 'Customer', to: `/customers/${anchors.customerId}` };
  if (anchors.servicePlanId)
    return { label: anchors.servicePlanNumber ?? 'Service plan' };
  return null;
}
