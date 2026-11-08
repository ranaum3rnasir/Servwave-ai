import { formatCurrency } from '@/lib/utils';
import { BUCKET_LABEL, bucketStatus, type EstimateRow } from '@/lib/reports/estimates-report-logic';

import {
  Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle,
} from '@/ui-kit/components/ui/sheet';

/**
 * Read-only detail for one estimate (mock phase - no editing).
 *
 * Same six rows, same bucket label from the shared logic. On the kit's Sheet
 * the scrolling body is its own `SheetBody` slot rather than an
 * `overflow-y-auto` class on the content, which is the one structural change.
 */
export function EstimateDetailPanel({ estimate, onClose }: { estimate: EstimateRow | null; onClose: () => void }) {
  return (
    <Sheet open={!!estimate} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="right" className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{estimate ? `Estimate ${estimate.number}` : 'Estimate'}</SheetTitle>
        </SheetHeader>
        {estimate && (
          <SheetBody>
            <dl className="space-y-3 text-sm">
              {([
                ['Customer', estimate.customer],
                ['Rep', estimate.rep],
                ['Status', BUCKET_LABEL[bucketStatus(estimate)]],
                ['Created', estimate.createdAt],
                ['Amount', formatCurrency(estimate.amount)],
                ['Deposit due', formatCurrency(estimate.depositDue)],
              ] as [string, string][]).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-4 border-b pb-2">
                  <dt className="text-muted-foreground">{k}</dt>
                  <dd className="font-medium">{v}</dd>
                </div>
              ))}
            </dl>
            <p className="text-muted-foreground pt-2 text-xs">
              Sample data - detail view is read-only in this phase.
            </p>
          </SheetBody>
        )}
      </SheetContent>
    </Sheet>
  );
}
