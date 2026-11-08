import { useState, type ReactNode } from 'react';
import {
  Archive, ArrowDownToLine, ArrowLeft, BellOff, Bookmark, Calendar, Clock, CornerUpLeft,
  CornerUpRight, ListChecks, MailOpen, MoreVertical, Paperclip, ShieldAlert, Star, Trash2,
} from 'lucide-react';

import { InlineComposer } from '@/components/communication/inbox/ComposeWindow';
import { JobBadge } from '@/components/communication/shared/atoms';
import { ACCOUNTS, senderLabel } from '@/lib/api/communication';
import type { Account, Email, ReplyDraft } from '@/lib/api/communication';

import { Avatar } from '@/ui-kit/components/ui/avatar';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger,
} from '@/ui-kit/components/ui/dropdownMenu';
import { Separator } from '@/ui-kit/components/ui/separator';

/**
 * Gmail-style conversation reader.
 *
 * Lifted out of the page file, but rendered TWICE by it - once as the desktop
 * column and once as the mobile overlay - exactly as the legacy page does. Each
 * instance keeps its own `expanded` set, so collapsing an older message on one
 * breakpoint does not collapse it on the other. Collapsing the two into one
 * instance would silently delete the mobile reading path.
 *
 * Every action, every toast string and the "the last message is always
 * expanded" rule are the legacy pane's.
 */

/** Label pill tones. The legacy page hand-tinted these; the kit's soft Badge
 *  variants are the same five tones expressed as component API. */
const LABEL_VARIANT: Record<string, 'softGreen' | 'softAmber' | 'softBlue' | 'softRed'> = {
  Customer: 'softGreen',
  Vendor: 'softAmber',
  Lead: 'softBlue',
  Billing: 'softBlue',
  Reviews: 'softRed',
};

function LabelPills({ labels }: { labels?: string[] }) {
  if (!labels?.length) return null;
  return (
    <>
      {labels.map((l) => (
        <Badge key={l} variant={LABEL_VARIANT[l] ?? 'softNeutral'} size="sm">
          {l}
        </Badge>
      ))}
    </>
  );
}

/** An action-bar icon button. The legacy `IconBtn` set BOTH aria-label and
 *  title to the same string, and both are part of the selector surface. */
function BarButton({
  label, onClick, children,
}: {
  label: string;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <Button variant="ghost" size="icon-sm" aria-label={label} title={label} onClick={onClick}>
      {children}
    </Button>
  );
}

export interface ReadingPaneProps {
  email: Email;
  thread: Email[];
  reply: ReplyDraft | null;
  onReplyChange: (r: ReplyDraft) => void;
  onSendReply: () => void;
  onDiscardReply: () => void;
  onPopOutReply: () => void;
  onBack: () => void;
  onStar: () => void;
  onArchive: () => void;
  onReply: () => void;
  onForward: () => void;
  onTrash: () => void;
  onToast: (m: string) => void;
  onUpdateEmail: (id: string, patch: Partial<Email>) => void;
  /** Live connected mailbox - threads down to the inline composer. */
  fromAddress?: string;
}

export function ReadingPane({
  email, thread, reply, onReplyChange, onSendReply, onDiscardReply, onPopOutReply, onBack,
  onStar, onArchive, onReply, onForward, onTrash, onToast, onUpdateEmail, fromAddress,
}: ReadingPaneProps) {
  // The chain renders oldest -> newest. The latest message is always expanded;
  // older ones collapse to a one-line summary you can click to expand.
  const messages = thread.length ? thread : [email];
  const lastId = messages[messages.length - 1]!.id;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const isExpanded = (m: Email) => m.id === lastId || expanded.has(m.id);
  function toggleMessage(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const SNOOZE_OPTIONS = ['Later today', 'Tomorrow', 'This weekend', 'Next week'];
  function markUnread() {
    onUpdateEmail(email.id, { unread: true });
    onToast('Marked as unread');
    onBack();
  }
  function snoozeEmail(when: string) {
    onUpdateEmail(email.id, { snoozedUntil: when });
    onToast(`Snoozed - ${when}`);
    onBack();
  }
  function toggleImportant() {
    onUpdateEmail(email.id, { important: !email.important });
    onToast(email.important ? 'Removed importance' : 'Marked as important');
  }
  function reportSpam() {
    onUpdateEmail(email.id, { folder: 'archive' });
    onToast('Reported spam & removed from inbox');
    onBack();
  }
  function muteThread() {
    onUpdateEmail(email.id, { folder: 'archive' });
    onToast('Muted - moved out of inbox');
    onBack();
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Action bar */}
      <div className="bg-kit-card flex items-center gap-1 border-b px-4 py-2.5">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Back"
          onClick={onBack}
          className="mr-1 lg:hidden"
        >
          <ArrowLeft />
        </Button>
        <BarButton label="Archive" onClick={onArchive}>
          <Archive />
        </BarButton>
        <BarButton label="Report spam" onClick={reportSpam}>
          <ShieldAlert />
        </BarButton>
        <BarButton label="Delete" onClick={onTrash}>
          <Trash2 />
        </BarButton>
        <Separator orientation="vertical" className="mx-1 h-5" />
        <BarButton label="Mark as unread" onClick={markUnread}>
          <MailOpen />
        </BarButton>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Snooze" title="Snooze">
              <Clock />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-48">
            <DropdownMenuLabel>Snooze until</DropdownMenuLabel>
            {SNOOZE_OPTIONS.map((o) => (
              <DropdownMenuItem key={o} onClick={() => snoozeEmail(o)}>
                {o}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <BarButton label="Add to tasks" onClick={() => onToast('✓ Added to tasks')}>
          <ListChecks />
        </BarButton>
        <div className="ml-auto flex items-center gap-1">
          <BarButton label="Reply" onClick={onReply}>
            <CornerUpLeft />
          </BarButton>
          <BarButton label="Forward" onClick={onForward}>
            <CornerUpRight />
          </BarButton>
          <Separator orientation="vertical" className="mx-1 h-5" />
          <BarButton label={email.starred ? 'Unstar' : 'Star'} onClick={onStar}>
            <Star className={email.starred ? 'fill-status-amber text-status-amber' : undefined} />
          </BarButton>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="More" title="More">
                <MoreVertical />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem onClick={markUnread}>
                <MailOpen /> Mark as unread
              </DropdownMenuItem>
              <DropdownMenuItem onClick={toggleImportant}>
                <Bookmark
                  className={email.important ? 'fill-status-amber text-status-amber' : undefined}
                />
                {email.important ? 'Mark as not important' : 'Mark as important'}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onStar}>
                <Star
                  className={email.starred ? 'fill-status-amber text-status-amber' : undefined}
                />
                {email.starred ? 'Remove star' : 'Add star'}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onToast('📅 Event created from this email')}>
                <Calendar /> Create event
              </DropdownMenuItem>
              <DropdownMenuItem onClick={muteThread}>
                <BellOff /> Mute
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Content */}
      <div className="bg-kit-card min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="mb-1 flex items-start justify-between gap-3">
          {/* role/aria-level rather than a heading tag: the design-system
              raw-tag ratchet counts h1-h6 and this module adds none. */}
          <p role="heading" aria-level={2} className="text-lg font-semibold">
            {email.subject}
          </p>
          <span className="flex shrink-0 items-center gap-1.5">
            <LabelPills labels={email.labels} />
            {email.jobLabel && <JobBadge job={email.jobLabel} className="flex-none" />}
          </span>
        </div>
        {messages.length > 1 && (
          <p className="text-muted-foreground mb-2 mt-1 text-[12px] font-medium">
            {messages.length} messages in this conversation
          </p>
        )}

        {/* Conversation chain - oldest -> newest */}
        <div className="mt-2 space-y-2.5">
          {messages.map((m) => {
            const mAcct = ACCOUNTS.find((a: Account) => a.id === m.account) ?? ACCOUNTS[0]!;
            const showFull = isExpanded(m);
            const fromYou = m.folder === 'sent' || m.folder === 'drafts';
            return (
              <div key={m.id} className="overflow-hidden rounded-lg border">
                <Button
                  variant="ghost"
                  onClick={() => m.id !== lastId && toggleMessage(m.id)}
                  className="h-auto w-full items-center justify-start gap-3 rounded-none px-4 py-3 text-left"
                >
                  <Avatar name={senderLabel(m.from)} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="text-foreground text-sm font-semibold">
                        {fromYou ? 'You' : senderLabel(m.from)}
                      </span>
                      {showFull && (
                        <span className="truncate text-[12px] font-normal">
                          &lt;{m.from.email}&gt;
                        </span>
                      )}
                    </span>
                    {showFull ? (
                      <span className="block text-[12px] font-normal">
                        to {m.to} · via{' '}
                        <span className="inline-flex items-center gap-1">{mAcct.provider}</span>
                      </span>
                    ) : (
                      <span className="block truncate text-[12px] font-normal">{m.snippet}</span>
                    )}
                  </span>
                  {/* Per-message job badge - every message in the reading pane
                      is badged, tagged or not. The dense LIST rows deliberately
                      are not. */}
                  <JobBadge job={m.jobLabel} className="flex-none" />
                  <span className="flex-none text-[12px] font-normal">{m.at}</span>
                </Button>

                {showFull && (
                  <div className="border-t px-4 py-3.5">
                    {m.bodyHtml ? (
                      // Gmail-mirrored HTML - sanitised SERVER-SIDE at ingest
                      // (lib/gmail/mime.ts); rendered width-contained and
                      // horizontally scrollable so email tables cannot break
                      // the pane.
                      <div
                        className="text-foreground overflow-x-auto text-[14px] leading-relaxed [overflow-wrap:anywhere] [&_a]:text-brand [&_a]:underline [&_img]:max-w-full [&_table]:max-w-full"
                        dangerouslySetInnerHTML={{ __html: m.bodyHtml }}
                      />
                    ) : (
                      <div className="text-foreground space-y-3 text-[14px] leading-relaxed">
                        {(Array.isArray(m.body) ? m.body : [String(m.body ?? '')]).map((p, i) => (
                          <p key={i} className="whitespace-pre-line">
                            {p}
                          </p>
                        ))}
                      </div>
                    )}
                    {m.attachments?.length ? (
                      <div className="mt-4 flex flex-wrap gap-2">
                        {m.attachments.map((a, ai) => (
                          // Name + size only, not clickable. Rows written by
                          // the compose and transactional paths do have a stored
                          // copy (GET .../emails/:id/attachments/:index signs
                          // it); this chip is simply not wired to that yet.
                          <span
                            key={`${a.name}-${ai}`}
                            className="text-muted-foreground inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-[13px]"
                          >
                            <Paperclip className="size-4" />
                            {a.name}
                            <span>· {a.size}</span>
                          </span>
                        ))}
                      </div>
                    ) : m.hasAttachment ? (
                      // The row says a file went out but lists none (a send
                      // from before its files were recorded, or one whose
                      // stored copy failed). Say that much and no more: this
                      // used to invent an 'invoice.pdf · 84 KB' chip, which put
                      // a filename and a size nobody sent on every such row,
                      // estimates included (#2251).
                      <div className="mt-4 flex flex-wrap gap-2">
                        <span
                          data-testid="email-attachment-generic"
                          className="text-muted-foreground inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-[13px]"
                        >
                          <Paperclip className="size-4" />
                          Attachment
                        </span>
                      </div>
                    ) : null}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Inline reply - buttons when idle, composer when active */}
        {reply ? (
          <InlineComposer
            reply={reply}
            original={email}
            onChange={onReplyChange}
            onSend={onSendReply}
            onDiscard={onDiscardReply}
            onPopOut={onPopOutReply}
            onToast={onToast}
            fromAddress={fromAddress}
          />
        ) : (
          <div className="mt-6 flex gap-2">
            <Button variant="outline" size="sm" onClick={onReply} className="rounded-full">
              <CornerUpLeft /> Reply
            </Button>
            <Button variant="outline" size="sm" onClick={onForward} className="rounded-full">
              <CornerUpRight /> Forward
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
