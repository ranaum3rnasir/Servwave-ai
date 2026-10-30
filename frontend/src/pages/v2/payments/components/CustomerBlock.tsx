import { useRef, useState, type ReactNode, type RefObject } from 'react';
import { Briefcase, Building2, Filter, Lock, Mail, MapPin, Phone, Receipt } from 'lucide-react';

import { useAppAbility } from '@/contexts/AbilityContext';
import { NewTabLink } from '@/components/ui/new-tab-link';
import { customerEmailDisplay, customerNameDisplay, phoneDisplay } from '@/components/contact/contactDisplayPolicy';
import { CustomerEmailAction, CustomerPhoneActions } from '@/components/contact/CustomerContactButtons';
import { isIosDevice, mapsHref } from '@/components/contact/contactHrefs';
import { useContactPolicyInput } from '@/components/contact/useContactPolicyInput';
import type { DialerEntityContext } from '@/stores/dialer.store';
import type { PaymentCustomerBlock } from '@/lib/api/paymentsPage';
import { cn, getInitials } from '@/lib/utils';
import { Button } from '@/ui-kit/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/ui-kit/components/ui/dialog';

import { CustomerIdLink } from './CustomerIdLink';
import { RESTRICTED_CUSTOMER_TEXT, dialerContextOf, type BlockEmail, type OpenBlock } from './customerBlockParts';
import { PHONE_TAP_AREA } from '../phoneTap';


const MISSING = 'text-text-secondary text-sm';

function Row({ icon, value, actions }: { icon: ReactNode; value: ReactNode; actions?: ReactNode }) {
  return (
    <li className="border-border flex min-h-11 flex-wrap items-center gap-x-3 gap-y-2 border-t py-2 first:border-t-0">
      <span className="text-text-secondary shrink-0 [&_svg]:size-4" aria-hidden="true">{icon}</span>
      <span className="min-w-0 flex-1 text-sm [overflow-wrap:anywhere]">{value}</span>
      {actions && (
        <span className="flex shrink-0 items-center gap-2 max-md:w-full max-md:[&>*]:flex-1">{actions}</span>
      )}
    </li>
  );
}

/** The phone row: the number (or "No phone on file") and Call and Text. Shared with the Contact customer dialog. */
export function PhoneRow({ block, context }: { block: OpenBlock; context: DialerEntityContext }) {
  const policy = useContactPolicyInput();
  const phone = block.phone ? phoneDisplay('customer_phone', block.phone, null, policy) : null;
  return (
    <Row
      icon={<Phone />}
      value={phone ? <span className={cn('tabular-nums', !phone.selectable && 'select-none')}>{phone.text}</span> : <span className={MISSING}>No phone on file</span>}
      actions={<CustomerPhoneActions phone={block.phone} context={context} />}
    />
  );
}

/** The email row: the address (or "No email on file") and Email. Shared with the Contact customer dialog. */
export function EmailRow({ block, email }: { block: OpenBlock; email: BlockEmail }) {
  const policy = useContactPolicyInput();
  const mail = block.email ? customerEmailDisplay(block.email, policy) : null;
  return (
    <Row
      icon={<Mail />}
      value={mail ? <span className={cn(!mail.selectable && 'select-none')}>{mail.text}</span> : <span className={MISSING}>No email on file</span>}
      actions={
        <CustomerEmailAction
          email={block.email}
          compose={{ subject: email.subject ?? '', body: email.body, customerId: block.id, jobId: block.job?.id, invoiceId: block.invoice.id }}
        />
      }
    />
  );
}

const chipBase = 'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-sm max-md:h-11';

function AddressDialog({ name, address, onClose, returnFocus }: { name: string; address: string; onClose: () => void; returnFocus: RefObject<HTMLButtonElement | null> }) {
  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent
        intent="choice"
        className={`sm:max-w-md ${PHONE_TAP_AREA}`}
        // The address button is not a Dialog trigger, so focus is put back on it here (Escape and Close alike).
        onCloseAutoFocus={(event) => { event.preventDefault(); returnFocus.current?.focus(); }}
      >
        <DialogHeader>
          <DialogTitle>{name}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p className="font-semibold [overflow-wrap:anywhere]">{address}</p>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" className="max-md:min-h-11" onClick={onClose}>Close</Button>
          <NewTabLink variant="button" className="max-md:min-h-11" href={mapsHref(address, { ios: isIosDevice() })}>
            Open in Maps
          </NewTabLink>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Who the customer is, with one click to reach them: call, text, email, the address on a map, and the customer, job,
 * lead and invoice each in a new tab. Drawn from the server's `customer_block`, which already leaves out what this
 * viewer may not see; a restricted viewer reads one lock line. Every control goes through the contact display policy.
 */
export function CustomerBlock({ block, email = {} }: { block: PaymentCustomerBlock; email?: BlockEmail }) {
  const policy = useContactPolicyInput();
  const ability = useAppAbility();
  const [mapOpen, setMapOpen] = useState(false);

  if (block.restricted) {
    return (
      <section aria-label="Customer" className="border-border bg-surface-light text-text-secondary flex items-center gap-2 rounded-lg border p-3.5 text-sm">
        <Lock className="size-4 shrink-0" aria-hidden="true" />
        {RESTRICTED_CUSTOMER_TEXT}
      </section>
    );
  }
  return <OpenCustomerBlock block={block} email={email} policy={policy} ability={ability} mapOpen={mapOpen} setMapOpen={setMapOpen} />;
}

function OpenCustomerBlock({
  block, email, policy, ability, mapOpen, setMapOpen,
}: {
  block: OpenBlock;
  email: BlockEmail;
  policy: ReturnType<typeof useContactPolicyInput>;
  ability: ReturnType<typeof useAppAbility>;
  mapOpen: boolean;
  setMapOpen: (open: boolean) => void;
}) {
  const addressButton = useRef<HTMLButtonElement>(null);
  const nameLink = customerNameDisplay(policy).link;
  const canJob = ability.can('read', 'Job');
  const canLead = ability.can('read', 'Lead');
  const canInvoice = ability.can('read', 'Invoice');
  const context = dialerContextOf(block);

  return (
    <section aria-label="Customer" className="border-border bg-surface-light flex flex-col gap-1 rounded-lg border p-3.5">
      <div className="flex items-center gap-3 max-md:py-1.5">
        <span aria-hidden="true" className="bg-primary-subtle text-primary flex size-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold">
          {getInitials(block.name)}
        </span>
        <div className="flex min-w-0 flex-col items-start">
          {nameLink ? (
            <NewTabLink href={`/customers/${block.id}`} className="inline-flex min-w-0 items-center text-base font-semibold max-md:min-h-11 max-md:py-3">
              {block.name}
            </NewTabLink>
          ) : (
            <span className="text-base font-semibold [overflow-wrap:anywhere] max-md:py-3">{block.name}</span>
          )}
          <span className="text-text-secondary flex flex-wrap items-center gap-x-1.5 text-[13px]">
            <CustomerIdLink customer={{ id: block.id, customer_number: block.customer_number }} />
            {block.company && (
              <>
                <span aria-hidden="true">·</span>
                <Building2 className="size-3.5" aria-hidden="true" />
                <span>{block.company}</span>
              </>
            )}
          </span>
        </div>
      </div>

      <ul className="flex flex-col">
        <Row
          icon={<MapPin />}
          value={
            block.address ? (
              <Button ref={addressButton} type="button" variant="ghost" size="sm" className="-ml-3 h-auto min-h-8 justify-start whitespace-normal text-left text-sm font-normal underline-offset-2 hover:underline max-md:min-h-11" onClick={() => setMapOpen(true)}>
                {block.address}
              </Button>
            ) : (
              <span className={MISSING}>No address on file</span>
            )
          }
        />
        <PhoneRow block={block} context={context} />
        <EmailRow block={block} email={email} />
      </ul>

      {(canJob || canLead || canInvoice) && (
      <div role="group" aria-label="Related records" className="border-border mt-1 flex flex-wrap gap-2 border-t pt-3">
        {canJob &&
          (block.job ? (
            <NewTabLink variant="chip" href={`/jobs/${block.job.id}`}>
              <Briefcase className="mr-1.5 size-4" aria-hidden="true" />
              {`Job ${block.job.number}${block.job.type ? ` · ${block.job.type}` : ''}`}
            </NewTabLink>
          ) : (
            <span className={cn(chipBase, 'text-text-secondary border-dashed')}><Briefcase className="size-4" aria-hidden="true" />No job linked</span>
          ))}
        {canLead &&
          (block.lead ? (
            <NewTabLink variant="chip" href={`/leads/${block.lead.id}`}>
              <Filter className="mr-1.5 size-4" aria-hidden="true" />
              {`Lead ${block.lead.number}`}
            </NewTabLink>
          ) : (
            <span className={cn(chipBase, 'text-text-secondary border-dashed')}><Filter className="size-4" aria-hidden="true" />No lead linked</span>
          ))}
        {canInvoice && (
          <NewTabLink variant="chip" href={`/invoices/${block.invoice.id}`}>
            <Receipt className="mr-1.5 size-4" aria-hidden="true" />
            {`Invoice ${block.invoice.number}`}
          </NewTabLink>
        )}
      </div>
      )}

      {mapOpen && block.address && <AddressDialog name={block.name} address={block.address} onClose={() => setMapOpen(false)} returnFocus={addressButton} />}
    </section>
  );
}
