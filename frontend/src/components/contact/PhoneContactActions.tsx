import { useId } from 'react';
import { Link } from 'react-router-dom';
import { MessageSquare, Phone } from 'lucide-react';

import { requestCall } from '@/lib/communication/phoneTabHandoff';
import type { DialerEntityContext } from '@/stores/dialer.store';
import { ActionLink } from '@/components/ui/action-link';
import { Button } from '@/ui-kit/components/ui/button';
import { PhoneValue } from './CustomerContactBlock';
import { smsHref, telHref, textPath } from './contactHrefs';
import { useContactPolicyInput } from './useContactPolicyInput';
import { CALL_NOT_SET_UP_MESSAGE, phoneDisplay, type PhoneKind } from './contactDisplayPolicy';

interface PhoneContactActionsProps {
  kind: PhoneKind;
  phone: string;
  extension?: string | null;
  /** Who it is, for accessible names ("Call Dana Reyes"). */
  name: string;
  /** The record the number is tapped from, so a call lands on it. */
  context?: DialerEntityContext;
  /** The buttons' look. */
  variant?: 'ghost' | 'outline';
}

/**
 * Call and Text icon buttons for one phone on a compact surface (the job's crew card, the schedule's visit
 * editor), drawn through the contact display policy (Roles & Permissions, PRD 5). The policy decides, from the
 * person's switches and the company's phone service: the in-app dialer and composer, the device's own links, a
 * disabled Call with the plain "not set up" message, or no action at all.
 *
 * When the policy leaves no way to place the call from the app or the device, the number itself is shown, so the
 * person can still dial it by hand: selectable and copyable only as far as the policy says. A crew phone is not
 * customer data, so the copy switches never touch it; a customer's number Text opens the customer's thread.
 */
export function PhoneContactActions({ kind, phone, extension, name, context, variant = 'ghost' }: PhoneContactActionsProps) {
  const policy = useContactPolicyInput();
  const noticeId = useId();
  const d = phoneDisplay(kind, phone, extension, policy);
  const textTarget =
    kind === 'customer_phone' ? textPath(phone, context, { viewCustomers: policy.switches.viewCustomers }) : textPath(phone);

  const call =
    d.call === 'in_app_dial' ? (
      <Button variant={variant} size="icon-sm" aria-label={`Call ${name}`} onClick={() => requestCall(phone, context)}>
        <Phone aria-hidden />
      </Button>
    ) : d.call === 'native_link' ? (
      <Button variant={variant} size="icon-sm" aria-label={`Call ${name}`} asChild>
        <ActionLink href={telHref(phone)}>
          <Phone aria-hidden />
        </ActionLink>
      </Button>
    ) : d.call === 'disabled' ? (
      <Button variant={variant} size="icon-sm" aria-label={`Call ${name}`} disabled aria-describedby={noticeId}>
        <Phone aria-hidden />
      </Button>
    ) : null;

  const text =
    d.textAction === 'in_app_text' ? (
      <Button variant={variant} size="icon-sm" aria-label={`Text ${name}`} asChild>
        <Link to={textTarget}>
          <MessageSquare aria-hidden />
        </Link>
      </Button>
    ) : d.textAction === 'native_link' ? (
      <Button variant={variant} size="icon-sm" aria-label={`Text ${name}`} asChild>
        <ActionLink href={smsHref(phone)}>
          <MessageSquare aria-hidden />
        </ActionLink>
      </Button>
    ) : null;

  // No call to place: the digits stay on screen to dial by hand.
  const canPlaceCall = d.call === 'in_app_dial' || d.call === 'native_link';

  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-1.5">
      {!canPlaceCall && <PhoneValue kind={kind} phone={phone} extension={extension} name={name} context={context} />}
      {call}
      {text}
      {d.call === 'disabled' && (
        <span id={noticeId} className="text-text-secondary basis-full text-xs">
          {CALL_NOT_SET_UP_MESSAGE}
        </span>
      )}
    </span>
  );
}
