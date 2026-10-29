import type { MouseEvent, ReactNode } from 'react';
import { Link, useInRouterContext, useNavigate } from 'react-router-dom';
import { MessageSquare, Phone } from 'lucide-react';

import { useAppAbility } from '@/contexts/AbilityContext';
import { useFeature } from '@/lib/entitlements';
import { requestCall } from '@/lib/communication/phoneTabHandoff';
import { formatPhone } from '@/lib/utils';
import type { DialerEntityContext } from '@/stores/dialer.store';
import { ActionLink } from '@/components/ui/action-link';
import { Button } from '@/ui-kit/components/ui/button';
import { ChoiceMenu } from '@/ui-kit/components/ui/choiceMenu';
import {
  callRoute,
  openDeviceLink,
  smsHref,
  telHref,
  textPath,
  type CallRoute,
} from './contactHrefs';

/**
 * The contact action: the one place a phone number turns into a call or a text (mobile slice 50).
 *
 *  - `PhoneNumberAction`: a number as text. Tapping it offers Call or Text. A stray tap never dials.
 *  - `ContactCallButton` / `ContactTextButton`: a screen that already shows explicit Call and Text
 *    buttons keeps them and skips the choice.
 *
 * Given a number, the record it came from and the org's phone-service status, this decides what
 * Call does (see `callRoute`): the ServWave dialer, pre-filled with the number and the record so the
 * call is attributed and logged, or - for an org with no phone service, or a user who may not place
 * calls - the device's own call link. Text opens the ServWave conversation with that number, or the
 * device's text link when there is no conversation to open.
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

/**
 * What the signed-in user and org may do with a number.
 *  - `canDial`: the org has the phone service AND the user may place calls (`create Communication`).
 *  - `canText`: the org has the phone service, so the ServWave conversation exists.
 */
export function useContactChannels(): { canDial: boolean; canText: boolean } {
  const phoneService = useFeature('phone');
  const ability = useAppAbility();
  return { canDial: phoneService && ability.can('create', 'Communication'), canText: phoneService };
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
  const { canDial } = useContactChannels();
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

// ─── Explicit Call and Text buttons ────────────────────────────────────────────

interface ContactButtonProps extends ContactTarget {
  /**
   * `icon`: a kit icon button (44 px on touch). `bare`: the caller's own element and classes, for a
   * tile or a row that has its own look; `children` is its content.
   */
  kind?: 'icon' | 'bare';
  /** The icon button's look. */
  variant?: 'ghost' | 'outline';
  /** Layout for `icon`; the whole look for `bare`. */
  className?: string;
  children?: ReactNode;
}

/** A Call button. In an org with the dialer it opens the dialer; otherwise it is a device call link. */
export function ContactCallButton(props: ContactButtonProps) {
  const { canDial } = useContactChannels();
  const { phone, name, kind = 'icon', variant = 'ghost', className, children } = props;
  const route = callRoute(canDial);
  const label = name ? `Call ${name}` : 'Call';

  if (kind === 'bare') {
    return route === 'dialer' ? (
      <button
        type="button"
        aria-label={name ? label : undefined}
        className={className}
        onClick={(e) => {
          stop(e);
          placeCall(route, props);
        }}
      >
        {children}
      </button>
    ) : (
      <a href={telHref(phone)} aria-label={name ? label : undefined} className={className} onClick={stop}>
        {children}
      </a>
    );
  }

  const icon = <Phone aria-hidden />;
  return route === 'dialer' ? (
    <Button
      variant={variant}
      size="icon-sm"
      aria-label={label}
      className={className}
      onClick={(e) => {
        stop(e);
        placeCall(route, props);
      }}
    >
      {icon}
    </Button>
  ) : (
    <Button variant={variant} size="icon-sm" aria-label={label} className={className} asChild>
      <ActionLink href={telHref(phone)} onClick={stop}>
        {icon}
      </ActionLink>
    </Button>
  );
}

/**
 * A Text button. With the phone service it opens the ServWave conversation with the number; without
 * it, the device's own text link.
 */
export function ContactTextButton(props: ContactButtonProps) {
  const { canText } = useContactChannels();
  const inRouter = useInRouterContext();
  const { phone, name, context, kind = 'icon', variant = 'ghost', className, children } = props;
  const label = name ? `Text ${name}` : 'Text';
  const href = canText ? textPath(phone, context) : smsHref(phone);
  // A path inside the app goes through the router; a device link is a plain anchor.
  const inApp = canText && inRouter;

  if (kind === 'bare') {
    return inApp ? (
      <Link to={href} aria-label={name ? label : undefined} className={className} onClick={stop}>
        {children}
      </Link>
    ) : (
      <a href={href} aria-label={name ? label : undefined} className={className} onClick={stop}>
        {children}
      </a>
    );
  }

  const icon = <MessageSquare aria-hidden />;
  return (
    <Button variant={variant} size="icon-sm" aria-label={label} className={className} asChild>
      {inApp ? (
        <Link to={href} onClick={stop}>
          {icon}
        </Link>
      ) : (
        <ActionLink href={href} onClick={stop}>
          {icon}
        </ActionLink>
      )}
    </Button>
  );
}
