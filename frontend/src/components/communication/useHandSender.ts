import { composeSenderProps, useSendingIdentity } from '@/lib/api/communication';
import { sendBlockedReason } from '@/components/communication/inbox/ComposeWindow';

/**
 * What a surface that sends a document by hand (an estimate, an invoice, a bulk send of either) takes from the sender's
 * identity (PRD 10, S10.12): the same read the compose windows use, so the "Sending as" line can never say something the
 * send does not do.
 *
 *   - `known`   whether the identity has arrived. Until it has, and for good while the company lacks the Email plan feature
 *               (the read is not asked then), a surface claims nothing: no line, and Send is as it always was. The server
 *               enforces the address either way.
 *   - `sender`  the address and name for the `SendingAsLine`, and whether the person has no address of their own yet.
 *   - `blockedReason`  why Send is disabled (no address of their own, or outgoing email switched off), else undefined.
 */
export function useHandSender() {
  const { data: identity } = useSendingIdentity();
  const sender = composeSenderProps(identity);
  return { known: identity !== undefined, sender, blockedReason: sendBlockedReason(sender) };
}
