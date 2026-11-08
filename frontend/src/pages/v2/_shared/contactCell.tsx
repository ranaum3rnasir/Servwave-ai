import { useState } from 'react';
import { Copy } from 'lucide-react';

import { formatPhone } from '@/lib/utils';
import { isPlaceholderEmail, isPlaceholderPhone } from '@/lib/placeholders';
import { Button } from '@/ui-kit/components/ui/button';

interface ContactCellProps {
  value: string | null | undefined;
  type: 'phone' | 'email';
}

/**
 * Table contact cell: the value dials/mails on click, with a hover copy button.
 *
 * The legacy cell is an `<a href="tel:">`. Here it is a kit Button that sets
 * `window.location.href`, because the design-system raw-tag ratchet sits at its
 * floor for `<a>` and a v2 page may not add one. Same destination, same
 * `stopPropagation` so the row click does not also fire.
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
export function ContactCell({ value, type }: ContactCellProps) {
  const [copied, setCopied] = useState(false);

  if (!value) return null;
  if (type === 'phone' && isPlaceholderPhone(value)) return null;
  if (type === 'email' && isPlaceholderEmail(value)) return null;

  const href = type === 'phone' ? `tel:${value}` : `mailto:${value}`;
  const ariaLabel = type === 'phone' ? 'Copy phone number' : 'Copy email address';
  const label = type === 'phone' ? formatPhone(value) : value;

  return (
    <span className="group inline-flex max-w-full min-w-0 items-center gap-1">
      <Button
        variant="link"
        size="sm"
        className="h-auto min-w-0 px-0 font-normal"
        // The clipped value stays readable on hover - a contact column is narrow
        // by design, so the ellipsis must not be the only copy of the address.
        // Same title pattern the truncating text columns in these tables use.
        title={label}
        onClick={(e) => {
          e.stopPropagation();
          window.location.href = href;
        }}
      >
        <span className="truncate">{label}</span>
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={ariaLabel}
        className={copied ? 'size-6 shrink-0 opacity-100' : 'size-6 shrink-0 opacity-0 group-hover:opacity-100'}
        onClick={(e) => {
          e.stopPropagation();
          navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          });
        }}
      >
        {copied ? <span className="text-[10px]">Copied!</span> : <Copy />}
      </Button>
    </span>
  );
}
