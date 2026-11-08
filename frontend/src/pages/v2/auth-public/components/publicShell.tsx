import type { ReactNode } from 'react';
import { XCircle } from 'lucide-react';

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
  return <div className="bg-app fixed inset-0 overflow-y-auto">{children}</div>;
}

/** The 2xl reading column both documents sit in. */
export function PublicColumn({ children }: { children: ReactNode }) {
  return <div className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-8">{children}</div>;
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
    <div className="bg-app flex min-h-screen items-center justify-center">
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
    <div className="bg-app flex min-h-screen items-center justify-center p-4">
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
