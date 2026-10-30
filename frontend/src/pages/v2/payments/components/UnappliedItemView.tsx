import { useState, type ReactNode } from 'react';

import {
  useUnappliedDetail, type AttachableInvoice, type AttentionItem, type UnappliedDetail,
} from '@/lib/api/paymentsPage';
import { formatInstant, useScheduleTimezone } from '@/lib/schedule-tz';
import { formatCurrency } from '@/lib/utils';
import { Alert } from '@/components/ui/alert';
import { NewTabLink } from '@/components/ui/new-tab-link';
import {
  DescriptionDetails, DescriptionItem, DescriptionList, DescriptionTerm,
} from '@/ui-kit/components/data/descriptionList';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { Skeleton } from '@/ui-kit/components/ui/skeleton';

import { LoadError } from '../../_shared/loadError';
import { DrawerBody, DrawerCloseButton, DrawerFooter, DrawerHeaderBar } from '../drawerHost';
import { AttachInvoiceDialog } from './AttachInvoiceDialog';
import { AttentionActions } from './attentionActions';
import { CustomerBlock } from './CustomerBlock';

const DAY: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' };
const MOMENT: Intl.DateTimeFormatOptions = { ...DAY, hour: 'numeric', minute: '2-digit' };

/** The word the drawer and the dialogs call this kind of item. */
export const unappliedTitle = (key: string) => (key.startsWith('unmatched_refund:') ? 'Unapplied refund' : 'Unapplied payment');

/**
 * The item as the action buttons and their dialogs read it. The drawer has the detail, not the list row, so this builds
 * the few fields those read (the key, the kind, the amount, who it is for) from what the detail says.
 */
export function itemFromDetail(d: UnappliedDetail): AttentionItem {
  const block = d.customer_block && !d.customer_block.restricted ? d.customer_block : null;
  return {
    key: d.key,
    type: d.kind === 'REFUND' ? 'unmatched_refund' : 'unmatched_payment',
    status: d.status,
    title: d.title,
    detail: d.reason_short,
    amount: d.amount,
    date: d.created_at,
    resolved_at: d.resolved_at,
    resolved_by_name: d.resolved_by_name,
    resolution: d.resolution,
    respond_by: null,
    days_left: null,
    payment_id: null,
    payment_reference: null,
    dispute_reference: null,
    reference: d.reference,
    dispute_status: null,
    payout_id: null,
    payout_reference: null,
    dispute_id: null,
    invoice: d.meant_for.invoice ? { id: d.meant_for.invoice.id, number: d.meant_for.invoice.number } : null,
    customer: block ? { id: block.id, name: block.name, customer_number: block.customer_number } : null,
    restricted: d.restricted,
    actions: d.actions,
    refund_again: null,
  };
}

function Row({ term, children, money = false }: { term: string; children: ReactNode; money?: boolean }) {
  return (
    <DescriptionItem>
      <DescriptionTerm>{term}</DescriptionTerm>
      <DescriptionDetails className={money ? undefined : 'font-normal'}>{children}</DescriptionDetails>
    </DescriptionItem>
  );
}

/** Open for a draft, sent or part-paid invoice; the other two say what they are. */
const invoiceWord = (status: string | null) => (status === 'PAID' ? 'Paid' : status === 'VOIDED' ? 'Voided' : 'Open');
const INVOICE_PILL = { Open: 'amber', Paid: 'green', Voided: 'slate' } as const;

function Suggestion({ invoice, amount, open, timeZone, onAttach }: { invoice: AttachableInvoice; amount: number | null; open: boolean; timeZone: string; onAttach: (row: AttachableInvoice, from: HTMLElement) => void }) {
  const due = invoice.due_date ? `Due ${formatInstant(invoice.due_date, timeZone, DAY)}` : null;
  const line = [due, invoice.job_type].filter(Boolean).join(' · ');
  return (
    <li className="flex flex-wrap items-center gap-3 border-b px-3 py-2.5 last:border-b-0">
      <div className="min-w-0 flex-[1_1_11rem]">
        <b className="block text-sm font-semibold">
          {invoice.number} · {invoice.customer}
          {invoice.meant && <> <Badge variant="softBlue" size="pill">Meant for this payment</Badge></>}
        </b>
        {line && <span className="text-muted-foreground block text-[13px]">{line}</span>}
        {!invoice.can_attach && amount != null && (
          <span className="text-muted-foreground block text-[13px]">
            Only {formatCurrency(invoice.payable_now)} is due, less than this {formatCurrency(amount)} payment.
          </span>
        )}
      </div>
      <span className="text-sm font-semibold tabular-nums">{formatCurrency(invoice.amount)}</span>
      {open && (
        <Button
          type="button" size="sm" variant="outline" className="max-sm:min-h-11" disabled={!invoice.can_attach}
          onClick={(event) => onAttach(invoice, event.currentTarget)}
        >
          Attach
        </Button>
      )}
    </li>
  );
}

function Loaded({ d }: { d: UnappliedDetail }) {
  const timeZone = useScheduleTimezone();
  const [attachRow, setAttachRow] = useState<AttachableInvoice | null>(null);
  const refund = d.kind === 'REFUND';
  const open = d.status === 'open';
  const item = itemFromDetail(d);
  const meant = d.meant_for.invoice;
  const payer = d.payer;
  const pillWord = open ? 'Unapplied' : 'Resolved';
  return (
    <>
      <DrawerHeaderBar title={unappliedTitle(d.key)} />
      <DrawerBody>
        <div className="flex items-center justify-between gap-3">
          <div className="text-[28px] leading-tight font-bold tabular-nums">{d.amount == null ? '—' : formatCurrency(d.amount)}</div>
          <Badge variant={open ? 'amber' : 'green'} size="sm">{pillWord}</Badge>
        </div>
        {open ? (
          <Alert tone="warning">
            <p>
              <b>{d.reason_short}.</b>
              {/* The two texts are the same sentence for some reasons: say it once. */}
              {d.reason_long.trim() !== d.reason_short.trim() && d.reason_long.trim() !== `${d.reason_short.trim()}.` && <> {d.reason_long}</>}
            </p>
          </Alert>
        ) : (
          <Alert tone="neutral" role="status">
            <p>
              <b>Resolved.</b>{' '}
              {[d.resolution?.text, d.resolved_by_name, d.resolved_at ? formatInstant(d.resolved_at, timeZone, DAY) : null].filter(Boolean).join(' · ')}
            </p>
          </Alert>
        )}
        {d.customer_block && (
          <CustomerBlock block={d.customer_block} email={{ subject: meant ? `Invoice ${meant.number}` : '' }} />
        )}
        {!d.restricted && (
          <DescriptionList>
            <Row term="Meant for">
              {meant ? (
                <span className="inline-flex items-center justify-end gap-2">
                  <NewTabLink href={`/invoices/${meant.id}`} className="inline-flex shrink-0 items-center whitespace-nowrap">{meant.number}</NewTabLink>
                  <Badge variant={INVOICE_PILL[invoiceWord(meant.status)]} size="sm">{invoiceWord(meant.status)}</Badge>
                </span>
              ) : 'Not tied to an invoice'}
            </Row>
            {meant && meant.total != null && <Row term="Invoice total" money>{formatCurrency(meant.total)}</Row>}
          </DescriptionList>
        )}
        {payer && (
          <>
            <h3 className="text-sm font-semibold">{refund ? 'Where the refund went' : 'What the payer gave'}</h3>
            <DescriptionList>
              {payer.detail && <Row term="Card">{payer.detail}</Row>}
              {payer.description && <Row term="Description">{payer.description}</Row>}
              <Row term={refund ? 'Sent' : 'Received'}>{formatInstant(payer.received_at, timeZone, MOMENT)}</Row>
              <Row term="Reference">{payer.reference}</Row>
            </DescriptionList>
          </>
        )}
        {open && !refund && !d.restricted && (
          <>
            <h3 className="text-sm font-semibold">Suggested invoices</h3>
            {d.suggested_invoices.length ? (
              <ul className="border-border shrink-0 overflow-hidden rounded-lg border">
                {d.suggested_invoices.map((row) => (
                  <Suggestion key={row.id} invoice={row} amount={d.amount} timeZone={timeZone} open={d.actions.includes('attach_to_invoice')} onAttach={(r) => setAttachRow(r)} />
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground text-sm">No open invoice has this amount or was meant for it. Choose Attach to invoice to search them all.</p>
            )}
          </>
        )}
      </DrawerBody>
      <DrawerFooter oneRow={open && d.actions.length > 0}>
        {open && <AttentionActions item={item} size="default" />}
        <DrawerCloseButton />
      </DrawerFooter>
      {attachRow && <AttachInvoiceDialog item={item} preselect={attachRow} onClose={() => setAttachRow(null)} />}
    </>
  );
}

/**
 * An unapplied payment or refund as a view of the drawer host (V7-09c): why it is here, who is it for, how it was paid,
 * the invoices that could take it, and what this person may do. It is the whole stack: money that is on no payment has
 * nothing underneath it. Read by its key through the same route as the failed items.
 */
export function UnappliedItemView({ itemKey }: { itemKey: string }) {
  const query = useUnappliedDetail(itemKey);
  if (!query.data) {
    return (
      <>
        <DrawerHeaderBar title={unappliedTitle(itemKey)} />
        <DrawerBody>
          {query.isError ? (
            <LoadError title="Couldn’t load this item." onRetry={() => void query.refetch()} retrying={query.isFetching} />
          ) : (
            <><Skeleton className="h-6 w-40" /><Skeleton className="h-10 w-32" /></>
          )}
        </DrawerBody>
        <DrawerFooter><DrawerCloseButton /></DrawerFooter>
      </>
    );
  }
  return <Loaded d={query.data} />;
}
