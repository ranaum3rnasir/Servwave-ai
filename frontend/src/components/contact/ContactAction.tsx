import type { MouseEvent, ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { MessageSquare, Phone } from 'lucide-react';

import { useAppAbility } from '@/contexts/AbilityContext';
import { useFeature } from '@/lib/entitlements';
import { requestCall } from '@/lib/communication/phoneTabHandoff';
import { formatPhone } from '@/lib/utils';
import type { DialerEntityContext } from '@/stores/dialer.store';
import { ActionLink } from '@/components/ui/action-link';
import { Button } from '@/ui-kit/components/ui/button';
import { ChoiceMenu } from '@/ui-kit/components/ui/choiceMenu';
import { callRoute, openDeviceLink, telHref, textPath, type CallRoute } from './contactHrefs';

/**
 * The contact action for a number that is NOT a customer's: a vendor's phone, which is not customer data and so
 * not under the contact display policy (Roles & Permissions, PRD 5). Every customer phone (and every crew phone) is
 * drawn through `contactDisplayPolicy` instead, by `PhoneValue`, `PhoneContactActions` or `CustomerPhoneText`; a
 * guard test fails when a customer screen imports this file.
 *
 *  - `PhoneNumberAction`: a number as text. Tapping it offers Call or Text. A stray tap never dials.
 *
 * Given a number, the record it came from and the org's phone-service status, this decides what
 * Call does (see `callRoute`): the ServWave dialer, pre-filled with the number and the record so the
 * call is attributed and logged, or - for an org with no phone service, or a user who may not place
 * calls - the device's own call link. Text opens the ServWave conversation with that number.
 *
 * Nothing outside this folder builds a telephone URL: a static guard fails the build when one
 * appears in live staff code.
 */

export interface ContactTarget {
  /** The number, as held on the record. */
  phone: string;
  /** Who it is, for accessible names ("Call Dana Reyes"). */
  name?: string;
  /** The record the number was tapped from, so the call is attributed to it. */
  context?: DialerEntityContext;
}

/** Whether the org has the phone service AND the user may place calls (`create Communication`). */
function useCanDial(): boolean {
  const phoneService = useFeature('phone');
  const ability = useAppAbility();
  return phoneService && ability.can('create', 'Communication');
}

function placeCall(route: CallRoute, { phone, context }: ContactTarget): void {
  if (route === 'dialer') requestCall(phone, context);
  else openDeviceLink(telHref(phone));
}

const stop = (e: MouseEvent) => e.stopPropagation();

// ─── A number as text ──────────────────────────────────────────────────────────

interface PhoneNumberActionProps extends ContactTarget {
  /** What is shown; the formatted number by default. */
  children?: ReactNode;
  /** Layout only (width, truncation, alignment). */
  className?: string;
}

/**
 * A phone number that offers Call or Text when tapped.
 *
 * An org without the phone service, or a user who may not place calls, gets a plain device call
 * link instead: there is no dialer to open and no choice to make.
 */
export function PhoneNumberAction(props: PhoneNumberActionProps) {
  const canDial = useCanDial();
  if (!canDial) return <DevicePhoneLink {...props} />;
  return <ChoosePhoneNumber {...props} />;
}

function DevicePhoneLink({ phone, children, className }: PhoneNumberActionProps) {
  return (
    <ActionLink href={telHref(phone)} onClick={stop} className={className}>
      {children ?? formatPhone(phone)}
    </ActionLink>
  );
}

function ChoosePhoneNumber(props: PhoneNumberActionProps) {
  const { phone, children, className } = props;
  const navigate = useNavigate();
  const label = formatPhone(phone);
  const route = callRoute(true);

  return (
    // The sheet is portalled, but React still bubbles its clicks to this span, which keeps a
    // clickable row or card around the number from also firing.
    <span className="contents" onClick={stop}>
      <ChoiceMenu
        title={props.name ? `${props.name}, ${label}` : label}
        trigger={
          <Button variant="link" size="sm" className={className ? `h-auto px-0 font-normal ${className}` : 'h-auto px-0 font-normal'}>
            {children ?? label}
          </Button>
        }
        options={[
          {
            key: 'call',
            label: 'Call',
            icon: <Phone className="size-4" aria-hidden />,
            onSelect: () => placeCall(route, props),
          },
          {
            key: 'text',
            label: 'Text',
            icon: <MessageSquare className="size-4" aria-hidden />,
            onSelect: () => navigate(textPath(phone, props.context)),
          },
        ]}
      />
    </span>
  );
}
