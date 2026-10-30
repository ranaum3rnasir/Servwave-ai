import { ExternalLink, Mail, MessageSquare, Phone } from 'lucide-react';

import { ActionLink } from '@/components/ui/action-link';
import { NewTabLink } from '@/components/ui/new-tab-link';
import { usesBridgeTransport } from '@/lib/device/usesBridgeTransport';
import { requestCall } from '@/lib/communication/phoneTabHandoff';
import { cn } from '@/lib/utils';
import type { DialerEntityContext } from '@/stores/dialer.store';

import { composePath, smsHref, telHref, textPath, type ComposePathInput } from './contactHrefs';
import { phoneDisplay } from './contactDisplayPolicy';
import { useContactPolicyInput } from './useContactPolicyInput';
import { useCustomerChannels } from './useCustomerChannels';

/** A phone-only height so every button is 44px at 390px (the kit's own sizes are left alone). */
const TAP = 'max-md:min-h-11';
/** The dimmed look of a button that has nothing to act on ("No phone on file"). */
const DIMMED = 'cursor-not-allowed opacity-50';

function Dimmed({ icon, label, why }: { icon: React.ReactNode; label: string; why: string }) {
  return (
    <ActionLink variant="outline" asChild className={cn(TAP, DIMMED)}>
      {/* eslint-disable-next-line no-restricted-syntax -- ActionLink asChild is the kit's one outline look shared with the link buttons beside it */}
      <button type="button" aria-disabled="true" title={why} onClick={(e) => e.preventDefault()}>
        {icon}
        {label}
      </button>
    </ActionLink>
  );
}

export interface PhoneButtonsProps {
  /** Null when the customer has no phone: both buttons show dimmed. */
  phone: string | null;
  context: DialerEntityContext;
}

/**
 * Call and Text for a customer's phone, as labelled buttons. Both go through the contact display policy and open in a new
 * tab: Call opens (or reuses) the phone tab, or the in-page phone sheet on a phone-sized device; Text opens the
 * conversation. Buttons the person cannot use are left out; with no number they are dimmed, never hidden.
 */
export function CustomerPhoneActions({ phone, context }: PhoneButtonsProps) {
  const policy = useContactPolicyInput();
  const channels = useCustomerChannels();
  if (!phone) {
    return (
      <>
        <Dimmed icon={<Phone aria-hidden className="mr-1.5 size-4" />} label="Call" why="No phone on file" />
        <Dimmed icon={<MessageSquare aria-hidden className="mr-1.5 size-4" />} label="Text" why="No phone on file" />
      </>
    );
  }
  const d = phoneDisplay('customer_phone', phone, null, policy);
  // The in-page sheet on a phone-sized device opens no tab, so it carries no new-tab icon.
  const opensTab = !usesBridgeTransport();

  const call =
    d.call === 'in_app_dial' ? (
      <ActionLink variant="outline" asChild className={TAP}>
        {/* eslint-disable-next-line no-restricted-syntax -- same look as Text and Email (ActionLink outline) */}
        <button type="button" onClick={() => requestCall(phone, context)}>
          <Phone aria-hidden className="mr-1.5 size-4" />
          Call
          {opensTab && (
            <>
              <ExternalLink aria-hidden="true" className="ml-1 size-3 shrink-0 opacity-80" />
              <span className="sr-only"> (opens in a new tab)</span>
            </>
          )}
        </button>
      </ActionLink>
    ) : d.call === 'native_link' ? (
      <ActionLink variant="outline" className={TAP} href={telHref(phone)}>
        <Phone aria-hidden className="mr-1.5 size-4" />
        Call
      </ActionLink>
    ) : null;

  const text =
    d.textAction === 'in_app_text' && channels.text ? (
      <NewTabLink variant="button" className={TAP} href={textPath(phone, context, { viewCustomers: policy.switches.viewCustomers })}>
        <MessageSquare aria-hidden className="mr-1.5 size-4" />
        Text
      </NewTabLink>
    ) : d.textAction === 'native_link' ? (
      <ActionLink variant="outline" className={TAP} href={smsHref(phone)}>
        <MessageSquare aria-hidden className="mr-1.5 size-4" />
        Text
      </ActionLink>
    ) : null;

  return (
    <>
      {call}
      {text}
    </>
  );
}

export interface EmailButtonProps {
  /** Null when the customer has no email: the button shows dimmed. */
  email: string | null;
  /** What the compose window opens with (the recipient is `email`). */
  compose: Omit<ComposePathInput, 'to'>;
}

/** Email for a customer's address: opens the compose window in a new tab, addressed and filled in. Hidden without access. */
export function CustomerEmailAction({ email, compose }: EmailButtonProps) {
  const channels = useCustomerChannels();
  if (!email) return <Dimmed icon={<Mail aria-hidden className="mr-1.5 size-4" />} label="Email" why="No email on file" />;
  if (!channels.email) return null;
  return (
    <NewTabLink variant="button" className={TAP} href={composePath({ ...compose, to: email })}>
      <Mail aria-hidden className="mr-1.5 size-4" />
      Email
    </NewTabLink>
  );
}
