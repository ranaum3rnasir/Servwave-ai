import { Label } from '@/components/ui/label';
import { SelectField } from '@/components/form/SelectField';
import type { PaymentMethod } from '@/lib/api/organization';
import { NO_RECORDABLE_METHODS } from '@/lib/api/recordablePaymentMethods';
import { PAYMENT_METHOD_LABELS } from '@/lib/payment-methods';

interface Props {
  /** The methods the person may record (see `useRecordablePaymentMethods`), in the dialogs' usual order. */
  methods: PaymentMethod[];
  /** False until the lists have been read: nothing is offered, and no reason is given yet. */
  ready: boolean;
  value: string;
  onValueChange: (value: string) => void;
  /** Id of the line that says why the record button is greyed, so the host can point the button at it. */
  reasonId: string;
  /** Id of the field's label, for a host that points at it. */
  labelId?: string;
}

/**
 * The Payment method field of the two payment dialogs (the invoice record-payment dialog and the estimate deposit
 * dialog). Not a FormField: SelectField has no id passthrough for FormField's label to point at (the same reason both
 * dialogs gave before this was shared), so the field is labelled by aria-label.
 */
export function RecordPaymentMethodField({ methods, ready, value, onValueChange, reasonId, labelId }: Props) {
  const none = ready && methods.length === 0;
  return (
    <div>
      <Label id={labelId}>Payment method *</Label>
      <SelectField
        aria-label="Payment method"
        value={value}
        onValueChange={onValueChange}
        disabled={methods.length === 0}
        className="w-full h-9"
        options={methods.map((m) => ({ value: m, label: PAYMENT_METHOD_LABELS[m] }))}
      />
      {none && (
        <p id={reasonId} className="mt-1 text-xs text-text-secondary">
          {NO_RECORDABLE_METHODS}
        </p>
      )}
    </div>
  );
}
