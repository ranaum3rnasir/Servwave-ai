/**
 * Communication atoms — shared visual primitives for the communication ↔ jobs
 * surfaces (job Communication tab, SMS/Inbox/WhatsApp centers, customer roll-up).
 * Promoted from the validated /prototype/comm Variant A (chosen 2026-06-10).
 *
 * Color contract (ServWave "Calm Intelligence"):
 * - Job pill = OCEAN (interactive/navigational anchor), never sage.
 * - "no job" = muted background.
 * - StateChip = SAGE, reserved for genuine business state (Approved / Paid).
 */
import { type LucideIcon, Mail, MessageCircle, MessageSquare, PencilLine, Phone } from 'lucide-react';

export type CommChannel = 'call' | 'email' | 'sms' | 'whatsapp';

/**
 * Job badge — "badge it, don't hide it". Ocean (interactive anchor), NOT sage:
 * a job tag is navigational, not a business/approved state.
 */
export function JobBadge({ job, className = '' }: { job?: string | null; className?: string }) {
  if (!job) {
    return (
      <span
        className={`inline-flex items-center rounded-pill border border-border bg-background-light px-2 py-0.5 text-[11px] font-semibold text-text-soft ${className}`}
      >
        no job
      </span>
    );
  }
  return (
    <span
      className={`inline-flex items-center rounded-pill border border-primary/15 bg-primary-subtle px-2 py-0.5 text-[11px] font-semibold text-primary ${className}`}
    >
      {job}
    </span>
  );
}

/**
 * Lead badge — the lead-linkage sibling of JobBadge. Ocean-family informational
 * tone (lighter ocean-700 tint so it reads apart from the job pill), NEVER
 * sage: lead linkage is navigational, not a business/approved state. Renders
 * nothing when the row has no lead — the lead chip is additive (no "no lead"
 * counterpart to the muted no-job pill).
 */
export function LeadBadge({ lead, className = '' }: { lead?: string | null; className?: string }) {
  if (!lead) return null;
  return (
    <span
      className={`inline-flex items-center rounded-pill border border-ocean-700/20 bg-ocean-700/10 px-2 py-0.5 text-[11px] font-semibold text-ocean-700 ${className}`}
    >
      {lead}
    </span>
  );
}

const CH: Record<CommChannel, { Icon: LucideIcon; tint: string; label: string }> = {
  call: { Icon: Phone, tint: 'text-success-text', label: 'Call' },
  email: { Icon: Mail, tint: 'text-info', label: 'Email' },
  sms: { Icon: MessageSquare, tint: 'text-primary', label: 'Text' },
  whatsapp: { Icon: MessageCircle, tint: 'text-success-text', label: 'WhatsApp' },
};

/**
 * What the marker SAYS THIS IS NOT, per channel (slice 6). "Not a recorded call" on a logged
 * email would be the same category error the delivery pill makes: naming a platform artefact
 * that was never in play. The call wording is byte-unchanged — every entry logged before the
 * picker shipped is a call.
 */
const HAND_ENTERED_LABEL: Record<CommChannel, string> = {
  call: 'Hand-entered, not a recorded call',
  sms: 'Hand-entered, not a platform text',
  email: 'Hand-entered, not a platform email',
  // Not writable — the manual log's API offers three channels — but the table is total so a
  // future fourth cannot silently fall through to the call wording.
  whatsapp: 'Hand-entered, not a platform message',
};

/**
 * The channel icon, optionally carrying the manual communication log's hand-entered overlay.
 *
 * The "Logged" chip says it in words, at the far end of the meta line; this says it on the one
 * element a reader's eye lands on first when scanning a column of rows, so a hand-typed record
 * cannot be mistaken for a recorded call at a glance. Muted and small on purpose — it MARKS the
 * icon rather than replacing it, because the channel is still the primary fact.
 *
 * It carries an accessible name (`role="img"`), not merely a tint: this is a provenance marker,
 * and a marker only sighted users receive is not one.
 */
export function ChannelIcon({
  channel,
  handEntered = false,
  className = '',
}: {
  channel: CommChannel;
  handEntered?: boolean;
  className?: string;
}) {
  const { Icon, tint } = CH[channel];
  const icon = <Icon className={`h-4 w-4 ${tint} ${className}`} />;
  if (!handEntered) return icon;
  const label = HAND_ENTERED_LABEL[channel];
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className="relative inline-flex"
    >
      {icon}
      <PencilLine
        aria-hidden="true"
        className="absolute -bottom-1 -right-1 h-2.5 w-2.5 rounded-full bg-surface-light text-text-secondary"
      />
    </span>
  );
}

export function channelLabel(channel: CommChannel) {
  return CH[channel].label;
}

/** Business-state chip (sage) — the one legitimate sage use here: approved / paid. */
/**
 * Manual Communication Log (slice 1) — "this was typed in, not recorded".
 *
 * SAFETY-CRITICAL. A reader must never cite a hand-entered note as though it were a recorded
 * call, so every manually logged entry carries this. Deliberately MUTED and deliberately a chip:
 * the entry belongs in the chronology beside everything else, so it is not given a different row
 * background and not moved into a section of its own — it just must not be mistakable.
 *
 * Muted, and NOT StateChip's sage: sage is reserved for genuine business state (Approved / Paid)
 * and would read as an endorsement of the record's provenance, which is the opposite of what this
 * says.
 */
export function LoggedChip({ className = '' }: { className?: string }) {
  return (
    <span
      title="Logged by hand - not a recorded call"
      className={`inline-flex items-center rounded-pill border border-border bg-background-light px-2 py-0.5 text-[11px] font-medium text-text-secondary ${className}`}
    >
      Logged
    </span>
  );
}

export function StateChip({ state }: { state?: string | null }) {
  if (!state) return null;
  return (
    <span className="inline-flex items-center rounded-pill border border-sage-200 bg-sage-50 px-2 py-0.5 text-[11px] font-semibold text-sage-700">
      {state}
    </span>
  );
}
