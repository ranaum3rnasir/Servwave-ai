import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { cn } from '@/lib/utils';
import { useContactPolicyInput } from './useContactPolicyInput';
import { customerEmailDisplay, customerNameDisplay, phoneDisplay } from './contactDisplayPolicy';

/**
 * A customer's number, email and name as plain text, drawn through the contact display policy (Roles &
 * Permissions, PRD 5). For the dense Communication surfaces (call log rows and detail, text inbox, the dialer's
 * caller match), where a value is read, not tapped: those screens carry their own Call, Text and Call back
 * controls, and a row that opens a detail panel cannot hold a menu of its own. `PhoneValue` and `EmailValue` in
 * the customer contact block are the tappable kind.
 *
 * Nothing here decides what a value may do: `contactDisplayPolicy` does. The digits (or the address) always stay
 * in the text, so a screen reader still reads them; only selecting and copying them follows the switch.
 */

/** A value the policy says cannot be selected: no selection, and Copy leaves nothing on the clipboard. */
export const NOT_SELECTABLE = 'select-none';
export const blockCopy = (e: { preventDefault: () => void }) => e.preventDefault();

/**
 * The other party's number on a call or text, which is a customer phone. `children` is the text the screen
 * already shows for it (each surface formats its own); without it the policy's own formatting is used.
 */
export function CustomerPhoneText({ phone, children, className }: { phone: string; children?: ReactNode; className?: string }) {
  const policy = useContactPolicyInput();
  const d = phoneDisplay('customer_phone', phone, null, policy);
  return (
    <span className={cn(!d.selectable && NOT_SELECTABLE, className)} onCopy={d.selectable ? undefined : blockCopy}>
      {children ?? d.text}
    </span>
  );
}

/**
 * A customer's email shown as text, which is a customer email: a matched customer's on a Communication surface, the
 * customer row's second line in top search. `children` is the text the screen already shows for it (top search
 * highlights the matched part); without it the address itself is shown.
 */
export function CustomerEmailText({ email, children, className }: { email: string; children?: ReactNode; className?: string }) {
  const policy = useContactPolicyInput();
  const d = customerEmailDisplay(email, policy);
  return (
    <span className={cn(!d.selectable && NOT_SELECTABLE, className)} onCopy={d.selectable ? undefined : blockCopy}>
      {children ?? d.text}
    </span>
  );
}

/**
 * A matched customer's name: a link to the customer's page for a person who may open it (View customers), plain
 * text for everyone else. Without a customer id there is no page to link to.
 */
export function CustomerNameText({ customerId, name, className }: { customerId?: string | null; name: string; className?: string }) {
  const policy = useContactPolicyInput();
  if (customerId && customerNameDisplay(policy).link) {
    return (
      <Link to={`/customers/${customerId}`} className={cn('hover:underline', className)}>
        {name}
      </Link>
    );
  }
  return <span className={className}>{name}</span>;
}
