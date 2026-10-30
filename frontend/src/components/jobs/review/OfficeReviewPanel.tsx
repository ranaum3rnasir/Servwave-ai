import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { Heading } from '@/ui-kit/components/ui/heading';
import { Skeleton } from '@/ui-kit/components/ui/skeleton';
import {
  Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle,
} from '@/ui-kit/components/ui/sheet';
import { extractApiError, formatCurrency } from '@/lib/utils';
import { RequiredToggleGroup } from '@/components/ui/required-toggle-group';
import { ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  useCheckReviewItem, useDecideCustomerItem, useFinishReview, useMarkAllChecked,
  type JobReview, type ReviewCheckRequest, type ReviewChoice, type ReviewDecisionRequest, type ReviewGroup, type ReviewItem, type ReviewSummary,
} from '@/lib/api/jobReview';
import { STATUS_REGISTRY } from '@/design-system/status-registry';
import { APPLIED_AT_FINISH, byAndWhen, CHOICE_LABEL, CUSTOMER_ONE_BY_ONE, countLeft, markAllRequest, plural, REMOVED_NOTHING_APPLIED, reviewCounts, shortDate, unusualChips, whatIsLeft } from './reviewWording';

/**
 * The office review panel (Roles & Permissions, PRD 6, S06.8): a drawer that slides in from the right and leaves the job
 * visible. The job summary comes first, whether or not anything changed, then the groups of what changed during the job.
 *
 * Built to hold a job with a hundred changes: the header stays pinned, the body is the one scrolling region, every group
 * collapses and shows its first rows with a "Show more" for the rest, and a long list inside the summary (lines, visits,
 * invoices) is bounded the same way. Nothing here can push the panel's own header off screen.
 *
 * Checks (S06.10): the job summary and every item that is not a customer change has a light "Check" button. The pinned
 * footer holds Mark all checked, the note that customer changes are confirmed one by one, and a short "what is left" line
 * that names a few items and counts the rest. Finish review (S06.12) sits in the same footer, disabled until nothing is left
 * and pointing at that line; the footer never grows with the number of items. A customer item (S06.11) is ticked by its own button instead, which records
 * the choice its control shows; changing the choice after the tick keeps it ticked with the new choice.
 */

/** How many rows a group, or a list in the summary, draws before "Show more"; and how many each press adds. */
export const FIRST_ROWS = 25;
export const MORE_ROWS = 50;
const SUMMARY_ROWS = 8;
/** A group with more rows than this starts collapsed, so a long one does not bury the groups under it. */
const OPEN_BY_DEFAULT_UP_TO = 10;

export interface OfficeReviewPanelProps {
  jobId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jobNumber: string;
  review: JobReview | undefined;
  isLoading: boolean;
  hasError: boolean;
  onRetry: () => void;
  /** The job's own answer lists Finish review for this person. */
  canFinish: boolean;
}

export function OfficeReviewPanel({ jobId, open, onOpenChange, jobNumber, review, isLoading, hasError, onRetry, canFinish }: OfficeReviewPanelProps) {
  const chips = review ? unusualChips(review) : [];
  const groups = review?.groups.filter((g) => g.items.length > 0) ?? [];
  const checkItem = useCheckReviewItem(jobId);
  const markAll = useMarkAllChecked(jobId);
  const decide = useDecideCustomerItem(jobId);
  const finish = useFinishReview(jobId);
  const saving = checkItem.isPending || markAll.isPending || decide.isPending || finish.isPending;
  // Doing anything else on the review clears the last refusal of Finish review: it was about the review as it was.
  const check = (request: ReviewCheckRequest) => { finish.reset(); checkItem.mutate(request); };
  // A pick not yet ticked is held here, by item, so an item listed twice (also under "Unusual items") shows one choice.
  const [picks, setPicks] = useState<Record<string, ReviewChoice>>({});
  const customer: CustomerControls = {
    picks,
    onPick: (key, choice) => setPicks((p) => ({ ...p, [key]: choice })),
    onDecide: (request) => { finish.reset(); decide.mutate(request); },
  };
  const toCheck = review ? markAllRequest(review) : [];
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" intent="content" aria-describedby="office-review-count" className="gap-0 sm:w-[min(34rem,100vw)]">
        <SheetHeader>
          <SheetTitle>Office review</SheetTitle>
          <SheetDescription id="office-review-count">
            {review ? `${jobNumber} · ${reviewCounts(review.totals)}` : jobNumber}
          </SheetDescription>
          {chips.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {chips.map((chip) => (
                <Badge key={chip.kind} variant="softAmber" size="sm">{chip.text}</Badge>
              ))}
            </div>
          )}
        </SheetHeader>
        <SheetBody className="flex flex-col gap-5">
          {isLoading && !review && <PanelSkeleton />}
          {hasError && !review && (
            <div className="flex flex-col items-start gap-2" role="alert">
              <p className="text-sm">The review could not be loaded.</p>
              <Button size="sm" variant="outline" onClick={onRetry}>Try again</Button>
            </div>
          )}
          {review && (
            <>
              <SummarySection summary={review.summary} saving={saving} onCheck={check} />
              {groups.length === 0 && (
                <p className="text-muted-foreground text-sm">Nothing was changed on this job. Read the job details above and check them.</p>
              )}
              {groups.map((group) => (
                <GroupSection key={group.key} group={group} saving={saving} onCheck={check} customer={customer} />
              ))}
            </>
          )}
        </SheetBody>
        {review && (
          <SheetFooter className="flex-col items-stretch justify-start gap-2">
            <p id="office-review-left" className="text-sm break-words" aria-live="polite">{whatIsLeft(review)}</p>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <Button size="sm" variant="outline" disabled={saving || toCheck.length === 0} onClick={() => { finish.reset(); markAll.mutate(toCheck); }}>
                Mark all checked
              </Button>
              <p className="text-muted-foreground text-xs">{CUSTOMER_ONE_BY_ONE}</p>
            </div>
            {finish.isError && (
              <p role="alert" className="text-destructive text-sm break-words">
                {extractApiError(finish.error, 'The review could not be finished. Try again in a moment.')}
              </p>
            )}
            {canFinish && (
              <Button
                className="w-full sm:w-auto sm:self-end"
                disabled={saving || countLeft(review) > 0}
                aria-describedby="office-review-left"
                onClick={() => finish.mutate(review.version, { onSuccess: () => onOpenChange(false) })}
              >
                Finish review
              </Button>
            )}
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  );
}

function PanelSkeleton() {
  return (
    <div className="flex flex-col gap-3" role="status" aria-label="Loading the review">
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-6 w-32" />
      <Skeleton className="h-16 w-full" />
    </div>
  );
}

// ─── The job summary ───────────────────────────────────

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

/** A list that draws its first rows and a "Show more" for the rest. */
function BoundedList<T>({ items, first, label, render }: { items: readonly T[]; first: number; label: string; render: (item: T, index: number) => ReactNode }) {
  const [shown, setShown] = useState(first);
  const visible = items.slice(0, shown);
  const left = items.length - visible.length;
  return (
    <>
      <ul className="flex flex-col gap-1.5">{visible.map((item, i) => render(item, i))}</ul>
      {left > 0 && (
        <Button size="sm" variant="ghost" className="mt-1 self-start" onClick={() => setShown((n) => n + MORE_ROWS)}>
          {`Show ${Math.min(left, MORE_ROWS)} more ${label}`}
        </Button>
      )}
    </>
  );
}

function visitLine(v: ReviewSummary['visits'][number]): string {
  const when = shortDate(v.scheduled_at);
  if (v.outcome === 'finished') return `Visit ${v.seq}, ${when}: finished${v.finished_by ? ` by ${v.finished_by}` : ''}`;
  if (v.outcome === 'cancelled') return `Visit ${v.seq}, ${when}: ${v.cancelled_by_complete ? 'cancelled when the job was completed' : 'cancelled'}`;
  return `Visit ${v.seq}, ${when}: still open`;
}

/** The light check of one item: "Check" until it is checked, who checked it once it is. */
function CheckButton({ title, entryId, itemKey, saving, onCheck }: { title: string; entryId: string | null; itemKey: string; saving: boolean; onCheck: (request: ReviewCheckRequest) => void }) {
  return (
    <Button size="sm" variant="outline" aria-label={`Check ${title}`} disabled={saving || entryId === null} onClick={() => entryId && onCheck({ item_key: itemKey, entry_id: entryId })}>
      Check
    </Button>
  );
}

function SummarySection({ summary, saving, onCheck }: { summary: ReviewSummary; saving: boolean; onCheck: (request: ReviewCheckRequest) => void }) {
  const showCosts = summary.total_cost !== undefined;
  return (
    <section aria-label="Job details" className="border-border bg-muted/40 flex flex-col gap-3 rounded-lg border p-3.5">
      <div className="flex items-center justify-between gap-2">
        <Heading level={3} scale="base">Job details</Heading>
        {summary.checked ? (
          <span className="text-muted-foreground text-xs">{`Checked${summary.checked_by ? ` by ${summary.checked_by}` : ''}`}</span>
        ) : (
          <CheckButton title="Job details" itemKey={summary.key} entryId={summary.latest_entry_id} saving={saving} onCheck={onCheck} />
        )}
      </div>
      <dl className="flex flex-col gap-2">
        <Field label="Customer">
          {summary.customer.name}
          {summary.customer.company_name ? <span className="text-muted-foreground">{`, ${summary.customer.company_name}`}</span> : null}
        </Field>
        <Field label="Service address">{summary.service_address ?? 'No address'}</Field>
        <Field label="Job type">{summary.job_type ?? 'Not set'}</Field>
        <Field label="Visits">
          {summary.visits.length === 0 ? 'No visits' : (
            <BoundedList items={summary.visits} first={SUMMARY_ROWS} label="visits" render={(v) => (
              <li key={v.seq}>
                <span>{visitLine(v)}</span>
                {v.crew.length > 0 && <span className="text-muted-foreground block text-xs">{`Crew: ${v.crew.join(', ')}`}</span>}
              </li>
            )} />
          )}
        </Field>
        <Field label="Lines">
          {summary.lines.length === 0 ? 'No lines' : (
            <BoundedList items={summary.lines} first={SUMMARY_ROWS} label="lines" render={(l, i) => (
              <li key={`${l.name}-${i}`} className="flex items-baseline justify-between gap-3">
                <span className="min-w-0">
                  {`${l.name} x ${l.quantity}`}
                  {l.unit_cost != null && <span className="text-muted-foreground block text-xs">{`Cost ${formatCurrency(l.unit_cost)} each`}</span>}
                </span>
                <span className="shrink-0 tabular-nums">{formatCurrency(l.line_total)}</span>
              </li>
            )} />
          )}
        </Field>
        <Field label="Total">
          <span className="tabular-nums">
            {formatCurrency(summary.total)}
            {summary.discount_amount > 0 && <span className="text-muted-foreground">{`, after a ${formatCurrency(summary.discount_amount)} discount`}</span>}
          </span>
          {showCosts && summary.total_cost != null && (
            <span className="text-muted-foreground block text-xs tabular-nums">{`Cost ${formatCurrency(summary.total_cost)}`}</span>
          )}
        </Field>
        <Field label="Invoices">
          {summary.invoices.length === 0 ? 'No invoices' : (
            <BoundedList items={summary.invoices} first={SUMMARY_ROWS} label="invoices" render={(inv) => (
              <li key={inv.invoice_number} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span>{inv.invoice_number}</span>
                <Badge variant="softNeutral" size="sm">{STATUS_REGISTRY.invoice[inv.status]?.label ?? inv.status}</Badge>
                <span className="text-muted-foreground tabular-nums">{`${formatCurrency(inv.total)}, ${formatCurrency(inv.amount_due)} due`}</span>
              </li>
            )} />
          )}
        </Field>
        <Field label="Balance">
          <span className="tabular-nums">{summary.balance == null ? 'No total yet' : formatCurrency(summary.balance)}</span>
        </Field>
        <Field label="Files and notes">{`${plural(summary.file_count, 'file')}, ${plural(summary.note_count, 'note')}`}</Field>
      </dl>
    </section>
  );
}

// ─── The groups ────────────────────────────────────────

/**
 * The choice and the tick of a customer item. The control starts on the choice the server says to show (the default, or an
 * earlier pick); until the item is ticked a different pick is only held here, and the tick sends the choice shown. Once
 * it is ticked, a different pick is sent at once and the item stays ticked with the new choice.
 */
interface CustomerControls {
  picks: Record<string, ReviewChoice>;
  onPick: (itemKey: string, choice: ReviewChoice) => void;
  onDecide: (request: ReviewDecisionRequest) => void;
}

function CustomerDecision({ item, contact, saving, customer }: { item: ReviewItem; contact: NonNullable<ReviewItem['contact']>; saving: boolean; customer: CustomerControls }) {
  const hasChoice = contact.options.length > 0;
  const shown = contact.options.find((o) => o === customer.picks[item.key]) ?? contact.choice;
  const onDecide = customer.onDecide;
  const send = (choice: ReviewChoice | null) => onDecide({ item_key: item.key, entry_id: item.latest_entry_id, ...(choice ? { choice } : {}) });
  return (
    <div className="flex flex-col gap-2">
      {contact.customer_current !== null && (
        <p className="text-muted-foreground text-xs break-words">{`The customer's value now: ${contact.customer_current || 'none'}`}</p>
      )}
      {hasChoice ? (
        <RequiredToggleGroup
          variant="pill"
          className="flex-wrap"
          aria-label={`What to do with ${item.title}: ${item.summary}`}
          value={shown ?? ''}
          disabled={saving}
          onValueChange={(next) => {
            const choice = next as ReviewChoice;
            customer.onPick(item.key, choice);
            if (item.checked) send(choice);
          }}
        >
          {contact.options.map((option) => (
            <ToggleGroupItem key={option} value={option} variant="pill" className="min-h-9">{CHOICE_LABEL[option]}</ToggleGroupItem>
          ))}
        </RequiredToggleGroup>
      ) : (
        <p className="text-muted-foreground text-xs">{REMOVED_NOTHING_APPLIED}</p>
      )}
      {item.checked ? (
        <p className="text-muted-foreground text-xs">{APPLIED_AT_FINISH}</p>
      ) : (
        <Button size="sm" variant="outline" className="self-start" aria-label={`Check ${item.title}: ${item.summary}`} disabled={saving} onClick={() => send(hasChoice ? shown : null)}>
          Check
        </Button>
      )}
    </div>
  );
}

function ItemRow({ item, saving, onCheck, customer }: { item: ReviewItem; saving: boolean; onCheck: (request: ReviewCheckRequest) => void; customer: CustomerControls }) {
  return (
    <li className="border-border bg-kit-card flex flex-col gap-1 rounded-md border p-3">
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 text-sm font-medium break-words">{item.title}</p>
        <div className="flex shrink-0 flex-wrap justify-end gap-1">
          {item.unusual && item.unusual_reason && (
            <Badge variant="softAmber" size="sm">{item.unusual_reason}</Badge>
          )}
          {item.checked && <Badge variant="softGreen" size="sm">Checked</Badge>}
        </div>
      </div>
      <p className="text-sm break-words">{item.summary}</p>
      {item.contact && <CustomerDecision item={item} contact={item.contact} saving={saving} customer={customer} />}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground text-xs">{byAndWhen(item.by, item.at)}</p>
        {/* A customer change is ticked by its decision above, never by a plain check. */}
        {!item.checked && item.kind !== 'contact' && (
          <CheckButton title={item.title} itemKey={item.key} entryId={item.latest_entry_id} saving={saving} onCheck={onCheck} />
        )}
        {item.checked && item.checked_by && <p className="text-muted-foreground text-xs">{`Checked by ${item.checked_by}`}</p>}
      </div>
    </li>
  );
}

function GroupSection({ group, saving, onCheck, customer }: { group: ReviewGroup; saving: boolean; onCheck: (request: ReviewCheckRequest) => void; customer: CustomerControls }) {
  const [open, setOpen] = useState(group.key === 'unusual' || group.items.length <= OPEN_BY_DEFAULT_UP_TO);
  const [shown, setShown] = useState(FIRST_ROWS);
  const bodyId = `review-group-${group.key}`;
  const visible = group.items.slice(0, shown);
  const left = group.items.length - visible.length;
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <section aria-label={group.label} className="flex flex-col gap-2">
      <Button
        variant="ghost"
        size="sm"
        className="-mx-2 h-auto min-h-8.5 justify-start gap-2 px-2 py-1"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((o) => !o)}
      >
        <Chevron aria-hidden className="size-4 shrink-0" />
        <span className="text-sm font-semibold">{group.label}</span>
        <Badge variant="softNeutral" size="sm">{group.items.length}</Badge>
      </Button>
      {open && (
        <div id={bodyId} className="flex flex-col gap-2">
          <ul className="flex flex-col gap-2">
            {visible.map((item) => <ItemRow key={item.key} item={item} saving={saving} onCheck={onCheck} customer={customer} />)}
          </ul>
          {left > 0 && (
            <Button size="sm" variant="outline" className="self-start" onClick={() => setShown((n) => n + MORE_ROWS)}>
              {`Show ${Math.min(left, MORE_ROWS)} more (${left} left)`}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
