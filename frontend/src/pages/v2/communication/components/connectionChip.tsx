import { Badge } from '@/ui-kit/components/ui/badge';
import { cn } from '@/ui-kit/lib/utils';

/**
 * Whether a communication channel is wired up to a real provider.
 *
 * `degraded` is the middle state every channel has one of: a Gmail account that
 * still exists but needs re-consent, a number that is provisioned but not
 * verified. It is not "connected" and it is not "off", and collapsing it into
 * either one loses the only state the user can actually act on.
 */
export type ConnectionState = 'connected' | 'degraded' | 'disconnected';

const TONE: Record<ConnectionState, { badge: 'softGreen' | 'softAmber' | 'softRed'; dot: string }> = {
  connected: { badge: 'softGreen', dot: 'bg-status-green' },
  degraded: { badge: 'softAmber', dot: 'bg-status-amber' },
  disconnected: { badge: 'softRed', dot: 'bg-status-red' },
};

/**
 * The connection state of a comms channel, as a chip that belongs to the PAGE
 * TITLE rather than to the action row.
 *
 * Both things about it were wrong before. It sat in `PageHeader actions`,
 * shoulder to shoulder with Compose - a status readout parked in the row of
 * things you can press, where it reads as a disabled button. And every state
 * rendered `softNeutral`: "Not connected" and "No mailbox connected" came out
 * the same grey as a record count, so the one thing the chip exists to say -
 * this channel is not actually sending anything - was the one thing it did not
 * say. Only the happy path was ever coloured, which is backwards; green is the
 * state that needs no attention.
 *
 * So: red when the channel is off, amber when it needs re-consent, green when
 * it is live, and mounted next to the heading it describes.
 */
export function ConnectionChip({
  state,
  label,
  className,
}: {
  state: ConnectionState;
  label: string;
  className?: string;
}) {
  const tone = TONE[state];
  return (
    <Badge
      variant={tone.badge}
      size="pill"
      // Not `aria-label`: the visible text already says it. The role makes the
      // chip announce itself when it FLIPS - a mailbox dropping out mid-session
      // is exactly the moment a screen-reader user needs to hear about it.
      role="status"
      // No appearance classes: Badge already ships the weight, the gap and the
      // shrink this needs, and the component-API ratchet counts anything added
      // here as appearance taken back by the call site.
      className={className}
    >
      <span aria-hidden className={cn('size-1.5 rounded-full', tone.dot)} />
      {label}
    </Badge>
  );
}
