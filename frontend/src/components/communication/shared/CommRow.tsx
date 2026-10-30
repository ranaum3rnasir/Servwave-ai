/**
 * Shared comm-timeline row (slice E6) — the single renderer behind the Job,
 * Customer and Lead page Communication tabs, consolidating their drifted
 * markup. Standard line:
 *
 *   channel icon · title [auto·transactional] [StateChip] ·············· time
 *   preview
 *   direction · who [· answered by X (calls)] [· meta] ··· [Logged][lead chip][job chip]
 *
 * Chips are navigable: the job pill links to /jobs/:id (via CommRowJobControl,
 * which upgrades call/sms/email pills to the attach/move/detach menu when gated) and
 * the NEW lead chip links to /leads/:id — each suppressing the self-link on
 * its own entity page. The hosting tab keeps its own list chrome + timestamp
 * formatter via props.
 */
import { Link } from 'react-router-dom';
import { cn, formatCurrency } from '@/lib/utils';
import { formatInstant } from '@/lib/schedule-tz';
import type { CommItem } from '@/lib/api/jobCommunications';
import { ChannelIcon, LeadBadge, LoggedChip, StateChip, UnverifiedSenderMark } from './atoms';
import { CommRowJobControl } from './CommRowJobControl';
import { EmailDeliveryPill } from './EmailDeliveryPill';

/** The hover tooltip behind the short timestamp — the exact moment, spelled out.
 *  Matches what `new Date(at).toLocaleString('en-US')` used to render, minus the
 *  viewer's zone. */
const FULL_TIMESTAMP: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
};

interface CommRowProps {
  item: CommItem;
  /** The hosting tab's timestamp formatter (relative on the job tab, absolute elsewhere). */
  formatTimestamp: (at: string) => string;
  /** Org zone for the exact-moment hover tooltip. Passed down rather than read
   *  here: a timeline renders one of these per message, and the tab that owns
   *  `formatTimestamp` has already resolved the zone. */
  tz: string;
  /** Job page id — its own rows show a plain job pill (no self-link). */
  currentJobId?: string;
  /** Lead page id — its own rows show a plain lead chip (no self-link). */
  currentLeadId?: string;
  /** Customer scope powering the attach/move/detach menu on call/sms/email rows. */
  customerId?: string;
  /** When set, the row becomes a button that opens the detail drawer. Chip
   *  clicks stop propagation, so navigating a job/lead pill never also opens it. */
  onSelect?: (item: CommItem) => void;
  /** Per-tab li chrome (padding / dividers / hover). */
  className?: string;
}

export function CommRow({
  item,
  formatTimestamp,
  tz,
  currentJobId,
  currentLeadId,
  customerId,
  onSelect,
  className,
}: CommRowProps) {
  /**
   * Manual Communication Log — who typed the entry, and who actually had the conversation.
   *
   * Naming the logger is what lets a reader tell an EYEWITNESS record from a SECOND-HAND one: the
   * feature's primary use case is an admin typing up months of conversations colleagues had, and
   * a row that named only one of the two would quietly claim the wrong thing.
   *
   * The performer is named only when it is somebody else. "Logged by Dana Reyes on behalf of Dana
   * Reyes" is not a smaller mistake than saying nothing — it invents a distinction that is not
   * there. Nothing renders at all without a logger name (a join that did not resolve); an
   * attribution line with a blank in it is worse than no attribution line.
   */
  const attribution = item.loggedByName
    ? item.performedByName && item.performedByName !== item.loggedByName
      ? `Logged by ${item.loggedByName} on behalf of ${item.performedByName}`
      : `Logged by ${item.loggedByName}`
    : null;

  // The customer's own action on their link (an estimate decision): an entry, not a conversation, so it says whose action
  // it was rather than which way a message went, and carries what they said in full.
  const isCustomerEntry = item.channel === 'portal';
  // A payment received on one of the record's invoices (S08.10): the amount and whether it was paid online or recorded by
  // the office, as the server worded it. Nothing in the row can be pressed, like the estimate decisions.
  const isPayment = item.entry === 'payment_received';

  const leadChip = item.leadLabel ? (
    item.leadId && item.leadId !== currentLeadId ? (
      <Link
        to={`/leads/${item.leadId}`}
        title={`Open ${item.leadLabel}`}
        className="rounded-pill transition hover:opacity-80"
      >
        <LeadBadge lead={item.leadLabel} />
      </Link>
    ) : (
      <LeadBadge lead={item.leadLabel} />
    )
  ) : null;

  return (
    <li
      className={cn(
        'flex gap-3',
        onSelect && 'cursor-pointer rounded-md transition hover:bg-background-light',
        className,
      )}
      onClick={onSelect ? () => onSelect(item) : undefined}
      onKeyDown={
        onSelect
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect(item);
              }
            }
          : undefined
      }
      role={onSelect ? 'button' : undefined}
      tabIndex={onSelect ? 0 : undefined}
    >
      <div className="mt-0.5">
        {/* Manual Communication Log — the hand-entered overlay states the same fact the "Logged"
            chip below states in words, on the element the eye lands on first. */}
        <ChannelIcon channel={item.channel} handEntered={item.manuallyLogged} payment={isPayment} />
      </div>
      <div className="min-w-0 flex-1">
        {/* Mobile slice 84 - below lg the line WRAPS, so the chip, the delivery pill and the time
            stay fully visible on a 320 px phone (the automatic payment receipt carries all three
            and measured 476 px on one line). Only the subject may shrink, by truncating; every
            other part is capped at the line width so none can overflow alone. From lg up the line
            is the single non-wrapping row it always was. */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 lg:flex-nowrap">
          <span className="min-w-0 max-w-full truncate text-sm font-semibold text-text-primary">{item.title}</span>
          {item.transactional && (
            <span className="max-w-full shrink-0 rounded-full bg-background-light px-1.5 py-0.5 text-[10px] font-medium text-text-secondary">
              auto · transactional
            </span>
          )}
          <StateChip state={item.state} />
          {/* Delivery fact (slice 5) — sent-email rows only. A bounce/failure
              must never render through StateChip's hardcoded sage; see
              CommItem.deliveryStatus's doc comment.

              …and PLATFORM rows only (slice 6). A delivery status is a claim about what
              ServWave's own mail transport did — it is written by the Resend webhook reporting
              on a message this product sent. A hand-typed record of an email somebody sent from
              Outlook has no such provenance, so it must never display one, whatever a payload
              happens to carry. */}
          {item.channel === 'email' && item.direction === 'out' && !item.manuallyLogged && (
            <EmailDeliveryPill
              status={item.deliveryStatus}
              reason={item.deliveryStatusReason}
              className="max-w-full shrink-0"
            />
          )}
          {/* A received email linked to this customer by its sender's address, the sender unproven (PRD 10, S10.20). */}
          {item.channel === 'email' && <UnverifiedSenderMark show={item.unverifiedSender} />}
          <span
            className="ml-auto max-w-full shrink-0 text-xs text-text-soft"
            title={formatInstant(item.at, tz, FULL_TIMESTAMP)}
          >
            {formatTimestamp(item.at)}
          </span>
        </div>
        {/* A call's preview line is its summary, which the server leaves empty without View transcript (S08.12). */}
        {isPayment ? (
          <p className="mt-0.5 text-sm text-text-secondary">
            {item.amount != null && <span className="font-medium">{formatCurrency(item.amount)}</span>}
            {item.amount != null && item.preview && ' · '}
            {item.preview && <span>{item.preview}</span>}
          </p>
        ) : isCustomerEntry ? (
          // The customer's reason and their own words, in full: an entry is read, never opened for more.
          (item.reason || item.reasonNote) && (
            <p className="mt-0.5 text-sm text-text-secondary">
              {item.reason && <span className="font-medium">{item.reason}</span>}
              {item.reason && item.reasonNote && ' · '}
              {item.reasonNote && <span>&ldquo;{item.reasonNote}&rdquo;</span>}
            </p>
          )
        ) : (
          item.preview && <p className="mt-0.5 truncate text-sm text-text-secondary">{item.preview}</p>
        )}
        <div className="mt-1 flex items-center gap-2 text-xs text-text-soft">
          <span className="truncate">
            <span className="text-text-secondary/70">
              {isPayment ? 'Payment' : isCustomerEntry ? 'Customer' : item.direction === 'in' ? 'Inbound' : 'Outbound'}
            </span>{' '}
            · {item.who}
          </span>
          {item.answeredBy && <span className="shrink-0">· answered by {item.answeredBy}</span>}
          {item.meta && <span className="shrink-0">· {item.meta}</span>}
          {attribution && <span className="shrink-0">· {attribution}</span>}
          <span
            className="ml-auto flex shrink-0 items-center gap-1.5"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Manual Communication Log - beside the existing lead and job chips, never in
                place of them: a logged entry still belongs to its lead. */}
            {item.manuallyLogged && <LoggedChip />}
            {leadChip}
            <CommRowJobControl item={item} customerId={customerId} currentJobId={currentJobId} />
          </span>
        </div>
      </div>
    </li>
  );
}
