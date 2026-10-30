import { useRef, useState } from 'react';
import { ChevronRight, FileText, Image as ImageIcon } from 'lucide-react';

import {
  EVIDENCE_FILE_FIELDS, useDisputeEvidence, type DisputeEvidenceState,
} from '@/lib/api/paymentsPage';
import { formatInstant, useScheduleTimezone } from '@/lib/schedule-tz';
import { formatCurrency } from '@/lib/utils';
import { Alert } from '@/components/ui/alert';
import {
  DescriptionDetails, DescriptionItem, DescriptionList, DescriptionTerm,
} from '@/ui-kit/components/data/descriptionList';
import { Timeline, TimelineContent, TimelineItem, TimelineTime } from '@/ui-kit/components/data/timeline';
import { Button } from '@/ui-kit/components/ui/button';
import { SheetFooter } from '@/ui-kit/components/ui/sheet';
import { Skeleton } from '@/ui-kit/components/ui/skeleton';

import { LoadError } from '../../_shared/loadError';
import { StatusChip } from '../../_shared/statusChip';
import { DrawerBody, DrawerCloseButton, DrawerHeaderBar, useDrawerHost } from '../drawerHost';
import { timeLeft, useNow } from '../timeLeft';
import { CustomerBlock } from './CustomerBlock';
import { DisputeDeadline } from './DisputeDeadline';
import { EvidencePreviewDialog, type PreviewFile } from './EvidencePreviewDialog';
import { formatSize } from './evidenceFormat';

const DAY: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' };

const TEXT_LABELS: Array<[string, string]> = [
  ['uncategorized_text', 'Your explanation'],
  ['product_description', 'Product or service'],
  ['service_date', 'Service date'],
  ['customer_name', 'Customer name'],
  ['customer_email_address', 'Customer email'],
];

/** The dot colours of the timeline: red for the dispute, blue for what is due, green for what went well. */
const DOT = {
  bad: 'before:bg-danger-strong before:ring-danger-surface',
  info: 'before:bg-info-strong before:ring-info-surface',
  done: 'before:bg-success-strong before:ring-success-surface',
} as const;

const mimeOfName = (name: string) => (/\.pdf$/i.test(name) ? 'application/pdf' : /\.png$/i.test(name) ? 'image/png' : 'image/jpeg');

/** The files to list: what is saved in the form, or, once the evidence is sent, what was sent. */
function filesOf(data: DisputeEvidenceState): PreviewFile[] {
  const { form, submitted } = data;
  if (submitted) {
    return submitted.files.map((f) => ({
      attachment_id: f.attachment_id,
      file_name: f.file_name,
      mime: form.files[f.field]?.mime ?? mimeOfName(f.file_name),
      size_bytes: form.files[f.field]?.size_bytes ?? null,
    }));
  }
  return EVIDENCE_FILE_FIELDS.flatMap((field) => {
    const held = form.files[field];
    return held ? [{ attachment_id: held.attachment_id, file_name: held.file_name, mime: held.mime, size_bytes: held.size_bytes }] : [];
  });
}

/**
 * One dispute, read-only (payments go-live V7-08): who paid, how long is left, what was said and sent, and what happened
 * when. Answering is the next view (Respond), offered only to someone the API says may answer (`can_edit`), never from a
 * role check here.
 */
export function DisputeView({ disputeId }: { disputeId: string }) {
  const host = useDrawerHost();
  const timeZone = useScheduleTimezone();
  const now = useNow(60_000);
  const query = useDisputeEvidence(disputeId);
  const data = query.data ?? null;
  const [preview, setPreview] = useState<number | null>(null);
  const opener = useRef<HTMLElement | null>(null);

  if (query.isError) {
    return (
      <>
        <DrawerHeaderBar title="Dispute" />
        <div className="flex-1">
          <LoadError title="This dispute can’t be opened." onRetry={() => void query.refetch()} retrying={query.isFetching} />
        </div>
        <SheetFooter>
          <DrawerCloseButton />
        </SheetFooter>
      </>
    );
  }
  if (!data) {
    return (
      <>
        <DrawerHeaderBar title="Dispute" />
        <DrawerBody><Skeleton className="h-6 w-40" /><Skeleton className="h-10 w-32" /></DrawerBody>
      </>
    );
  }

  const d = data.dispute;
  const day = (iso: string) => formatInstant(iso, timeZone, DAY);
  const needsResponse = d.status === 'NEEDS_RESPONSE';
  const files = filesOf(data);
  const sent = data.submitted;
  const written = TEXT_LABELS.filter(([k]) => data.form.text[k]?.trim());
  const left = needsResponse ? timeLeft(d.respond_by, now) : null;

  return (
    <>
      <DrawerHeaderBar title={`Dispute ${d.reference}`} />
      <DrawerBody>
        {data.customer_block && <CustomerBlock block={data.customer_block} />}
        {needsResponse && d.respond_by && <DisputeDeadline respondBy={d.respond_by} />}

        <DescriptionList>
          <DescriptionItem>
            <DescriptionTerm>Status</DescriptionTerm>
            <DescriptionDetails className="font-normal"><StatusChip domain="dispute" status={d.status} /></DescriptionDetails>
          </DescriptionItem>
          <DescriptionItem>
            <DescriptionTerm>Reason</DescriptionTerm>
            <DescriptionDetails className="font-normal">{d.reason_text}</DescriptionDetails>
          </DescriptionItem>
          <DescriptionItem>
            <DescriptionTerm>Amount</DescriptionTerm>
            <DescriptionDetails>{formatCurrency(d.amount)}</DescriptionDetails>
          </DescriptionItem>
          <DescriptionItem>
            <DescriptionTerm>Opened</DescriptionTerm>
            <DescriptionDetails className="font-normal">{day(d.opened_at)}</DescriptionDetails>
          </DescriptionItem>
          <DescriptionItem>
            <DescriptionTerm>Payment</DescriptionTerm>
            <DescriptionDetails className="font-normal">
              <Button
                type="button"
                variant="link"
                className="h-auto p-0 font-normal"
                onClick={() => host.push({ kind: 'payment', id: d.payment.id })}
              >
                {d.payment.reference}
              </Button>
            </DescriptionDetails>
          </DescriptionItem>
        </DescriptionList>

        {d.is_bank_return && !d.outcome && (
          <p className="text-sm">The bank returned this payment, so there is no evidence to send.</p>
        )}
        {d.outcome && d.outcome !== 'won' && (
          <Alert tone="neutral" role="status">
            <b>{`${d.outcome === 'lost' ? 'Lost' : 'Closed'}${d.closed_at ? ` on ${day(d.closed_at)}` : ''}`}</b>
          </Alert>
        )}

        <div>
          <h3 className="mb-2 text-sm font-semibold">Evidence files</h3>
          {files.length === 0 ? (
            <p className="text-text-secondary text-sm">No evidence files yet.</p>
          ) : (
            <ul className="border-border overflow-hidden rounded-lg border">
              {files.map((f, i) => (
                <li key={f.attachment_id} className="border-border border-b last:border-b-0">
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-auto min-h-12 w-full justify-start gap-3 whitespace-normal rounded-none px-3 py-2 text-left font-normal"
                    onClick={(event) => { opener.current = event.currentTarget; setPreview(i); }}
                  >
                    {f.mime === 'application/pdf' ? <FileText aria-hidden /> : <ImageIcon aria-hidden />}
                    <span className="min-w-0 flex-1 font-medium whitespace-normal [overflow-wrap:anywhere]">{f.file_name}</span>
                    {f.size_bytes != null && <span className="text-text-secondary shrink-0 text-[12.5px]">{formatSize(f.size_bytes)}</span>}
                    <ChevronRight aria-hidden className="text-text-secondary" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {sent && (
            <p className="mt-3 text-sm font-semibold">
              {`Evidence submitted${sent.at ? ` ${day(sent.at)}` : ''}${sent.by_name ? ` by ${sent.by_name}` : ''}`}
            </p>
          )}
          {sent && written.map(([k, label]) => (
            <div key={k} className="mt-3">
              <p className="text-text-secondary text-xs">{label}</p>
              <p className="text-sm break-words whitespace-pre-wrap">{data.form.text[k]}</p>
            </div>
          ))}
        </div>

        <div>
          <h3 className="mb-2 text-sm font-semibold">Timeline</h3>
          <Timeline>
            <TimelineItem className={DOT.bad}>
              <TimelineContent><b>Dispute opened</b></TimelineContent>
              <TimelineTime dateTime={d.opened_at}>{`${day(d.opened_at)} · ${d.reason_text}`}</TimelineTime>
            </TimelineItem>
            {needsResponse && d.respond_by && (
              <TimelineItem className={DOT.info}>
                <TimelineContent><b>Evidence due</b></TimelineContent>
                <TimelineTime dateTime={d.respond_by}>{`${day(d.respond_by)}${left ? ` · ${left.text}` : ''}`}</TimelineTime>
              </TimelineItem>
            )}
            {sent && (
              <TimelineItem className={DOT.done}>
                <TimelineContent><b>Evidence submitted</b></TimelineContent>
                <TimelineTime dateTime={sent.at ?? undefined}>{`${sent.at ? `${day(sent.at)} · ` : ''}Under review by the card network`}</TimelineTime>
              </TimelineItem>
            )}
            {d.outcome === 'won' && (
              <TimelineItem className={DOT.done}>
                <TimelineContent><b>Dispute won</b></TimelineContent>
                <TimelineTime dateTime={d.closed_at ?? undefined}>{`${d.closed_at ? `${day(d.closed_at)} · ` : ''}Funds returned to you`}</TimelineTime>
              </TimelineItem>
            )}
          </Timeline>
        </div>
      </DrawerBody>

      <SheetFooter>
        {data.can_edit && (
          <Button type="button" onClick={() => host.push({ kind: 'respond', id: d.id })}>Respond</Button>
        )}
        <DrawerCloseButton />
      </SheetFooter>

      {preview !== null && files.length > 0 && (
        <EvidencePreviewDialog disputeId={d.id} files={files} start={preview} onClose={() => setPreview(null)} returnFocusTo={opener} />
      )}
    </>
  );
}

