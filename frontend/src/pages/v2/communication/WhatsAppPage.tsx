import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, CheckCheck, Paperclip, Phone, Send, Smile } from 'lucide-react';

import { JobBadge } from '@/components/communication/shared/atoms';
import {
  useMarkWhatsAppChatRead,
  useSendWhatsApp,
  useWhatsAppChats,
  whatsAppSendErrorMessage,
} from '@/lib/api/communication';
import type { WAChat, WAMessage, WAStatus } from '@/lib/api/communication';
import { formatInstant, useScheduleTimezone } from '@/lib/schedule-tz';
import { formatPhone } from '@/lib/utils';

import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { SearchInput } from '@/ui-kit/components/form/searchInput';
import { PageHeader } from '@/ui-kit/components/layout/pageHeader';
import { Avatar } from '@/ui-kit/components/ui/avatar';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { Input } from '@/ui-kit/components/ui/input';
import { cn } from '@/ui-kit/lib/utils';

import { WhatsAppGlyph } from '../WhatsAppGlyph';
import { ConnectionChip } from './components/connectionChip';
import { useRecordVisit } from '../pageBreadcrumbs';

/**
 * /v2/communication/whatsapp - the WhatsApp Business two-pane inbox on the kit.
 *
 * Presentation swap only. Every hook, the optimistic send + rollback, the
 * hydrate-once ref, the search predicate, the unread clearing and the
 * auto-scroll effect are the legacy page's, carried across unchanged.
 *
 * Two things that look like candidates for a kit component and deliberately are
 * not:
 *
 *   The WhatsApp greens stay on their own token family. Brand identity carries
 *   meaning here in the same way a chart's green-up/red-down does - recolouring
 *   a WhatsApp thread in the CRM's brand teal would make it read as an ordinary
 *   SMS lane. `--whatsapp*` is already a token family in tokens.css; no raw hex
 *   is introduced.
 *
 *   The "Calling {name}..." pill stays a page-local toast rather than moving to
 *   sonner. The legacy page renders its own, dismissed by its own 2.6s timer,
 *   and swapping toasters changes where a message appears and how long it lives
 *   - behaviour, not chrome.
 *
 * There is NO ability gate on this page, exactly as on the legacy one. The
 * route-level `phone` entitlement is the only gate the module has here, and
 * adding a CASL check would change who can reach it.
 */

function StatusTicks({ status }: { status?: WAStatus }) {
  if (!status) return null;
  if (status === 'read') return <CheckCheck className="size-3.5 text-status-blue" />;
  if (status === 'delivered') return <CheckCheck className="text-subtle-foreground size-3.5" />;
  return <Check className="text-subtle-foreground size-3.5" />;
}

export default function WhatsAppPage() {
  useRecordVisit('comm-whatsapp', 'WhatsApp');
  const { data: seedChats = [] } = useWhatsAppChats();
  const sendWhatsApp = useSendWhatsApp();
  // #2049 slice 2 - the persisting half of opening a chat (mirrors SMS's
  // openThread -> useMarkThreadRead). Send never zeroes `unread`, so no other
  // call site here needs it.
  const markChatRead = useMarkWhatsAppChatRead();
  const tz = useScheduleTimezone();

  const [chats, setChats] = useState<WAChat[]>(seedChats);
  const [activeId, setActiveId] = useState<string>('');
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Adopt the seed the first time it arrives; local state owns every optimistic
  // mutation after that.
  const hydrated = useRef(false);

  useEffect(() => {
    if (hydrated.current || seedChats.length === 0) return;
    hydrated.current = true;
    setChats(seedChats);
    setActiveId((prev) => prev || (seedChats[0]?.id ?? ''));
  }, [seedChats]);

  const active = chats.find((c) => c.id === activeId) ?? chats[0];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return chats;
    return chats.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.org.toLowerCase().includes(q) ||
        c.phone.includes(q),
    );
  }, [chats, query]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeId, active?.messages.length]);

  function openChat(id: string) {
    setActiveId(id);
    setChats((prev) => prev.map((c) => (c.id === id ? { ...c, unread: 0 } : c)));
    markChatRead.mutate(id);
  }

  function send() {
    const text = draft.trim();
    if (!text || !active) return;
    const prevLastAt = active.lastAt;
    const now = new Date();
    // The company clock, not the viewer's browser zone - every other comm
    // surface stamps through the org zone, and a bubble timestamped in a
    // technician's local zone reads as a different time to the office.
    const at = formatInstant(now, tz, { hour: 'numeric', minute: '2-digit' });
    const msg: WAMessage = { id: `m_${Date.now()}`, from: 'us', text, at, status: 'sent' };
    setChats((prev) =>
      prev.map((c) =>
        c.id === active.id ? { ...c, messages: [...c.messages, msg], lastAt: at } : c,
      ),
    );
    setSendError(null);
    setDraft('');
    sendWhatsApp.mutate(
      { chat_id: active.id, text },
      {
        onError: (err) => {
          setChats((prev) =>
            prev.map((c) =>
              c.id !== active.id
                ? c
                : {
                    ...c,
                    messages: c.messages.filter((m) => m.id !== msg.id),
                    lastAt: prevLastAt,
                  },
            ),
          );
          setDraft(text);
          setSendError(whatsAppSendErrorMessage(err));
        },
      },
    );
  }

  const totalUnread = chats.reduce((s, c) => s + c.unread, 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        className="mb-0 shrink-0"
        title={
          <span className="flex items-center gap-2">
            <span className="bg-whatsapp text-on-fill flex size-7 items-center justify-center rounded-lg">
              <WhatsAppGlyph className="size-4" />
            </span>
            WhatsApp
            {/* Next to the heading, not in the action row - this is a fact
                about the page, not something to press. */}
            <ConnectionChip state="disconnected" label="Not connected" />
          </span>
        }
        description="WhatsApp Business is not connected, so nothing typed here reaches the customer. Use Text or Email until the WhatsApp Business integration ships."
        actions={
          totalUnread > 0 ? (
            <Badge variant="green" size="pill">
              {totalUnread} unread
            </Badge>
          ) : undefined
        }
      />

      <div className="flex min-h-0 flex-1 overflow-hidden rounded-lg border">
        {/* Conversation list */}
        <div className="bg-kit-card flex w-80 flex-none flex-col border-r">
          <div className="border-b p-3">
            <SearchInput value={query} onValueChange={setQuery} placeholder="Search chats" />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {filtered.length === 0 ? (
              <EmptyState title={`No chats match "${query}".`} />
            ) : (
              filtered.map((c) => {
                const last = c.messages[c.messages.length - 1];
                const isActive = c.id === active?.id;
                return (
                  <Button
                    key={c.id}
                    variant="ghost"
                    onClick={() => openChat(c.id)}
                    aria-pressed={isActive}
                    className={cn(
                      'h-auto w-full items-start justify-start gap-3 rounded-none border-b px-3 py-3 text-left',
                      isActive && 'bg-muted text-foreground',
                    )}
                  >
                    <Avatar name={c.name} size="lg" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-2">
                        <span className="text-foreground truncate text-[13px] font-semibold">
                          {c.name}
                        </span>
                        <span className="flex-none text-[11px] font-normal">{c.lastAt}</span>
                      </span>
                      <span className="mt-0.5 flex items-center justify-between gap-2">
                        <span className="truncate text-[12px] font-normal">
                          {last ? `${last.from === 'us' ? 'You: ' : ''}${last.text}` : c.org}
                        </span>
                        {c.unread > 0 && (
                          <Badge variant="green" size="pill" className="flex-none">
                            {c.unread}
                          </Badge>
                        )}
                      </span>
                    </span>
                  </Button>
                );
              })
            )}
          </div>
        </div>

        {/* Chat thread */}
        <div className="bg-whatsapp-canvas flex min-w-0 flex-1 flex-col">
          <div className="bg-kit-card flex items-center gap-3 border-b px-5 py-2.5">
            <Avatar name={active?.name ?? ''} />
            <div className="min-w-0 flex-1">
              <p className="text-foreground truncate text-sm font-semibold">{active?.name}</p>
              <p className="text-muted-foreground truncate text-[12px]">
                {active?.org} · {formatPhone(active?.phone)}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Call ${active?.name ?? ''}`}
              onClick={() => {
                if (!active) return;
                setToast(`📞 Calling ${active.name}…`);
                setTimeout(() => setToast(null), 2600);
              }}
            >
              <Phone />
            </Button>
          </div>

          <div ref={scrollRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-6 py-4">
            {active?.messages.map((m) => {
              const mine = m.from === 'us';
              return (
                <div key={m.id} className={mine ? 'flex justify-end' : 'flex justify-start'}>
                  <div className="max-w-[72%]">
                    <div
                      className={
                        mine
                          ? 'bg-whatsapp-bubble text-foreground rounded-lg rounded-tr-none px-3 py-2 shadow-sm'
                          : 'bg-kit-card text-foreground rounded-lg rounded-tl-none px-3 py-2 shadow-sm'
                      }
                    >
                      <p className="text-[13.5px] leading-relaxed">{m.text}</p>
                      <p className="text-muted-foreground mt-0.5 flex items-center justify-end gap-1 text-[10.5px]">
                        {m.at}
                        {mine && <StatusTicks status={m.status} />}
                      </p>
                    </div>
                    {/* Variant A job pill - every customer-chat bubble is
                        badged: job number when tagged, muted "no job" when
                        unattributed. */}
                    <div className={mine ? 'mt-1 flex justify-end' : 'mt-1 flex justify-start'}>
                      <JobBadge job={m.jobLabel} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {sendError && (
            <p
              role="status"
              className="border-status-red-subtle bg-status-red-subtle text-status-red-emphasis border-t px-4 py-1.5 text-[11px] font-medium"
            >
              {sendError}
            </p>
          )}

          <div className="bg-kit-card flex items-center gap-2 border-t px-4 py-3">
            <Button variant="ghost" size="icon-sm" aria-label="Emoji">
              <Smile />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="Attach">
              <Paperclip />
            </Button>
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder="Type a message"
              className="flex-1"
            />
            <Button
              size="icon"
              onClick={send}
              disabled={!draft.trim()}
              aria-label="Send"
              className="bg-whatsapp hover:bg-whatsapp-dark shrink-0 rounded-full"
            >
              <Send />
            </Button>
          </div>
        </div>
      </div>

      {toast && (
        <div className="bg-primary text-primary-foreground pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg px-4 py-2.5 text-sm font-medium shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}
