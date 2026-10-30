import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { formatCurrency, extractApiError } from '@/lib/utils';
import { cancelBankPayment } from '@/lib/api/invoices';
import { toast } from '@/components/ui/use-toast';

interface CancelBankPaymentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invoiceId: string;
  payment: { id: string; amount: number | string };
}

/**
 * Payments go-live slice 29 (D17): a bank payment that is still processing has not landed, so it
 * is cancelled, not refunded. Cancelling stops the debit; the payment is marked failed and the
 * balance it was going to pay stays open. Copy names no processor.
 */
export function CancelBankPaymentDialog({ open, onOpenChange, invoiceId, payment }: CancelBankPaymentDialogProps) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => cancelBankPayment(invoiceId, payment.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoice', invoiceId] });
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      toast({ title: 'Bank payment cancelled', description: 'No money moved. The balance is open for payment again.' });
      onOpenChange(false);
    },
  });

  const close = () => {
    mutation.reset();
    onOpenChange(false);
  };

  return (
    <Modal
      intent="form"
      open={open}
      onClose={close}
      title="Cancel payment"
      subtitle="Stop a bank payment before it clears."
      width="xs"
      data-testid="cancel-bank-payment-dialog"
      footer={
        <>
          <Button variant="outline" onClick={close}>
            Keep payment
          </Button>
          <Button
            variant="solid"
            tone="danger"
            data-testid="cancel-bank-payment-submit"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
          >
            {mutation.isPending ? 'Cancelling...' : 'Cancel payment'}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p>
          This bank payment of {formatCurrency(Number(payment.amount))} has not cleared yet. Cancelling
          stops it: no money moves, and the balance it was paying stays open.
        </p>
        {mutation.error && (
          <p className="text-danger">{extractApiError(mutation.error, "This bank payment couldn't be cancelled.")}</p>
        )}
      </div>
    </Modal>
  );
}
