import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Mail, PanelLeft, Paperclip, PenLine, Star } from 'lucide-react';

import { ComposeWindow } from '@/components/communication/inbox/ComposeWindow';
import { ManageDirectoryModal } from '@/components/communication/inbox/InboxDirectory';
import { JobBadge } from '@/components/communication/shared/atoms';
import { useAppAbility } from '@/contexts/AbilityContext';
import { useMediaQuery } from '@/hooks/useIsMobile';
import { useAuthStore, userDisplayName } from '@/stores/auth.store';
import {
  emailSendErrorMessage, useEmailGroups, useEmails, senderLabel, senderAddress,
  useForwardRules, useMarkEmailThreadRead, useMarkEmailThreadUnread, useSendEmail, useSendingIdentity, useTeamMembers,
} from '@/lib/api/communication';
import type {
  AccountId, ComposeState, Email, EmailGroup, ForwardRule, ReplyDraft, TeamMember,
} from '@/lib/api/communication';

import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { SearchInput } from '@/ui-kit/components/form/searchInput';
import { PageHeader } from '@/ui-kit/components/layout/pageHeader';
import { Avatar } from '@/ui-kit/components/ui/avatar';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { cn } from '@/ui-kit/lib/utils';

import { ConnectionChip, type ConnectionState } from './components/connectionChip';
import { EM_DASH } from './components/glyphs';
import { InboxRail, type Folder } from './components/inboxRail';
import { ReadingPane } from './components/readingPane';
import { useRecordVisit } from '../pageBreadcrumbs';

/**
 * /v2/communication/inbox - the Gmail-style three-pane mail client on the kit.
 *
 * Presentation swap. Everything that decides what happens is the legacy page's:
 * the seam hooks, the unguarded re-seed effects, the thread grouping, the
 * optimistic send/draft/archive/star mutations, the Google consent-return
 * handling, and the read-state persistence that is gated on
 * `read Communication` (#2049) - marking one's own inbox read is a read-side
 * right, mirroring the backend route's own gate, so a TECHNICIAN or any role
 * holding `access_inbox` without `update` still persists their read marker
 * instead of losing it to the next poll or reload.
 *
 * Three things are deliberately kept as they are, each of which a "tidy-up"
 * would quietly break:
 *
 *   ReadingPane is rendered TWICE - the desktop column and the mobile overlay -
 *   each with its own expanded/menu state, exactly as the legacy page mounts
 *   it. Folding them into one instance deletes the mobile reading path.
 *
 *   `flash()` stays a page-local pill on its own 2.6s timer rather than moving
 *   to sonner. Where a message appears and how long it lives is behaviour.
 *
 *   The CASL gate swaps ONLY the message list. The rail keeps rendering the
 *   roster, the groups and the forwarding rules for a user the backend 403s -
 *   a real leak, logged in the ledger, not closed here.
 */

/** The conversation key for an email. Messages with the same key form a thread. */
function threadKey(e: Email): string {
  return e.threadId ?? e.id;
}

/**
 * The id for a row this page mints itself - an optimistic sent message, or a
 * locally-saved draft. `e_` for a message, `t_` for a new thread.
 *
 * Module scope, not a closure in the component: the clock is read when a
 * send/draft handler CALLS this, which is exactly the moment the inline
 * `e_${Date.now()}` literals it replaces read it. `react-hooks/purity` rejects
 * a clock read anywhere the compiler thinks render can reach, and it cannot see
 * that the four builders below only ever run from a click (they reach the child
 * components through the `readingPaneProps` object rather than as a JSX handler
 * it can classify).
 */
function localId(prefix: 'e' | 't'): string {
  return `${prefix}_${Date.now()}`;
}

export default function InboxPage() {
  useRecordVisit('comm-email', 'Inbox');
  // Coarse Communication gate + signed-in user identity. 0 functional gates in
  // this view beyond the list swap below; the ability is read so the page
  // participates in the module's permission story.
  const ability = useAppAbility();
  const user = useAuthStore((s) => s.user);
  const canRead = ability.can('read', 'Communication');
  const ownerName = userDisplayName(user);

  // NO `= []` DEFAULT on a value a seed effect keys on - see the seed effects
  // below and the same note on `InventoryPage` / `PriceBookPage`.
  const { data: emailSeed } = useEmails();
  const { data: groupSeed } = useEmailGroups();
  const { data: forwardSeed } = useForwardRules();
  const { data: members = [] } = useTeamMembers();
  const sendEmail = useSendEmail();

  // The Gmail inbox mirror and its connect surface were deleted upstream, so
  // there is no per-org mailbox to connect, no account health to report and no
  // server-side draft store. What remains is the org's own SENDING IDENTITY:
  // the address a recipient actually sees.
  //
  // Undefined until it loads, and on the plans/roles that cannot reach the
  // endpoint - the compose surfaces fall back to their honest "no mailbox"
  // placeholder for exactly that gap rather than rendering a guess.
  const { data: sendingIdentity } = useSendingIdentity();
  const fromAddress = sendingIdentity?.address;
  // `?? true` while the query is in flight - see ComposeWindow's sendingEnabled
  // doc. Defaulting to false would flash a "sending is off" warning at every
  // user on every open, which is worse than showing it a beat late.
  const sendingEnabled = sendingIdentity?.sendingEnabled ?? true;
  // "Live" now means: there is an address to send from.
  const isLive = Boolean(fromAddress);
  const mailboxState: ConnectionState = !fromAddress
    ? 'disconnected'
    : sendingEnabled
      ? 'connected'
      : 'degraded';
  const canManageMailbox = ability.can('update', 'Organization');
  const markThreadRead = useMarkEmailThreadRead();
  const markThreadUnread = useMarkEmailThreadUnread();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  const memberById = (id: string) => members.find((m) => m.id === id);

  // `?? []` here runs ONCE, in the initialiser, so already-cached data seeds the
  // first render exactly as it used to. What must never come back is a `= []`
  // default on the query itself - see the effects below.
  const [emails, setEmails] = useState<Email[]>((emailSeed as Email[]) ?? []);
  const [groups, setGroups] = useState<EmailGroup[]>(groupSeed ?? []);
  const [forwards, setForwards] = useState<ForwardRule[]>(forwardSeed ?? []);

  // Re-seed on EVERY seed change, not only the first - that is the legacy
  // page's behaviour and it is kept.
  //
  // GUARDED on the query having resolved, though. These read the raw `data`
  // rather than `data = []`, because the default mints a FRESH array on every
  // render while the query is pending: the dependency then differs every
  // render, the effect re-fires, its setState renders again, and the page spins
  // in `Maximum update depth exceeded` until the tab is unresponsive. Because
  // the render loop starves React's commit, the symptom shows up as ROUTING -
  // the URL changes and the sidebar highlight moves, but the next page never
  // appears. The Communication queries return undefined whenever the module is
  // unreachable, so this was the steady state of the page, not an edge case.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- `emails` is not a copy of the query, it is mutated in place by send, star, archive, read and trash before any refetch confirms them; reading the query directly would drop every optimistic row
  useEffect(() => { if (emailSeed) setEmails(emailSeed as Email[]); }, [emailSeed]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- ManageDirectoryModal edits `groups` through its own setGroups, so the mirror holds unsaved group membership the query does not have yet
  useEffect(() => { if (groupSeed) setGroups(groupSeed); }, [groupSeed]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- same as groups: the forwarding-rules tab writes into `forwards` locally, so it cannot be replaced by the query value
  useEffect(() => { if (forwardSeed) setForwards(forwardSeed); }, [forwardSeed]);

  const [folder, setFolder] = useState<Folder>('inbox');
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [compose, setCompose] = useState<ComposeState | null>(null);
  const [reply, setReply] = useState<ReplyDraft | null>(null);
  const [manageTab, setManageTab] = useState<null | 'members' | 'groups' | 'forwarding'>(null);
  // The rail collapses to free up screen space. It auto-collapses when a
  // message is opened ONLY below `lg`, where the reader takes over the screen
  // as a full-width overlay (see the lg:hidden reader further down); at >=lg
  // all three panes fit side by side, so collapsing the rail on every message
  // open was pure loss (#1343). It can always be reopened by hand at any width.
  const [railOpen, setRailOpen] = useState(true);
  // Same literal query as the v1 inbox / LineItemsEditor so the useMediaQuery
  // effect dep stays stable across renders.
  const isNarrow = useMediaQuery('(max-width: 1023.98px)');

  function flash(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2600);
  }

  // No Google consent-return handling: the OAuth connect flow that redirected
  // back here with ?gmail=connected|error was deleted upstream along with the
  // mailbox mirror, so there is no callback to land.

  // One row per conversation: the latest message in the current folder for each
  // thread, plus the total message count across all folders (Gmail-style).
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = emails
      .filter((e) => (folder === 'starred' ? e.starred : e.folder === folder))
      .filter((e) => folder !== 'inbox' || !e.snoozedUntil)
      .filter(
        (e) =>
          !q ||
          e.subject.toLowerCase().includes(q) ||
          e.snippet.toLowerCase().includes(q) ||
          // senderLabel, not from.name: a nameless sender stores null there, and
          // `null.toLowerCase()` throws - one bare-address reply in the list
          // would take the whole page down on the first keystroke.
          senderLabel(e.from).toLowerCase().includes(q) ||
          senderAddress(e.from).toLowerCase().includes(q),
      );
    const latestByThread = new Map<string, Email>();
    for (const e of matches) {
      const k = threadKey(e);
      const cur = latestByThread.get(k);
      if (!cur || e.ts > cur.ts) latestByThread.set(k, e);
    }
    const totalByThread = new Map<string, number>();
    for (const e of emails) {
      const k = threadKey(e);
      totalByThread.set(k, (totalByThread.get(k) ?? 0) + 1);
    }
    return [...latestByThread.values()]
      .sort((a, b) => b.ts - a.ts)
      .map((e) => ({ email: e, count: totalByThread.get(threadKey(e)) ?? 1 }));
  }, [emails, folder, query]);

  const open = emails.find((e) => e.id === openId) ?? null;
  // Every message in the open conversation, oldest -> newest.
  const openThread = open
    ? emails.filter((e) => threadKey(e) === threadKey(open)).sort((a, b) => a.ts - b.ts)
    : [];

  function countFor(f: Folder): number {
    const set = emails.filter((e) => (f === 'starred' ? e.starred : e.folder === f));
    if (f === 'inbox') return set.filter((e) => e.unread).length;
    return set.length;
  }

  function openEmail(id: string) {
    setOpenId(id);
    setReply(null);
    // Narrow viewports only - see the railOpen declaration (#1343).
    if (isNarrow) setRailOpen(false);
    // Live mode: persist read-state server-side for the whole conversation, so
    // the top-bar Mail badge stays truthful across devices and reloads. Gated on
    // `read Communication` (#2049 L1) - the backend route itself is gated on
    // `read`, not `update` (slice 1), because persisting one's OWN read marker
    // is a read-side right: a TECHNICIAN or any role holding `access_inbox`
    // without `update` must still have opening an email move the badge, not
    // just the local React state.
    const clicked = emails.find((e) => e.id === id);
    if (clicked && isLive && canRead) {
      const k = threadKey(clicked);
      if (emails.some((e) => threadKey(e) === k && e.unread)) markThreadRead.mutate(k);
    }
    setEmails((prev) => {
      const target = prev.find((e) => e.id === id);
      if (!target) return prev;
      const k = threadKey(target);
      return prev.map((e) => (threadKey(e) === k ? { ...e, unread: false } : e));
    });
  }

  function toggleStar(id: string) {
    setEmails((prev) => prev.map((e) => (e.id === id ? { ...e, starred: !e.starred } : e)));
  }

  // Generic patch - backs the reading-pane actions (mark unread, snooze, mark
  // important, mute, report spam).
  //
  // #2049 - "Mark as unread" (`patch.unread === true`) now also PERSISTS,
  // mirroring `openEmail`'s read-side persistence above: it used to be
  // React-state-only, so a reload or the next poll silently restored it read.
  function updateEmail(id: string, patch: Partial<Email>) {
    if (patch.unread === true && isLive) {
      const target = emails.find((e) => e.id === id);
      if (target) markThreadUnread.mutate(threadKey(target));
    }
    setEmails((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  }

  function archive(id: string) {
    setEmails((prev) => prev.map((e) => (e.id === id ? { ...e, folder: 'archive' } : e)));
    setOpenId(null);
    flash('Conversation archived');
  }

  // 'system' is the only account id left: the Gmail provider was removed.
  const defaultAccount: AccountId = 'system';

  function startCompose() {
    setCompose({ mode: 'new', account: defaultAccount, to: '', subject: '', body: '' });
  }

  // Email a teammate directly, or a whole group (comma-joined recipients).
  function emailMember(m: TeamMember) {
    setCompose({ mode: 'new', account: defaultAccount, to: m.email, subject: '', body: '' });
    flash(`✉️ New email to ${m.name}`);
  }
  function emailGroup(g: EmailGroup) {
    const to = g.memberIds
      .map((id) => memberById(id)?.email)
      .filter(Boolean)
      .join(', ');
    setCompose({ mode: 'new', account: defaultAccount, to, subject: '', body: '' });
    flash(`✉️ New group email to ${g.name} (${g.memberIds.length})`);
  }

  function quoted(email: Email): string {
    const rule = EM_DASH.repeat(3);
    return `\n\n\n${rule}\nOn ${email.at}, ${email.from.name} <${email.from.email}> wrote:\n${email.body.join('\n')}`;
  }

  // Reply and forward open INLINE under the thread. The body starts empty
  // (cursor-ready); the original shows as a collapsed quote in the composer.
  function startReply(email: Email) {
    setReply({
      emailId: email.id,
      mode: 'reply',
      account: email.account,
      to: senderAddress(email.from),
      subject: email.subject.startsWith('Re:') ? email.subject : `Re: ${email.subject}`,
      body: '',
    });
  }

  function startForward(email: Email) {
    setReply({
      emailId: email.id,
      mode: 'forward',
      account: email.account,
      to: '',
      subject: email.subject.startsWith('Fwd:') ? email.subject : `Fwd: ${email.subject}`,
      body: '',
    });
  }

  function nextTs(): number {
    return emails.reduce((m, e) => Math.max(m, e.ts), 0) + 1;
  }
  function nowLabel(): string {
    return new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  function bodyToParas(text: string): string[] {
    const t = text.trim();
    return t ? t.split(/\n{2,}/) : ['(no content)'];
  }

  // Send the inline reply: the typed body plus the quoted original, filed to Sent.
  function sendReply() {
    if (!reply) return;
    const to = reply.to.trim();
    if (!to) {
      flash('Add a recipient first');
      return;
    }
    const fromEmail = fromAddress ?? '';
    const orig = emails.find((e) => e.id === reply.emailId);
    const fullText = (reply.body.trim() + (orig ? quoted(orig) : '')).trim();
    const atts = reply.attachments ?? [];
    const sent: Email = {
      id: localId('e'),
      threadId: orig ? threadKey(orig) : localId('t'),
      account: reply.account,
      from: { name: ownerName, email: fromEmail },
      to,
      subject: reply.subject.trim() || '(no subject)',
      snippet: reply.body.trim().replace(/\s+/g, ' ').slice(0, 100) || '(no content)',
      body: bodyToParas(fullText),
      at: nowLabel(),
      ts: nextTs(),
      unread: false,
      starred: false,
      folder: 'sent',
      hasAttachment: atts.length > 0,
      attachments: atts.length ? atts : undefined,
    };
    setEmails((prev) => [sent, ...prev]);
    sendEmail.mutate(
      {

        to,
        subject: sent.subject,
        body: bodyToParas(fullText),
        thread_id: sent.threadId,
        // Live replies thread through Gmail (In-Reply-To/References + threadId).
        ...(isLive && reply.mode === 'reply' && orig ? { reply_to_email_id: orig.id } : {}),
      },
      {
        onError: (err) => {
          flash(emailSendErrorMessage(err));
          // Drop the optimistic row - the refetch restores server truth.
          queryClient.invalidateQueries({ queryKey: ['communication', 'emails'] });
        },
      },
    );
    setReply(null);
    flash(`✓ Email sent to ${to}`);
  }

  // Discarding an inline reply with content saves a draft; empty just closes.
  function discardReply() {
    if (!reply) return;
    if (reply.body.trim()) {
      const orig = emails.find((e) => e.id === reply.emailId);
      const draft: Email = {
        id: localId('e'),
        threadId: orig ? threadKey(orig) : localId('t'),

        from: { name: ownerName, email: fromAddress ?? '' },
        to: reply.to.trim() || '(no recipient)',
        subject: reply.subject.trim() || '(no subject)',
        snippet: reply.body.trim().replace(/\s+/g, ' ').slice(0, 100) || '(draft)',
        body: bodyToParas(reply.body),
        at: nowLabel(),
        ts: nextTs(),
        unread: false,
        starred: false,
        folder: 'drafts',
        account: defaultAccount,
      };
      setEmails((prev) => [draft, ...prev]);
      // Local-only: the server-side draft store went with the Gmail mirror.
      flash('Draft saved');
    }
    setReply(null);
  }

  // Pop the inline reply out into the floating compose window.
  function popOutReply() {
    if (!reply) return;
    const orig = emails.find((e) => e.id === reply.emailId);
    setCompose({
      mode: reply.mode,
      account: reply.account,
      to: reply.to,
      subject: reply.subject,
      body: reply.body + (orig ? quoted(orig) : ''),
      threadId: orig ? threadKey(orig) : undefined,
      replyToEmailId: reply.mode === 'reply' ? reply.emailId : undefined,
    });
    setReply(null);
  }

  function sendCompose() {
    if (!compose) return;
    const to = compose.to.trim();
    if (!to) {
      flash('Add a recipient first');
      return;
    }
    const fromEmail = fromAddress ?? '';
    const text = compose.body.trim();
    const atts = compose.attachments ?? [];
    const sent: Email = {
      id: localId('e'),
      threadId: compose.threadId ?? localId('t'),
      account: compose.account,
      from: { name: ownerName, email: fromEmail },
      to,
      subject: compose.subject.trim() || '(no subject)',
      snippet: text.replace(/\s+/g, ' ').slice(0, 100) || '(no content)',
      body: bodyToParas(compose.body),
      at: nowLabel(),
      ts: nextTs(),
      unread: false,
      starred: false,
      folder: 'sent',
      hasAttachment: atts.length > 0,
      attachments: atts.length ? atts : undefined,
    };
    setEmails((prev) => [sent, ...prev]);
    sendEmail.mutate(
      {

        to,
        subject: sent.subject,
        body: bodyToParas(compose.body),
        thread_id: sent.threadId,
        // A popped-out reply keeps its Gmail threading.
        ...(isLive && compose.replyToEmailId ? { reply_to_email_id: compose.replyToEmailId } : {}),
      },
      {
        onError: (err) => {
          flash(emailSendErrorMessage(err));
          queryClient.invalidateQueries({ queryKey: ['communication', 'emails'] });
        },
      },
    );
    setCompose(null);
    flash(
      `✓ Email sent to ${to}${atts.length ? ` with ${atts.length} attachment${atts.length === 1 ? '' : 's'}` : ''}`,
    );
  }

  // Closing with content saves a draft; empty just closes.
  function closeCompose() {
    if (!compose) return;
    const hasContent = compose.to.trim() || compose.subject.trim() || compose.body.trim();
    if (hasContent) {
      const draft: Email = {
        id: localId('e'),
        threadId: compose.threadId ?? localId('t'),

        from: { name: ownerName, email: fromAddress ?? '' },
        to: compose.to.trim() || '(no recipient)',
        subject: compose.subject.trim() || '(no subject)',
        snippet: compose.body.trim().replace(/\s+/g, ' ').slice(0, 100) || '(draft)',
        body: bodyToParas(compose.body),
        at: nowLabel(),
        ts: nextTs(),
        unread: false,
        starred: false,
        folder: 'drafts',
        account: defaultAccount,
      };
      setEmails((prev) => [draft, ...prev]);
      // Local-only: the server-side draft store went with the Gmail mirror.
      flash('Draft saved');
    }
    setCompose(null);
  }

  const readingPaneProps = open
    ? {
        email: open,
        thread: openThread,
        reply: reply && reply.emailId === open.id ? reply : null,
        onReplyChange: setReply,
        onSendReply: sendReply,
        onDiscardReply: discardReply,
        onPopOutReply: popOutReply,
        onBack: () => {
          setOpenId(null);
          setReply(null);
        },
        onStar: () => toggleStar(open.id),
        onArchive: () => {
          setReply(null);
          archive(open.id);
        },
        onReply: () => startReply(open),
        onForward: () => startForward(open),
        onUpdateEmail: updateEmail,
        onToast: flash,
        fromAddress,
        onTrash: () => {
          setEmails((prev) => prev.filter((e) => e.id !== open.id));
          setOpenId(null);
          setReply(null);
          flash('Moved to Trash');
        },
      }
    : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        className="mb-3 shrink-0"
        title={
          <span className="flex items-center gap-2">
            <span className="bg-primary text-primary-foreground flex size-7 items-center justify-center rounded-lg">
              <Mail className="size-4" />
            </span>
            Inbox
            {/* The mailbox's state belongs to the heading, not to the action
                row it used to share with Compose. `degraded` is a real third
                state here: the account exists but Google needs re-consent, so
                mail neither sends nor syncs - amber, not green and not red. */}
            <ConnectionChip
              state={mailboxState}
              label={
                mailboxState === 'connected'
                  ? `Sending as ${fromAddress}`
                  : mailboxState === 'degraded'
                    ? 'Sending is off'
                    : 'No sender address set'
              }
            />
          </span>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {/* No Connect/Reconnect action: the Gmail OAuth surface was deleted
                upstream. The sender address is configured in Settings now, and
                the chip beside the title reports its state. */}
            <Button onClick={startCompose}>
              <PenLine /> Compose
            </Button>
          </div>
        }
      />

      {/* Three-pane: folders · list · reader */}
      <div className="flex min-h-0 flex-1 overflow-hidden rounded-lg border">
        {railOpen ? (
          <InboxRail
            folder={folder}
            onFolder={(f) => {
              setFolder(f);
              setOpenId(null);
            }}
            countFor={countFor}
            members={members}
            groups={groups}
            forwards={forwards}
            memberName={(id) => memberById(id)?.name}
            onManage={setManageTab}
            onEmailMember={emailMember}
            onEmailGroup={emailGroup}
            onCollapse={() => setRailOpen(false)}
          />
        ) : (
          <div className="bg-kit-card flex w-11 flex-none flex-col items-center border-r py-3">
            <Button
              variant="ghost"
              size="icon-sm"
              title="Open menu"
              aria-label="Open menu"
              onClick={() => setRailOpen(true)}
            >
              <PanelLeft />
            </Button>
          </div>
        )}

        {/* Email list */}
        <div
          className={cn(
            'bg-kit-card flex min-w-0 flex-col border-r',
            open ? 'hidden w-96 flex-none lg:flex' : 'flex-1',
          )}
        >
          <div className="border-b p-3">
            <SearchInput value={query} onValueChange={setQuery} placeholder="Search mail" />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {!canRead ? (
              <EmptyState title="You don't have access to the inbox." />
            ) : visible.length === 0 ? (
              <EmptyState title="Nothing here." />
            ) : (
              visible.map(({ email: e, count }) => {
                const isOpen = threadKey(e) === (open ? threadKey(open) : '');
                return (
                  <Button
                    key={e.id}
                    variant="ghost"
                    onClick={() => openEmail(e.id)}
                    aria-pressed={isOpen}
                    className={cn(
                      'h-auto w-full items-start justify-start gap-3 rounded-none border-b px-3 py-3 text-left',
                      isOpen && 'bg-muted text-foreground',
                    )}
                  >
                    <Avatar name={senderLabel(e.from)} className="mt-0.5" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span
                            className={cn(
                              'text-foreground truncate text-[13px]',
                              e.unread ? 'font-bold' : 'font-medium',
                            )}
                          >
                            {folder === 'sent' || folder === 'drafts'
                              ? `To: ${e.to}`
                              : e.from.name}
                          </span>
                          {count > 1 && (
                            <span className="flex-none text-[11px] font-semibold">{count}</span>
                          )}
                        </span>
                        <span className="flex flex-none items-center gap-1.5">
                          {e.hasAttachment && <Paperclip className="size-3" />}
                          <span
                            className={cn(
                              'text-[11px]',
                              e.unread ? 'text-brand font-semibold' : 'font-normal',
                            )}
                          >
                            {e.at}
                          </span>
                        </span>
                      </span>
                      <span
                        className={cn(
                          'mt-0.5 block truncate text-[13px]',
                          e.unread ? 'text-foreground font-semibold' : 'font-normal',
                        )}
                      >
                        {e.subject}
                      </span>
                      <span className="mt-0.5 flex items-center gap-1.5">
                        <span className="truncate text-[12px] font-normal">{e.snippet}</span>
                      </span>
                      <span className="mt-1 flex items-center gap-1.5">
                        {e.labels?.map((l) => (
                          <Badge key={l} variant="softNeutral" size="sm">
                            {l}
                          </Badge>
                        ))}
                        {/* Accepted deviation from the badge-every-message rule:
                            dense LIST rows stay tagged-only, so there is no
                            "no job" noise. The unconditional badge lives on the
                            reading pane's per-message headers. */}
                        {e.jobLabel && <JobBadge job={e.jobLabel} />}
                      </span>
                    </span>
                    {/* A role-carrying span, not a nested <button>: this control
                        lives INSIDE the row control, and a button inside a
                        button is invalid HTML. Enter and Space activate it, so
                        it keeps the keyboard path a button would have had. */}
                    <span
                      role="button"
                      tabIndex={0}
                      aria-label={e.starred ? 'Unstar' : 'Star'}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        toggleStar(e.id);
                      }}
                      onKeyDown={(ev) => {
                        if (ev.key === 'Enter' || ev.key === ' ') {
                          ev.preventDefault();
                          ev.stopPropagation();
                          toggleStar(e.id);
                        }
                      }}
                      className="hover:bg-muted mt-0.5 flex-none rounded p-0.5"
                    >
                      <Star
                        className={cn(
                          'size-4',
                          e.starred && 'fill-status-amber text-status-amber',
                        )}
                      />
                    </span>
                  </Button>
                );
              })
            )}
          </div>
        </div>

        {/* Reading pane - rendered only when a message is open, so an empty
            inbox shows the full-width list with no dead right column. */}
        {readingPaneProps && (
          <div className="bg-app hidden min-w-0 flex-1 flex-col lg:flex">
            <ReadingPane {...readingPaneProps} />
          </div>
        )}
      </div>

      {/* Mobile/narrow reading overlay - a SECOND instance on purpose. */}
      {readingPaneProps && (
        <div className="bg-kit-card fixed inset-0 z-40 flex flex-col lg:hidden">
          <ReadingPane {...readingPaneProps} />
        </div>
      )}

      {compose && (
        <ComposeWindow
          state={compose}
          onChange={setCompose}
          onSend={sendCompose}
          onClose={closeCompose}
          onToast={flash}
          fromAddress={fromAddress}
          sendingEnabled={sendingEnabled}
          onDiscard={() => {
            setCompose(null);
            flash('Draft discarded');
          }}
        />
      )}

      {manageTab && (
        <ManageDirectoryModal
          initialTab={manageTab}
          members={members}
          groups={groups}
          setGroups={setGroups}
          forwards={forwards}
          setForwards={setForwards}
          onClose={() => setManageTab(null)}
          onEmailMember={(m) => {
            setManageTab(null);
            emailMember(m);
          }}
          onEmailGroup={(g) => {
            setManageTab(null);
            emailGroup(g);
          }}
          flash={flash}
        />
      )}

      {toast && (
        <div className="bg-primary text-primary-foreground pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg px-4 py-2.5 text-sm font-medium shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}
