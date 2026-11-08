import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { formatCurrency } from '@/lib/utils';
import { bucketStatus, BUCKET_LABEL, type EstimateRow } from '@/lib/reports/estimates-report-logic';

/** Read-only detail for one estimate (mock phase — no editing). */
export function EstimateDetailPanel({ estimate, onClose }: { estimate: EstimateRow | null; onClose: () => void }) {
  return (
    <Sheet open={!!estimate} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader className="text-left">
          <SheetTitle>{estimate ? `Estimate ${estimate.number}` : 'Estimate'}</SheetTitle>
        </SheetHeader>
        {estimate && (
          <dl className="mt-4 space-y-3 text-sm">
            {[
              ['Customer', estimate.customer],
              ['Rep', estimate.rep],
              ['Status', BUCKET_LABEL[bucketStatus(estimate)]],
              ['Created', estimate.createdAt],
              ['Amount', formatCurrency(estimate.amount)],
              ['Deposit due', formatCurrency(estimate.depositDue)],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between gap-4 border-b border-border pb-2">
                <dt className="text-text-secondary">{k}</dt>
                <dd className="font-medium text-text-primary">{v}</dd>
              </div>
            ))}
            <p className="pt-2 text-xs text-text-secondary">Sample data — detail view is read-only in this phase.</p>
          </dl>
        )}
      </SheetContent>
    </Sheet>
  );
}
