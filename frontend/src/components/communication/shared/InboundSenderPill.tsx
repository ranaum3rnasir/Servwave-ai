/**
 * Inbound sender pill (email slice 6) - the one place a RECEIVED email's sender
 * verdict gets painted. Routes through the `inboundSender` status-registry
 * domain + StatusBadge, exactly as EmailDeliveryPill does for the outbound
 * delivery lifecycle; the two are mirror images across the same message list.
 *
 * WHY THIS EXISTS AT ALL. A reply address is a bearer token: anyone who can
 * read the email can reply, and mail is forwarded all the time. So the app
 * knows three genuinely different things about an inbound message's sender, and
 * the whole point of this pill is that they must not look alike:
 *
 *   - PASS                    the From domain was cryptographically established
 *   - NO_POLICY / UNAVAILABLE the address matched a stored string, nothing more
 *   - FAIL                    the From was forged, and we said so
 *
 * Rendering the middle case as "verified" is precisely the dishonesty this plan
 * set out to remove from the outbound side, so it is not repeated here. The
 * registry gives those two a neutral intent and a label that names what is
 * missing.
 *
 * Renders NOTHING for an outbound row (no verdict) - same omit-if-absent
 * contract as every other message-metadata field.
 */
import { StatusBadge } from '@/components/data/status-badge';

export interface InboundSenderPillProps {
  /** Email.inboundAuth. Absent on every outbound row, and on inbound rows that
   *  predate this slice - nothing to claim either way, so nothing renders. */
  verdict?: string;
  /** Email.inboundMatch. Only used to sharpen the tooltip: a FAIL that we also
   *  refused to attach is a different operator story from one we did. */
  match?: string;
  className?: string;
}

/** Why the badge says what it says, in a sentence an operator can act on. */
function explain(verdict: string, match?: string): string {
  if (verdict === 'PASS') {
    return 'DMARC confirmed this message really came from the sender\'s domain.';
  }
  if (verdict === 'FAIL') {
    return match === 'MATCHED'
      ? 'DMARC says this sender address was forged. It was linked to this conversation by hand.'
      : 'DMARC says this sender address was forged, so it was not attached to a conversation.';
  }
  if (verdict === 'NO_POLICY') {
    return 'The address matches the one we wrote to, but the sender\'s domain publishes no DMARC record, so that could not be confirmed.';
  }
  return 'The address matches the one we wrote to, but no sender check was available for this message.';
}

export function InboundSenderPill({ verdict, match, className }: InboundSenderPillProps) {
  if (!verdict) return null;
  return (
    <span title={explain(verdict, match)} className={className}>
      <StatusBadge domain="inboundSender" status={verdict} />
    </span>
  );
}
