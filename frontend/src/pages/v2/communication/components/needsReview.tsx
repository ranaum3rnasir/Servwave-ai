import { useMemo, useState, type ReactNode } from 'react';
import { ArrowLeft, Link2, MailWarning, Paperclip, ShieldAlert, Bot, CornerUpLeft, type LucideIcon } from 'lucide-react';

import { HelpIcon } from '@/components/permissions/HelpIcon';
import { Alert } from '@/components/ui/alert';
import { RecordTieBadge } from '@/components/communication/shared/atoms';
import {
  linkInboundErrorMessage, senderAddress, senderLabel, useLinkInboundEmail, useNeedsReview, useNeedsReviewItem,
} from '@/lib/api/communication';
import type { ReviewItem, ReviewReason } from '@/lib/api/communication';
import { useScheduleTimezone } from '@/lib/schedule-tz';

import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { SearchInput } from '@/ui-kit/components/form/searchInput';
import { Avatar } from '@/ui-kit/components/ui/avatar';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from '@/ui-kit/components/ui/dialog';
import { DialogList } from '@/ui-kit/components/ui/dialogList';
import { Skeleton } from '@/ui-kit/components/ui/skeleton';
import { cn } from '@/ui-kit/lib/utils';

import { formatEmailDay } from './emailDay';
import type { LinkTarget } from './linkTargets';
import { READER_FULLSCREEN } from './readerOverlay';

/**
 * The Needs review folder of the Email page (PRD 10, S10.18).
 *
 * Mail the router would not deliver is held here, in the mailbox it was filed under: a sender check that failed, automatic mail
 * (out-of-office replies, bounces, bulk), a reply from an address we did not send to, and a reply to an email we can no longer
 * match. It starts no conversation, rings no bell and counts toward no unread number. Each item says why it is here, and one
 * action does what a person is here to do: link it to a conversation.
 *
 * Laid out as the rest of the Email page is: a list beside a reader at lg and up, and below lg the reader is a full-screen
 * overlay (the rail is already the page's menu sheet). Like the folders, it follows the mailbox picked in the rail.
 */

interface ReasonStyle {
  /** The name of the reason, worded once: the badge on a list row and the banner above an item both carry exactly this. */
  label: string;
  tone: 'softRed' | 'softAmber' | 'softNeutral';
  alert: 'danger' | 'warning' | 'neutral';
  icon: LucideIcon;
  /** The one thing a person needs to know about it, behind the "?" beside the reason. */
  help: string;
}

const REVIEW_REASONS: Record<ReviewReason, ReasonStyle> = {
  failed_authentication: {
    label: 'Sender check failed',
    tone: 'softRed',
    alert: 'danger',
    icon: ShieldAlert,
    help: 'The sender could not be confirmed, so this may be forged. It is never linked to a customer.',
  },
  automatic: {
    label: 'Automatic mail',
    tone: 'softNeutral',
    alert: 'neutral',
    icon: Bot,
    help: 'Out-of-office replies, bounces and bulk mail are kept out of your inbox.',
  },
  sender_mismatch: {
    label: "Reply from an address we didn't send to",
    tone: 'softAmber',
    alert: 'warning',
    icon: CornerUpLeft,
    help: 'Someone other than the person we emailed answered. Check it, then link it to the conversation.',
  },
  unknown_reply: {
    label: "Reply to an email we can't match",
    tone: 'softAmber',
    alert: 'warning',
    icon: CornerUpLeft,
    help: 'The reply address on the email it answers is no longer active.',
  },
};

/** The reason's badge. */
function ReasonBadge({ reason }: { reason: ReviewReason }) {
  const style = REVIEW_REASONS[reason];
  return (
    <Badge variant={style.tone} size="sm">
      {style.label}
    </Badge>
  );
}

function ItemRow({ item, open, onOpen }: { item: ReviewItem; open: boolean; onOpen: () => void }) {
  const tz = useScheduleTimezone();
  return (
    <Button
      variant="ghost"
      data-review-row={item.id}
      aria-pressed={open}
      onClick={onOpen}
      className={cn(
        'h-auto w-full items-start justify-start gap-3 rounded-none border-b px-3 py-3 text-left',
        open && 'bg-muted text-foreground',
      )}
    >
      <Avatar name={senderLabel(item.from)} className="mt-0.5" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-2">
          <span className="text-foreground truncate text-[13px] font-semibold">{senderLabel(item.from)}</span>
          <span className="flex flex-none items-center gap-1.5">
            {item.hasAttachment && <Paperclip className="size-3" aria-hidden />}
            <span className="text-[11px] font-normal">{formatEmailDay(item.ts, tz)}</span>
          </span>
        </span>
        <span className="text-foreground mt-0.5 block truncate text-[13px] font-medium">{item.subject}</span>
        <span className="mt-0.5 block truncate text-[12px] font-normal">{item.snippet}</span>
        <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <ReasonBadge reason={item.reviewReason} />
          <RecordTieBadge tie={item.recordTie} />
        </span>
      </span>
    </Button>
  );
}

function ItemReader({
  item, canLink, onLink, onBack, inDialog,
}: {
  item: ReviewItem; canLink: boolean; onLink: () => void; onBack: () => void; inDialog?: boolean;
}) {
  const tz = useScheduleTimezone();
  const style = REVIEW_REASONS[item.reviewReason];
  const Icon = style.icon;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className={cn(
          'bg-kit-card flex shrink-0 items-center gap-1 border-b px-4 py-2.5',
          inDialog && 'pt-[max(0.625rem,env(safe-area-inset-top))]',
        )}
      >
        <Button variant="ghost" size="icon-sm" aria-label="Back" onClick={onBack} className="mr-1 lg:hidden">
          <ArrowLeft />
        </Button>
        {inDialog ? (
          <DialogTitle className="truncate text-sm font-semibold">{item.subject}</DialogTitle>
        ) : (
          <h2 className="truncate text-sm font-semibold">{item.subject}</h2>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
        <Alert tone={style.alert} role="status" gap={2} className="mb-4 flex-wrap items-center">
          <Icon aria-hidden className="flex-none" />
          <span className="min-w-0 flex-1 font-semibold">{style.label}</span>
          <HelpIcon label={style.label} text={style.help} />
          {canLink && (
            <Button size="sm" onClick={onLink} className="max-sm:w-full">
              <Link2 /> Link to a conversation
            </Button>
          )}
        </Alert>
        {item.recordTie && (
          // The job or lead the reply is about: what a reply from an address we did not send to is checked against.
          <p className="mb-4 flex items-center gap-2 text-[13px]">
            <span className="text-muted-foreground">{item.recordTie.kind === 'job' ? 'Job' : 'Lead'}</span>
            <RecordTieBadge tie={item.recordTie} />
          </p>
        )}
        <div className="flex items-start gap-3">
          <Avatar name={senderLabel(item.from)} />
          <div className="min-w-0 flex-1">
            <p className="text-foreground truncate text-[13px] font-semibold">{senderLabel(item.from)}</p>
            <p className="truncate text-[12px] font-normal">{senderAddress(item.from)}</p>
            {/* The address clips and the time does not: on a phone the time is what tells a new item from an old one. */}
            <p className="flex gap-1 text-[12px] font-normal">
              <span className="min-w-0 truncate">To {item.toReplyAddress ? 'our reply address' : item.to}</span>
              <span className="flex-none">- {formatEmailDay(item.ts, tz, { withTime: true })}</span>
            </p>
          </div>
        </div>
        <div className="text-foreground mt-4 space-y-3 text-[13.5px] leading-relaxed">
          {item.body.length === 0 ? <p>(no content)</p> : item.body.map((p, i) => <p key={i} className="whitespace-pre-wrap break-words">{p}</p>)}
        </div>
        {item.attachments && item.attachments.length > 0 && (
          <ul className="mt-4 space-y-1" aria-label="Attachments">
            {item.attachments.map((a, i) => (
              <li key={i} className="flex items-center gap-2 text-[12.5px]">
                <Paperclip className="size-3.5 flex-none" />
                <span className="min-w-0 flex-1 truncate">{a.name}</span>
                <span className="flex-none text-[11.5px]">{a.size}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

const TARGETS_SHOWN = 100;

/** Pick the conversation a held message goes to: the one it replied to when there is one, else any the person can see. */
function LinkDialog({
  item, targets, pending, onPick, onClose,
}: {
  item: ReviewItem; targets: LinkTarget[]; pending: boolean; onPick: (threadId?: string) => void; onClose: () => void;
}) {
  const [search, setSearch] = useState('');
  const shown = useMemo(() => {
    const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return targets.filter((t) => words.every((w) => t.subject.toLowerCase().includes(w) || t.who.toLowerCase().includes(w)));
  }, [targets, search]);
  const page = shown.slice(0, TARGETS_SHOWN);

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent intent="form" aria-describedby={undefined} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Link to a conversation</DialogTitle>
        </DialogHeader>
        <DialogBody>
          {item.linkTo && (
            <Button variant="outline" className="mb-3 h-auto w-full justify-start gap-2 py-2 text-left" disabled={pending} onClick={() => onPick()}>
              <CornerUpLeft />
              <span className="min-w-0 flex-1">
                <span className="block text-[11px] font-normal">It replied to</span>
                <span className="block truncate">{item.linkTo.subject ?? 'The original conversation'}</span>
              </span>
            </Button>
          )}
          <SearchInput value={search} onValueChange={setSearch} placeholder="Search conversations" aria-label="Search conversations" />
          {page.length === 0 ? (
            <EmptyState title="No conversation matches." />
          ) : (
            <DialogList as="ul" cap="max-h-72 overflow-y-auto overscroll-contain" aria-label="Conversations" className="mt-2 space-y-0.5">
              {page.map((t) => (
                <li key={t.threadId}>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-auto w-full justify-start gap-2.5 py-1.5 text-left"
                    disabled={pending}
                    onClick={() => onPick(t.threadId)}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="text-foreground block truncate text-[13px] font-medium">{t.subject}</span>
                      <span className="block truncate text-[11.5px] font-normal">{t.who} - {t.at}</span>
                    </span>
                  </Button>
                </li>
              ))}
            </DialogList>
          )}
          {shown.length > TARGETS_SHOWN && (
            <p className="text-muted-foreground mt-2 border-t pt-2 text-xs">Showing the newest {TARGETS_SHOWN} of {shown.length}.</p>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

export interface NeedsReviewViewProps {
  /** The mailbox the page shows ("mine", "all" or an id); null until the server has said which. */
  mailbox: string | null;
  /** The conversations a held message can be linked to: the ones the page already holds for this mailbox. */
  targets: LinkTarget[];
  /** Holds Edit communication records: the route that links a held message needs it, so the action is shown to those who hold it. */
  canLink: boolean;
  /** Below lg the reader is a full-screen overlay and the list keeps the whole width. */
  narrow: boolean;
  onToast: (message: string) => void;
  /**
   * A held message the page was asked to open (the bell of a reply from an address we did not send to points at one): it opens
   * in the reader although it may sit in another mailbox's list, which the person need not see. Null when none was asked for.
   */
  focusId?: string | null;
  /** The person moved on from the asked-for message (picked another, closed it or linked it): the page forgets the ask. */
  onFocusDone?: () => void;
}

/** The list column and the reader of the Needs review folder, in the place of the message list and reading pane. */
export function NeedsReviewView({ mailbox, targets, canLink, narrow, onToast, focusId = null, onFocusDone }: NeedsReviewViewProps) {
  const query = useNeedsReview(mailbox);
  const link = useLinkInboundEmail();
  const focused = useNeedsReviewItem(focusId);
  const items = useMemo(() => query.data?.pages.flatMap((p) => p.emails) ?? [], [query.data]);
  const total = query.data?.pages[0]?.total ?? 0;
  const [openId, setOpenId] = useState<string | null>(focusId);
  const [linking, setLinking] = useState(false);
  // A second bell opened while the folder is already showing asks for another message: it opens, not the one before.
  const [askedFor, setAskedFor] = useState(focusId);
  if (focusId !== askedFor) {
    setAskedFor(focusId);
    if (focusId !== null) setOpenId(focusId);
  }
  // The list's own copy first (it is the one that refreshes), else the one asked for by id.
  const open = items.find((i) => i.id === openId) ?? (openId !== null && focused.data?.id === openId ? focused.data : null);

  function openItem(id: string | null) {
    setOpenId(id);
    if (focusId !== null && id !== focusId) onFocusDone?.();
  }

  function pick(threadId?: string) {
    if (!open) return;
    link.mutate(
      { emailId: open.id, threadId },
      {
        onSuccess: () => {
          setLinking(false);
          openItem(null);
          onToast('Linked to the conversation');
        },
        onError: (err) => onToast(linkInboundErrorMessage(err)),
      },
    );
  }

  const reader = open && (
    <ItemReader item={open} canLink={canLink} onLink={() => setLinking(true)} onBack={() => openItem(null)} inDialog={narrow} />
  );

  let body: ReactNode;
  if (query.isPending && query.fetchStatus !== 'idle') {
    body = (
      <div role="status" aria-label="Loading" className="space-y-3 p-3">
        {[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-16 w-full" />)}
      </div>
    );
  } else if (query.isError) {
    body = <EmptyState title="Could not load this list." />;
  } else if (items.length === 0) {
    body = <EmptyState icon={<MailWarning />} title="Nothing to review." />;
  } else {
    body = (
      <>
        {items.map((item) => (
          <ItemRow key={item.id} item={item} open={item.id === openId} onOpen={() => openItem(item.id)} />
        ))}
        {query.hasNextPage && (
          <div className="p-3">
            <Button variant="outline" className="w-full" disabled={query.isFetchingNextPage} onClick={() => query.fetchNextPage()}>
              Show more ({total - items.length})
            </Button>
          </div>
        )}
      </>
    );
  }

  return (
    <>
      <div className={cn('bg-kit-card flex min-w-0 flex-col border-r', open && !narrow ? 'lg:w-96 lg:flex-none' : 'flex-1')}>
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <h2 className="text-sm font-semibold">Needs review</h2>
          {total > 0 && <Badge variant="softNeutral" size="sm">{total}</Badge>}
        </div>
        {focusId !== null && focused.isError && openId === focusId && (
          // The bell's message is not there any more: somebody linked it, or the person cannot reach its conversation.
          <Alert tone="neutral" role="status" className="m-3">
            This message is no longer waiting for review.
          </Alert>
        )}
        <div
          role="region"
          aria-label="Held messages"
          // A list that grows keeps to a scroll of its own, and the page behind it stays put.
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        >
          {body}
        </div>
      </div>
      {reader && !narrow && <div className="bg-app flex min-w-0 flex-1 flex-col">{reader}</div>}
      {narrow && (
        <Dialog open={!!open} onOpenChange={(next) => { if (!next) openItem(null); }}>
          <DialogContent intent="content" showClose={false} aria-describedby={undefined} className={READER_FULLSCREEN}>
            {reader}
          </DialogContent>
        </Dialog>
      )}
      {linking && open && (
        <LinkDialog item={open} targets={targets} pending={link.isPending} onPick={pick} onClose={() => setLinking(false)} />
      )}
    </>
  );
}
