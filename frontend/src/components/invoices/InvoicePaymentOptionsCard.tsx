import { useId, useState } from 'react';
import type { PaymentMethod } from '@/types/entities';
import { PAYMENT_METHOD_LABELS } from '@/lib/payment-methods';
import { useFeature } from '@/lib/entitlements';
import {
  describeMethods,
  NOT_IN_PLAN_NOTE,
  ONLINE_METHOD_LABELS,
  onlineMethodActive,
  orderMethods,
  orgDefaultMethods,
  orgManualMethods,
  sameMethods,
  type OnlineMethod,
  type OrgPaymentDefaultsSource,
} from '@/lib/payment-options';
import { Button } from '@/ui-kit/components/ui/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/ui-kit/components/ui/card';
import { Checkbox } from '@/ui-kit/components/ui/checkbox';
import { Switch } from '@/ui-kit/components/ui/switch';
import { useInvoicePaymentOptionsSaves } from './useInvoicePaymentOptionsSaves';

export interface InvoicePaymentOptionsCardProps {
  invoiceId: string;
  /** The invoice's stored methods override; null = the org default. */
  paymentMethodsOverride: PaymentMethod[] | null | undefined;
  /** The invoice's allow-partial flag; null = off (the org default). */
  allowPartialPayment: boolean | null | undefined;
  org: OrgPaymentDefaultsSource | null | undefined;
  /** The invoice is editable and the user may update invoices. */
  canEdit: boolean;
  /** A deposit is always paid in full, so the partial switch is not shown. */
  isDeposit?: boolean;
}

const ONLINE: OnlineMethod[] = ['CARD', 'ACH'];

/**
 * Payments go-live slice 21 - "Payment options" for ONE invoice (stories 25 and 28).
 *
 * Which methods this invoice offers (defaults from the org) and whether the customer may pay part
 * of it (off by default). Every change saves straight to PATCH /api/invoices/:id for this invoice
 * only; the customer's page asks the backend resolver, which still drops an online method the
 * payout account cannot take yet.
 */
export function InvoicePaymentOptionsCard({
  invoiceId,
  paymentMethodsOverride,
  allowPartialPayment,
  org,
  canEdit,
  isDeposit = false,
}: InvoicePaymentOptionsCardProps) {
  const onlineGroupId = useId();
  const manualGroupId = useId();
  const partialId = useId();

  // Slice 16: while the plan lacks online payments, Card and Bank are neither offered by default
  // nor shown as available (the customer's page cannot offer them).
  const onlinePaymentsInPlan = useFeature('online_payments');
  const orgDefault = orgDefaultMethods(org, onlinePaymentsInPlan);
  const stored = paymentMethodsOverride ?? null;

  // Saves go one at a time per invoice, so the server can never apply an older list after a newer
  // one, even when the change comes from the invoice's other card (the send sheet). The choices on
  // screen are shared the same way: a click shows at once in every card, so the next click builds
  // on it, and the stored value comes back once nothing newer is on its way.
  const { saving, draft, save } = useInvoicePaymentOptionsSaves(
    invoiceId,
    JSON.stringify([stored, orgDefault, allowPartialPayment ?? null]),
  );
  const methods = draft?.methods ?? stored ?? orgDefault;
  const partial = !isDeposit && (draft?.partial ?? allowPartialPayment === true);

  // A list that matches the org default is no override: it is saved as null, so the invoice keeps
  // following the org if the owner changes the default later.
  const methodsDiffer = !sameMethods(methods, orgDefault);

  // The backend refuses an empty override, and an invoice nobody can pay helps no one.
  const [lastMethodKept, setLastMethodKept] = useState(false);

  const toggleMethod = (method: PaymentMethod) => {
    const next = orderMethods(methods.includes(method) ? methods.filter((m) => m !== method) : [...methods, method]);
    if (next.length === 0) {
      setLastMethodKept(true);
      return;
    }
    setLastMethodKept(false);
    save({ methods: next }, { payment_methods_override: sameMethods(next, orgDefault) ? null : next });
  };

  // Partial payment is off unless this invoice turns it on, so "off" is stored as the default (null).
  const togglePartial = (on: boolean) => {
    save({ partial: on }, { allow_partial_payment: on ? true : null });
  };

  const useOrgDefault = () => {
    setLastMethodKept(false);
    save({ methods: orgDefault, partial: false }, { payment_methods_override: null, allow_partial_payment: null });
  };

  // The manual methods the org records by hand, plus any this invoice still lists that the org has
  // since stopped accepting: the customer's page offers those too, so staff must see them here.
  const orgManual = orgManualMethods(org);
  const isManual = (m: PaymentMethod) => m !== 'CARD' && m !== 'ACH';
  const manual = orderMethods([...orgManual, ...(stored ?? []).filter(isManual), ...methods.filter(isManual)]);

  // The customer's page offers an online method only while the account can take it, so a list of
  // online methods none of which is active leaves the customer nothing to pay with (slice 21 review).
  const nothingToPayWith = methods.every((m) =>
    (m === 'CARD' || m === 'ACH') && !onlineMethodActive(org, m, onlinePaymentsInPlan));

  const row = (method: PaymentMethod, label: string, note?: string) => {
    const id = `${partialId}-${method}`;
    return (
      <div key={method} className="flex items-start gap-2">
        <Checkbox
          id={id}
          checked={methods.includes(method)}
          disabled={!canEdit}
          onCheckedChange={() => toggleMethod(method)}
          className="mt-0.5"
        />
        <div className="min-w-0">
          <label htmlFor={id} className="cursor-pointer text-sm font-medium select-none">
            {label}
          </label>
          {note && <p className="text-muted-foreground text-xs">{note}</p>}
        </div>
      </div>
    );
  };

  return (
    <Card data-testid="invoice-payment-options">
      <CardHeader>
        <CardTitle>Payment options</CardTitle>
        {canEdit && (methodsDiffer || partial) && (
          <CardAction>
            <Button size="sm" variant="outline" onClick={useOrgDefault} disabled={saving}>
              Use org default
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4 pb-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div role="group" aria-labelledby={onlineGroupId} className="flex flex-col gap-2">
            <p id={onlineGroupId} className="text-muted-foreground text-xs font-semibold uppercase tracking-wide">
              Online with ServWave Payments
            </p>
            {ONLINE.map((m) =>
              row(m, ONLINE_METHOD_LABELS[m], onlineMethodActive(org, m, onlinePaymentsInPlan)
                ? undefined
                : onlinePaymentsInPlan ? unavailableNote(m) : NOT_IN_PLAN_NOTE),
            )}
          </div>
          {manual.length > 0 && (
            <div role="group" aria-labelledby={manualGroupId} className="flex flex-col gap-2">
              <p id={manualGroupId} className="text-muted-foreground text-xs font-semibold uppercase tracking-wide">
                Recorded by hand
              </p>
              {manual.map((m) => row(m, PAYMENT_METHOD_LABELS[m], orgManual.includes(m) ? undefined : NO_LONGER_ACCEPTED_NOTE))}
            </div>
          )}
        </div>
        {methodsDiffer && (
          <p className="text-muted-foreground text-xs">Org default: {describeMethods(orgDefault)}</p>
        )}
        {nothingToPayWith && (
          <p role="alert" className="text-danger text-xs">
            The customer has no way to pay this invoice yet. Add a method recorded by hand or use the org default.
          </p>
        )}
        {lastMethodKept && (
          <p role="alert" className="text-danger text-xs">Keep at least one method, or use the org default.</p>
        )}

        {!isDeposit && (
        <div className="flex items-center justify-between gap-3 border-t pt-4">
          <div className="min-w-0">
            <label htmlFor={partialId} className="text-sm font-medium">
              Allow partial payments
            </label>
            {partial && <p className="text-muted-foreground text-xs">Org default: off</p>}
          </div>
          <Switch id={partialId} checked={partial} disabled={!canEdit} onCheckedChange={togglePartial} />
        </div>
        )}
      </CardContent>
    </Card>
  );
}

const NO_LONGER_ACCEPTED_NOTE = 'Your org no longer accepts this';

function unavailableNote(method: OnlineMethod): string {
  return method === 'CARD'
    ? 'Unavailable until card payments are active'
    : 'Unavailable until bank payments are active';
}
