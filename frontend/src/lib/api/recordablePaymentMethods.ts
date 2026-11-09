import { useMySwitchesStatus } from '@/lib/api/shared/mySwitches';
import type { PaymentMethod } from '@/types/entities';
import { useQuery } from '@tanstack/react-query';
import api from '@/lib/axios';
import { PAYMENT_METHOD_ORDER } from '@/lib/payment-methods';

/** The company's effective accepted payment methods, as `GET /api/permission-switches/accepted-payment-methods` answers. */
export interface AcceptedPaymentMethods {
  /** The company ticked no method in ServWave Payments, so every method is accepted. */
  every_method: boolean;
  /** The methods the company accepts: the ticked ones plus Credit Card while the card processor is live, or every method. */
  methods: string[];
}

/** The read the Allowed payment methods editor offers its checklist from (and the payment dialogs filter by). */
export function useAcceptedPaymentMethods() {
  return useQuery<AcceptedPaymentMethods>({
    queryKey: ['permission-switches', 'accepted-payment-methods'],
    queryFn: () => api.get('/api/permission-switches/accepted-payment-methods').then((r) => r.data),
  });
}

/**
 * Roles & Permissions: the payment methods the signed-in person may record by hand.
 *
 * The invoice record-payment dialog (also opened by a job's Payment Received step) and the estimate deposit dialog
 * offer exactly the methods that are in the company's effective accepted list AND in the person's Allowed payment
 * methods, in the order those dialogs have always listed them. Both lists are read through their one hook each
 * (`useAcceptedPaymentMethods`, `useMySwitches`'s query); nothing here decides access - the server refuses a method
 * outside either list - so a read that fails offers the full list and lets the server answer.
 */
export const NO_RECORDABLE_METHODS = 'No payment methods are allowed for you. Ask an admin.';

export interface RecordablePaymentMethods {
  /** False until both lists have been read (or have failed): the dialogs hold their record button until then. */
  ready: boolean;
  /** The methods to offer, in the dialogs' usual order. Empty once ready means the person may record none. */
  methods: PaymentMethod[];
}

export function useRecordablePaymentMethods(): RecordablePaymentMethods {
  const company = useAcceptedPaymentMethods();
  const mine = useMySwitchesStatus();
  const ready = !company.isPending && !mine.pending;

  const companyMethods = company.data?.methods;
  const admin = mine.answer?.admin_box === true;
  const personValue = mine.answer?.values.allowed_payment_methods;
  // "All accepted methods" is the company's list itself; a ticked subset is cut down to it. The Admin box, and a
  // value the answer does not carry, are not narrowed by the person.
  const personList = !admin && Array.isArray(personValue) ? personValue : null;

  // Nothing is on offer until both lists are in, so the preselection never lands on a method that is then taken away.
  const methods = !ready
    ? []
    : PAYMENT_METHOD_ORDER.filter(
        (m) => (!companyMethods || companyMethods.includes(m)) && (!personList || personList.includes(m)),
      );
  return { ready, methods };
}

/** The method a dialog shows: the one the person picked while it is still on offer, else the first on offer. */
export function selectedPaymentMethod(picked: string, offered: PaymentMethod[]): string {
  return offered.find((m) => m === picked) ?? offered[0] ?? '';
}
