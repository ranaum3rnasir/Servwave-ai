import { usePaymentDetail, type AttentionItem } from '@/lib/api/paymentsPage';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/ui-kit/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/ui-kit/components/ui/dialog';

import { PHONE_TAP_AREA } from '../phoneTap';
import { EmailRow, PhoneRow } from './CustomerBlock';
import { RESTRICTED_CUSTOMER_TEXT, dialerContextOf } from './customerBlockParts';

const TAP = 'max-sm:min-h-11';

/**
 * "Contact customer" on a failed bank payment. It sends nothing: it shows who the customer is with Call and Text beside
 * the phone and Email beside the address, each opening in a new tab. Email is prefilled with the item's own `compose`
 * (subject and body built by the server; the pay link only for a person who may send one). The phone and email come
 * from the payment's customer block.
 */
export function ContactCustomerDialog({ item, onClose }: { item: AttentionItem; onClose: () => void }) {
  const detail = usePaymentDetail(item.payment_id);
  const block = detail.data?.customer_block;
  const compose = item.compose ?? null;

  let body;
  if (detail.isError && !detail.data) {
    body = (
      <Alert tone="danger" role="alert">
        <div className="flex w-full flex-wrap items-center justify-between gap-2">
          <span>Couldn’t load the customer.</span>
          <Button type="button" size="sm" variant="outline" className={TAP} onClick={() => void detail.refetch()} disabled={detail.isFetching}>
            Retry
          </Button>
        </div>
      </Alert>
    );
  } else if (!block) {
    body = <p className="text-text-secondary text-sm" role="status">Loading the customer…</p>;
  } else if (block.restricted) {
    body = <p className="text-text-secondary text-sm">{RESTRICTED_CUSTOMER_TEXT}</p>;
  } else {
    const email = { subject: compose?.subject ?? `Invoice ${block.invoice.number}`, body: compose?.body };
    body = (
      <>
        <p className="text-base font-semibold [overflow-wrap:anywhere]">{block.name}</p>
        <ul className="flex flex-col">
          <PhoneRow block={block} context={dialerContextOf(block)} />
          <EmailRow block={block} email={email} />
        </ul>
      </>
    );
  }

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent
        intent="choice"
        className={`sm:max-w-md ${PHONE_TAP_AREA}`}
        // The opener is not a Dialog trigger, so the page puts focus back itself (see useActionPress).
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Contact customer</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-2">{body}</DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" className={TAP} onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
