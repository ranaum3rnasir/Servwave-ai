import { useEffect, useRef, type ReactNode } from 'react';
import { AlertTriangle, Mail, Phone, XCircle } from 'lucide-react';

import { ActionLink } from '@/components/ui/action-link';
import { formatPhone } from '@/lib/utils';

import { Card, CardContent } from '@/ui-kit/components/ui/card';
import { Spinner } from '@/ui-kit/components/ui/spinner';
import { cn } from '@/ui-kit/lib/utils';

/**
 * Chrome for the two customer-facing pages.
 *
 * These pages render OUTSIDE `V2AppLayout` and outside every authed context.
 * Nothing in this file reads the auth store, the ability context or the
 * organization query - a public page that fired an authed request would leak
 * internal state to a homeowner holding nothing but a link token.
 *
 * They also own the whole viewport (`fixed inset-0 ... overflow-y-auto`), which
 * is why the kit's `layout/container` and `AppShell` are not used: both assume
 * a scroll parent that does not exist here.
 */

export type NoticeTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

const NOTICE_TONE: Record<NoticeTone, string> = {
  success: 'bg-status-green-subtle text-status-green-emphasis',
  warning: 'bg-status-amber-subtle text-status-amber-emphasis',
  danger: 'bg-status-red-subtle text-status-red-emphasis',
  info: 'bg-status-blue-subtle text-status-blue-emphasis',
  neutral: 'bg-muted text-muted-foreground',
};

/** Full-viewport shell. Both public pages take over the page, as today. */
export function PublicPage({ children }: { children: ReactNode }) {
  return <div className="pad-safe bg-app fixed inset-0 overflow-y-auto overscroll-contain">{children}</div>;
}

/**
 * The 2xl reading column both documents sit in. Its side gutter is 8 px below `sm`, so a card at
 * 320 px is 304 px wide and the signature pad, which spans its card edge to edge, is at least
 * 300 px (mobile slice 05, rubric CMP-14).
 */
export function PublicColumn({ children }: { children: ReactNode }) {
  return <div className="mx-auto flex max-w-2xl flex-col gap-6 px-2 py-8 sm:px-4">{children}</div>;
}

/**
 * A tinted status/notice band.
 *
 * A plain div rather than a tinted Card: `Card`'s appearance ceiling in
 * design-system/__tests__/component-api-guard.test.ts is at its floor, and the
 * kit's Card has no tone variant to reach for instead. Same shape the v2
 * invoices and estimates pages already use for their banners.
 */
export function PublicNotice({
  tone,
  icon,
  children,
}: {
  tone: NoticeTone;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={cn('flex items-start gap-3 rounded-lg border px-4 py-3 text-sm', NOTICE_TONE[tone])}>
      {icon ? <span className="mt-0.5 shrink-0 [&_svg]:size-5">{icon}</span> : null}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/**
 * A failed action, reported BESIDE the control that failed (mobile slice 28).
 *
 * At 320 px a banner at the top of the page is a screen or more above the button the customer
 * just pressed, so the press looked like it did nothing. This sits in the same card as that
 * button, is announced (`role="alert"`) and takes focus when it appears, which also scrolls it
 * into view. The page remounts it (a new `key`) on every failure, so a second failure with the
 * same words is announced and focused again.
 */
export function PublicActionError({ message }: { message: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div
      ref={ref}
      role="alert"
      tabIndex={-1}
      data-testid="public-action-error"
      className={cn(
        'flex items-start gap-2 rounded-lg border px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring',
        NOTICE_TONE.danger,
      )}
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <p className="min-w-0 flex-1 [overflow-wrap:anywhere]">{message}</p>
    </div>
  );
}

/**
 * The business's own contact details, as plain links (mobile slice 28, PRD module 10).
 *
 * The customer has no ServWave dialer, so the call action is a bare `tel:` link and the mail
 * action a bare `mailto:` link. The extension is shown beside the number and never dialled into
 * it: `organizations.phone` is matched by exact equality for inbound call attribution, so the
 * two halves stay apart (SRVW-54). Long addresses break anywhere rather than push the page wide.
 */
export function PublicBusinessContact({
  name,
  phone,
  phoneExt,
  email,
  website,
  websiteHref,
}: {
  name?: string | null;
  phone?: string | null;
  phoneExt?: string | null;
  email?: string | null;
  website?: string | null;
  /** The sanitised href for `website`; the link is drawn only when there is one. */
  websiteHref?: string;
}) {
  if (!name && !phone && !email && !website) return null;
  const dial = phone ? phone.replace(/[^\d+]/g, '') : '';
  return (
    <div className="text-subtle-foreground flex flex-col items-center gap-1 border-t pb-2 pt-4 text-center text-xs">
      {name && <p className="text-muted-foreground font-medium [overflow-wrap:anywhere]">{name}</p>}
      {phone && dial && (
        <p className="flex flex-wrap items-center justify-center gap-x-1">
          <ActionLink href={`tel:${dial}`} className="inline-flex min-h-11 items-center gap-1.5">
            <Phone className="size-3.5" aria-hidden />
            {formatPhone(phone)}
          </ActionLink>
          {phoneExt && <span>ext. {phoneExt}</span>}
        </p>
      )}
      {email && (
        <p className="max-w-full">
          <ActionLink href={`mailto:${email}`} className="inline-flex min-h-11 max-w-full items-center gap-1.5 [overflow-wrap:anywhere]">
            <Mail className="size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0">{email}</span>
          </ActionLink>
        </p>
      )}
      {website && websiteHref && (
        <p className="max-w-full">
          <ActionLink
            href={websiteHref}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-11 max-w-full items-center [overflow-wrap:anywhere]"
          >
            <span className="min-w-0">{website}</span>
          </ActionLink>
        </p>
      )}
    </div>
  );
}

/** A plain content card, used for every non-tinted block on the public pages. */
export function PublicCard({ children }: { children: ReactNode }) {
  return (
    <Card>
      <CardContent className="p-4">{children}</CardContent>
    </Card>
  );
}

/** Section title inside a public card. `role="heading"` - see LoginPage. */
export function PublicCardTitle({ children, level = 3 }: { children: ReactNode; level?: number }) {
  return (
    <p role="heading" aria-level={level} className="text-[15px] font-semibold">
      {children}
    </p>
  );
}

/** Centred spinner while the document loads. */
export function PublicLoading() {
  return (
    <div className="bg-app flex min-h-dvh items-center justify-center">
      <Spinner size="xl" className="text-subtle-foreground" />
    </div>
  );
}

/**
 * The fatal state: no document to show at all. Deliberately says nothing about
 * the org or the record beyond the message the page was given.
 */
export function PublicUnavailable({ title, message }: { title: string; message: string }) {
  return (
    <div className="bg-app flex min-h-dvh items-center justify-center p-4">
      <Card className="max-w-md">
        <CardContent className="p-6 text-center">
          <XCircle className="text-subtle-foreground mx-auto mb-4 size-12" />
          <p role="heading" aria-level={2} className="mb-2 text-lg font-semibold">
            {title}
          </p>
          <p className="text-muted-foreground text-sm">{message}</p>
        </CardContent>
      </Card>
    </div>
  );
}
