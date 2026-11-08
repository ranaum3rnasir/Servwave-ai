import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import api from '@/lib/axios';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EstimateDocumentView } from '@/components/estimates/EstimateDocumentView';

interface ViewWorkOrderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  estimateId: string;
  customerName: string;
  companyName?: string | null;
}

// The Work Order is the job's backing estimate document, re-titled "Work Order".
// Fetches the full estimate on-demand (only while open) and renders the shared
// EstimateDocumentView with documentLabel="Work Order".
export function ViewWorkOrderDialog({
  open,
  onOpenChange,
  estimateId,
  customerName,
  companyName,
}: ViewWorkOrderDialogProps) {
  const { data: est, isLoading } = useQuery({
    queryKey: ['estimate', estimateId],
    queryFn: () => api.get(`/api/estimates/${estimateId}`).then((r) => r.data.estimate),
    enabled: open,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl w-full max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Work Order</DialogTitle>
        </DialogHeader>
        {isLoading || !est ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-text-soft" />
          </div>
        ) : (
          <EstimateDocumentView
            documentLabel="Work Order"
            estimateNumber={est.estimate_number}
            customerName={customerName}
            companyName={companyName}
            scopeNotes={est.scope_notes ?? undefined}
            lineItems={est.line_items || []}
            subtotal={Number(est.subtotal)}
            taxRate={Number(est.tax_rate)}
            taxAmount={Number(est.tax_amount)}
            totalAmount={Number(est.total_amount)}
            discountType={est.discount_type}
            discountValue={est.discount_value != null ? Number(est.discount_value) : null}
            discountName={est.discount_name}
            discountAmount={est.discount_amount != null ? Number(est.discount_amount) : null}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
