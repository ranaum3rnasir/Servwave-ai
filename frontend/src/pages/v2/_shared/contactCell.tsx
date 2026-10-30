import { isPlaceholderEmail, isPlaceholderPhone } from '@/lib/placeholders';
import type { DialerEntityContext } from '@/stores/dialer.store';
import { EmailValue, PhoneValue } from '@/components/contact/CustomerContactBlock';

interface ContactCellProps {
  value: string | null | undefined;
  type: 'phone' | 'email';
  /** The record the row is, so a call placed from the cell is attributed to it (phone cells). */
  context?: DialerEntityContext;
}

/**
 * Table contact cell: a customer's phone or email, drawn through the contact display policy (Roles &
 * Permissions, PRD 5). The policy, from the person's switches and the company's phone service, decides
 * everything the value can do: with Copy customer phone (or email) off the value is digits (or an
 * address) that cannot be selected, copied or tapped through a native link, and has no copy button; on,
 * it has the hover copy button. A phone offers Call or Text in the app when the company has the phone
 * service and the person may contact customers; an email is a mail link.
 *
 * A tap on the value or its copy button stops propagation so the row click does not also fire.
 *
 * IT HAS TO BE ABLE TO SHRINK, AND IT HAS TO TRUNCATE ITSELF.
 *
 * The kit Button is `inline-flex` + `whitespace-nowrap`, so the value inside it
 * can never wrap, and `break-words` on the surrounding `<td>` is powerless
 * against nowrap text. An unbroken email address is also the widest thing a
 * contact column ever holds. Left alone the run was: the Button refuses to wrap,
 * so this wrapper's min-content size equals the whole address, so its
 * shrink-to-fit width exceeds the column, and the cell does not clip - the text
 * rendered outside the Email column and painted straight over the Address values
 * beside it.
 *
 * `min-w-0` on the Button is the load-bearing part. A flex item's default
 * `min-width: auto` is what makes "shrink to fit the column" impossible, and
 * until it is zeroed the inner `truncate` never gets a constrained box to
 * ellipsise against - which is why a `truncate` alone would have looked like it
 * did nothing. `max-w-full` then clamps the wrapper to the cell's content box
 * from the outside as well, so containment does not rest on shrink-to-fit alone,
 * and `shrink-0` on the copy control makes the VALUE yield the width rather than
 * the button.
 *
 * The wrapper stays `inline-flex`: the DataTable reuses these cell renderers in
 * its phone card layout inside a right-aligned `<dd>`, and a block-level `flex`
 * would fill that box and drag the value back to the left of every other value
 * in the card.
 */
export function ContactCell({ value, type, context }: ContactCellProps) {
  if (!value) return null;
  if (type === 'phone' && isPlaceholderPhone(value)) return null;
  if (type === 'email' && isPlaceholderEmail(value)) return null;

  return (
    // The sheet a phone tap opens is portalled, but React still bubbles its clicks to this span, which keeps a
    // clickable row around the cell from also firing.
    <span className="group inline-flex max-w-full min-w-0 items-center" onClick={(e) => e.stopPropagation()}>
      {type === 'phone' ? (
        <PhoneValue kind="customer_phone" phone={value} context={context} name={context?.customerName} inCell />
      ) : (
        <EmailValue email={value} inCell />
      )}
    </span>
  );
}
