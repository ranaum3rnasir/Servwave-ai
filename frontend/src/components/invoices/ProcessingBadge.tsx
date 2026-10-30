import { Badge } from '@/ui-kit/components/ui/badge';
import { processingBadgeText } from '@/lib/payment-display';

/**
 * "Processing $X" - the bank money still clearing on an invoice (payments go-live slice 28).
 * An invoice has no "processing" status: the amount is derived from its PROCESSING payments, and
 * this badge shows only while there is one, so nobody chases a customer who has already paid.
 */
export function ProcessingBadge({ amount }: { amount: number | string | null | undefined }) {
  const text = processingBadgeText(amount);
  if (!text) return null;
  return (
    <Badge
      variant="softAmber"
      size="sm"
      className="whitespace-nowrap"
      title="Bank payment started - the money has not arrived yet"
      data-testid="processing-badge"
    >
      {text}
    </Badge>
  );
}
