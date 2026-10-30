import { useState, type MutableRefObject } from 'react';
import { Link } from 'react-router-dom';

import { useDisputeEvidence, type DisputeEvidenceState, type EvidenceFileField } from '@/lib/api/paymentsPage';
import { formatInstant, useScheduleTimezone } from '@/lib/schedule-tz';
import { formatCurrency } from '@/lib/utils';
import { Alert } from '@/components/ui/alert';
import {
  DescriptionDetails, DescriptionItem, DescriptionList, DescriptionTerm,
} from '@/ui-kit/components/data/descriptionList';
import { Button } from '@/ui-kit/components/ui/button';
import { DiscardConfirm } from '@/ui-kit/components/ui/discardConfirm';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/ui-kit/components/ui/sheet';
import { Skeleton } from '@/ui-kit/components/ui/skeleton';
import { useDirtyGuard } from '@/ui-kit/hooks/useDirtyGuard';

import { DisputeEvidenceForm } from './DisputeEvidenceForm';
import { LoadError } from '../../_shared/loadError';
import { StatusChip } from '../../_shared/statusChip';
import { v2Path } from '../../uiV2';
import { FILE_LABELS, formatSize } from './evidenceFormat';
import { PHONE_TAP_AREA } from '../phoneTap';

const DAY: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' };
const PHONE_BUTTON = 'max-sm:h-11 touch:h-11';

/** The deadline in words, and whether it is close enough to be urgent. */
function deadlineOf(d: DisputeEvidenceState['dispute']): { text: string; urgent: boolean } | null {
  if (!d.respond_by || d.days_left == null) return null;
  const n = d.days_left;
  return {
    text: n === 0 ? 'Due today' : `${n} ${n === 1 ? 'day' : 'days'} left`,
    urgent: n <= 3,
  };
}

const isPastDue = (d: DisputeEvidenceState['dispute']) =>
  d.status === 'NEEDS_RESPONSE' && d.respond_by !== null && new Date(d.respond_by).getTime() <= Date.now();

/**
 * One dispute, answered inside ServWave (payments go-live P11). Its address is `?dispute=` so a refresh, a link and the
 * notification all reopen it. Step 1 reads the dispute; "Add evidence" opens step 2, the form.
 *
 * What the caller may do comes from the API (`can_edit`), never from a role check: a caller who may only look sees
 * step 1 and Close.
 */
export function DisputeDrawer({
  disputeId, onClose, returnFocusRef,
}: {
  disputeId: string | null;
  onClose: () => void;
  /** The element that opened the drawer; it gets focus back on close. */
  returnFocusRef?: MutableRefObject<HTMLElement | null>;
}) {
  const [dirty, setDirty] = useState(false);
  const guard = useDirtyGuard({ dirty, onClose });

  return (
    <>
      <Sheet open={Boolean(disputeId)} onOpenChange={guard.onOpenChange}>
        <SheetContent
          side="right"
          showClose={false}
          intent="content"
          className={PHONE_TAP_AREA}
          onCloseAutoFocus={(event) => {
            const target = returnFocusRef?.current;
            if (target?.isConnected) {
              event.preventDefault();
              target.focus();
            }
          }}
        >
          {disputeId && <DisputeBody key={disputeId} disputeId={disputeId} onRequestClose={() => guard.requestDismiss('close')} onDirtyChange={setDirty} />}
        </SheetContent>
      </Sheet>
      <DiscardConfirm {...guard.confirmProps} />
    </>
  );
}

function DisputeBody({
  disputeId, onRequestClose, onDirtyChange,
}: {
  disputeId: string;
  onRequestClose: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const query = useDisputeEvidence(disputeId);
  const data = query.data ?? null;
  const [step, setStep] = useState<'dispute' | 'evidence'>('dispute');
  // The form is kept (hidden) once opened, so Back to step 1 never loses what was typed.
  const [visited, setVisited] = useState(false);
  const editing = Boolean(data?.can_edit);
  // Reload: read the dispute again, then start the form over from what came back.
  const [formKey, setFormKey] = useState(0);
  const reload = () => { void query.refetch().then(() => setFormKey((k) => k + 1)); };

  if (query.isError) {
    return (
      <>
        <SheetHeader>
          <SheetTitle>Dispute</SheetTitle>
          <SheetDescription className="sr-only">Dispute details</SheetDescription>
        </SheetHeader>
        <div className="flex-1">
          <LoadError title="This dispute can’t be opened." onRetry={() => void query.refetch()} retrying={query.isFetching} />
        </div>
        <SheetFooter>
          <Button type="button" variant="outline" className={PHONE_BUTTON} onClick={onRequestClose}>Close</Button>
        </SheetFooter>
      </>
    );
  }
  if (!data) {
    return (
      <>
        <SheetHeader>
          <SheetTitle>Dispute</SheetTitle>
          <SheetDescription className="sr-only">Dispute details</SheetDescription>
        </SheetHeader>
        <div className="flex flex-1 flex-col gap-3 p-4"><Skeleton className="h-6 w-40" /><Skeleton className="h-10 w-32" /></div>
      </>
    );
  }
  const onForm = step === 'evidence' && editing;
  return (
    <>
      <SheetHeader>
        <SheetTitle>{onForm ? 'Add evidence' : data.can_edit ? 'Respond to dispute' : 'Dispute'}</SheetTitle>
        <SheetDescription className="sr-only">Dispute details</SheetDescription>
      </SheetHeader>
      {!onForm && (
        <StepOne data={data} onRequestClose={onRequestClose} onAdd={() => { setVisited(true); setStep('evidence'); }} />
      )}
      {editing && visited && (
        <div className={onForm ? 'contents' : 'hidden'} hidden={!onForm}>
          <DisputeEvidenceForm key={formKey} data={data} onBack={() => setStep('dispute')} onDirtyChange={onDirtyChange} onReload={reload} />
        </div>
      )}
    </>
  );
}

function StepOne({ data, onRequestClose, onAdd }: { data: DisputeEvidenceState; onRequestClose: () => void; onAdd: () => void }) {
  const timeZone = useScheduleTimezone();
  const d = data.dispute;
  const deadline = deadlineOf(d);
  const past = isPastDue(d);
  const day = (iso: string) => formatInstant(iso, timeZone, DAY);

  return (
    <>
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4">
        <DescriptionList>
          {d.respond_by && !d.outcome && !data.submitted && (
            <DescriptionItem>
              <DescriptionTerm>Respond by</DescriptionTerm>
              <DescriptionDetails className="font-normal">
                {day(d.respond_by)}
                {deadline && !past && (
                  <>
                    {' · '}
                    <span data-tone={deadline.urgent ? 'danger' : undefined} className={deadline.urgent ? 'font-semibold text-danger' : undefined}>
                      {deadline.text}
                    </span>
                  </>
                )}
              </DescriptionDetails>
            </DescriptionItem>
          )}
          <DescriptionItem>
            <DescriptionTerm>Amount</DescriptionTerm>
            <DescriptionDetails>{formatCurrency(d.amount)}</DescriptionDetails>
          </DescriptionItem>
          <DescriptionItem>
            <DescriptionTerm>Reason</DescriptionTerm>
            <DescriptionDetails className="font-normal">{d.reason_text}</DescriptionDetails>
          </DescriptionItem>
          {d.customer_name && (
            <DescriptionItem>
              <DescriptionTerm>Customer</DescriptionTerm>
              <DescriptionDetails className="font-normal">{d.customer_name}</DescriptionDetails>
            </DescriptionItem>
          )}
          {d.invoice && (
            <DescriptionItem>
              <DescriptionTerm>Invoice</DescriptionTerm>
              <DescriptionDetails className="font-normal">
                <Link to={v2Path(`/invoices/${d.invoice.id}`)} className="whitespace-nowrap text-brand hover:underline">{d.invoice.number}</Link>
              </DescriptionDetails>
            </DescriptionItem>
          )}
          <DescriptionItem>
            <DescriptionTerm>Status</DescriptionTerm>
            <DescriptionDetails className="font-normal"><StatusChip domain="dispute" status={d.status} /></DescriptionDetails>
          </DescriptionItem>
        </DescriptionList>

        {data.submitted ? (
          <SubmittedList data={data} day={day} />
        ) : d.outcome ? (
          <Alert tone={d.outcome === 'won' ? 'success' : 'neutral'} role="status">
            <b>{`${d.outcome === 'won' ? 'Won' : d.outcome === 'lost' ? 'Lost' : 'Closed'}${d.closed_at ? ` on ${day(d.closed_at)}` : ''}`}</b>
          </Alert>
        ) : d.is_bank_return ? (
          <p className="text-sm">The bank returned this payment, so there is no evidence to send.</p>
        ) : past ? (
          <Alert tone="danger">
            <span>{`The deadline passed on ${day(d.respond_by!)}`}</span>
          </Alert>
        ) : null}
      </div>

      <SheetFooter>
        {data.can_edit && (
          <Button type="button" className={PHONE_BUTTON} onClick={onAdd}>Add evidence</Button>
        )}
        <Button type="button" variant="outline" className={PHONE_BUTTON} onClick={onRequestClose}>Close</Button>
      </SheetFooter>
    </>
  );
}

const TEXT_LABELS: Array<[string, string]> = [
  ['uncategorized_text', 'Your explanation'],
  ['product_description', 'Product or service'],
  ['service_date', 'Service date'],
  ['customer_name', 'Customer name'],
  ['customer_email_address', 'Customer email'],
];

function SubmittedList({ data, day }: { data: DisputeEvidenceState; day: (iso: string) => string }) {
  const sent = data.submitted!;
  const sizeOf = (field: string) => data.form.files[field]?.size_bytes ?? null;
  const text = TEXT_LABELS.filter(([k]) => data.form.text[k]?.trim());
  return (
    <section aria-label="Evidence sent" className="flex flex-col gap-3">
      <p className="text-sm font-semibold">
        {`Evidence submitted${sent.at ? ` ${day(sent.at)}` : ''}${sent.by_name ? ` by ${sent.by_name}` : ''}`}
      </p>
      {sent.files.length > 0 && (
        <ul className="flex flex-col gap-2 text-sm">
          {sent.files.map((f) => (
            <li key={f.field} className="flex items-start justify-between gap-3">
              <span className="min-w-0">
                <span className="block text-xs text-text-secondary">{FILE_LABELS[f.field as EvidenceFileField] ?? 'Document'}</span>
                <span className="break-words">{f.file_name}</span>
              </span>
              {sizeOf(f.field) != null && <span className="shrink-0 text-text-secondary tabular-nums">{formatSize(sizeOf(f.field)!)}</span>}
            </li>
          ))}
        </ul>
      )}
      {text.map(([k, label]) => (
        <div key={k}>
          <p className="text-xs text-text-secondary">{label}</p>
          <p className="whitespace-pre-wrap break-words text-sm">{data.form.text[k]}</p>
        </div>
      ))}
    </section>
  );
}
