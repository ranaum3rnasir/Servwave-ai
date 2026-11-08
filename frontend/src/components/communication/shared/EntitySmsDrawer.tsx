/**
 * Entity-tab SMS detail — the right-side slide-in behind a clicked text row on
 * the Job / Customer / Lead Communication tabs. Chat parity with
 * `EntityCallDrawer`: where a call opens its recording/transcript/insights, a
 * text opens the customer's SMS conversation as a chat thread.
 *
 * #2046 (R1) — keys off the row's own `threadId` (`CommItem.threadId`) and
 * reads `useMessageThread(threadId)`, the anchor-filtered by-id read that
 * stays ungated by the Communication SECTION gate. Deliberately NOT
 * `useMessageThreads()` (the org-wide list) any more: that source now 403s for
 * a caller who holds `read Communication` alone, which would have taken this
 * drawer away from every SALES rep on their own lead/job/customer.
 * Read-only: the tab's own composer handles replying.
 *
 * #2049 — opening the drawer fires the persisting `PATCH .../read` mutation
 * (`useMarkThreadRead`, `read Communication` alone, same gate as the GET
 * above) exactly once per `threadId`, mirroring `SmsInboxView`'s openThread.
 */
import { useEffect } from 'react';
import { Loader2, MessageSquare } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useMessageThread, useMarkThreadRead, deliveryNote, outboundBubbleClass } from '@/lib/api/communication';
import { EmptyState } from '@/components/ui/empty-state';
import { Sheet, SheetContent, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { useScheduleTimezone, formatInstant } from '@/lib/schedule-tz';

interface EntitySmsDrawerProps {
  threadId?: string;
  customerName?: string;
  onClose: () => void;
}

/** Short "2:01 PM" time for a bubble, on the ORG's clock (no seconds). */
function bubbleTime(ts: string, tz: string): string {
  if (Number.isNaN(new Date(ts).getTime())) return '';
  return formatInstant(ts, tz, { hour: 'numeric', minute: '2-digit' });
}

export function EntitySmsDrawer({ threadId, customerName, onClose }: EntitySmsDrawerProps) {
  const tz = useScheduleTimezone();
  const { data: thread, isLoading } = useMessageThread(threadId);
  const markThreadRead = useMarkThreadRead();
  const messages = thread?.messages ?? [];

  useEffect(() => {
    if (threadId) markThreadRead.mutate(threadId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- markThreadRead is a fresh mutate identity every render; only threadId should re-arm this
  }, [threadId]);

  return (
    <Sheet
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
        <SheetDescription className="sr-only">
          SMS conversation with {customerName ?? 'this customer'}
        </SheetDescription>
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3 pr-12">
          <div className="min-w-0">
            <SheetTitle className="truncate text-sm font-semibold">
              {customerName ?? 'Conversation'}
            </SheetTitle>
            <p className="text-[11px] text-text-secondary">SMS conversation</p>
          </div>
        </div>

        {/* Body */}
        {isLoading ? (
          <div className="flex flex-1 items-center justify-center">
            <span role="status" className="flex items-center gap-2 text-sm text-text-secondary">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading conversation…
            </span>
          </div>
        ) : messages.length === 0 ? (
          <EmptyState icon={MessageSquare} title="No messages in this conversation yet." className="flex-1 px-6" />
        ) : (
          <div className="flex-1 space-y-2 overflow-y-auto bg-background-light px-3 py-3">
            {messages.map((m) => {
              const out = m.direction === 'out';
              const note = deliveryNote(m);
              return (
                <div key={m.id} className={cn('flex', out ? 'justify-end' : 'justify-start')}>
                  <div
                    className={cn(
                      'max-w-[80%] rounded-2xl px-3 py-1.5 text-[13px]',
                      out
                        ? `rounded-br-sm ${outboundBubbleClass(note.tone)}`
                        : 'rounded-bl-sm border border-border bg-surface-light text-text-primary',
                    )}
                  >
                    {m.body}
                    {note.label && (
                      <span title={note.title} className="mt-0.5 block text-[9px] font-semibold">
                        {note.label}
                      </span>
                    )}
                    <span
                      className={cn(
                        'mt-0.5 block text-[9px]',
                        out
                          ? note.tone === 'danger'
                            ? 'text-danger/70'
                            : note.tone === 'muted'
                              ? 'text-text-secondary'
                              : 'text-on-fill/70'
                          : 'text-text-secondary',
                      )}
                    >
                      {bubbleTime(m.ts, tz)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
