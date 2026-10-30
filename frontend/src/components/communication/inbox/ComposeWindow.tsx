// Inbox module — Gmail-style compose surfaces.
//
// Extracted from the original InboxPage monolith:
//   • ComposeWindow      (L1203) — docked bottom-right window (new / reply / forward)
//   • ComposerToolbar    (L1376) — formatting / attach / emoji / link / image / template bar
//   • InlineComposer     (L1980) — inline reply/forward at the bottom of a thread
//   • AccountChip        (L1172) — from-account pill (shared with InlineComposer)
//   • AttachmentChips / filesToAttachments / fmtFileSize — attachment plumbing
//   • AttachFromRecord   — "attach from this record" chips (email slice 7)
//   • useUndoSend        — Gmail-style undo-send timer (email slice 7)
//   • IconBtn            (L2147) — square icon button (also used by the reader)
//
// Faithful cut — every prop signature and behaviour preserved verbatim. The
// compose overlays are hand-rolled (the original build never used a Modal abstraction in
// comms), so they stay as fixed-position cards; only tokens were swapped:
//   1. Tailwind tokens indigo/slate -> ALPHA design tokens. The slate-800 title
//      bar and slate-100 quote chip are intentionally kept (compose chrome).
//   2. The single connected mailbox identity (ACCOUNTS / PRIMARY_ACCOUNT) and
//      the Email/ComposeState/ReplyDraft/Attachment/Account types now come from
//      the `@/lib/api/communication` seam, not module-scope definitions.
//
// Email slice 7 (Resend send path) additions:
//   3. Cc/Bcc collapse behind a toggle next to To, wired into ComposeState/
//      ReplyDraft's own cc?/bcc? fields. Rendered via the shared `Input`
//      primitive's new `variant="ghost"` (components/ui/input.tsx), not a raw
//      `<input>`, to match To/Subject's chromeless look without adding a call
//      site the raw-tag ratchet or layering-guard tests would flag - see
//      `InputVariant`'s own doc comment for why a raw className override
//      wasn't an option (both guards were already at their floor).
//   3a. ComposerToolbar's "Insert template" popover uses `PopoverContent`'s
//      own `width`/`pad` props (not a className override) for the same
//      layering-guard reason.
//   4. Attachment chips now carry the real File through to send - see
//      Attachment.file's doc in communication-shared/email.ts.
//   5. `attachDisabled` is gone (was permanently dead - see decision 6 below).
//   6. ComposerToolbar gained an "Insert template" popover next to the emoji
//      button, reading the same text_templates data the SMS composer uses.
//   7. AttachFromRecord renders one-click chips for a compose draft's
//      attach-by-origin entity (job/customer/estimate/invoice) - conditional,
//      absent entirely on a free compose with no anchor.
import { forwardRef, useRef, useState } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import {
  CornerUpLeft,
  FileText,
  Image as ImageIcon,
  Link as LinkIcon,
  Maximize2,
  Paperclip,
  Send,
  Smile,
  Trash2,
  Type,
  X,
} from "lucide-react";
import { AiAssistMenu } from "@/components/communication/inbox/AiAssistMenu";
import { ADDRESS_NEEDED_MESSAGE } from "@/components/communication/MyMailboxAddress";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  NO_MAILBOX_LABEL,
  PRIMARY_ACCOUNT,
  senderAddress,
  senderLabel,
  useAttachSources,
  useTextTemplates,
} from "@/lib/api/communication";
import type {
  Attachment,
  ComposeOrigin,
  ComposeState,
  Email,
  ReplyDraft,
} from "@/lib/api/communication";
import { canAutoFocus } from "@/ui-kit/lib/autoFocus";
import { Dialog, DialogContent, DialogTitle } from "@/ui-kit/components/ui/dialog";
import { useOverlayPresentation } from "@/ui-kit/hooks/useOverlayPresentation";

/** Human-readable file size for an attachment chip. */
function fmtFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** One real File, reshaped into our (display + real-file) Attachment shape. */
function fileToAttachment(f: File): Attachment {
  return { name: f.name, size: fmtFileSize(f.size), sizeBytes: f.size, mimeType: f.type, file: f };
}

/** Convert a FileList from a file picker into our Attachment shape. Keeps the
 *  real File on every entry now (email slice 7) - it used to discard it and
 *  keep only display strings, which made every attachment silently vanish at
 *  send time. */
export function filesToAttachments(files: FileList | null): Attachment[] {
  if (!files) return [];
  return Array.from(files).map(fileToAttachment);
}

export function AccountChip({
  label,
  dot,
  active,
  onClick,
}: {
  label: string;
  dot?: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium transition",
        active
          ? "bg-primary text-on-fill"
          : "bg-background-light text-text-secondary hover:bg-border",
      ].join(" ")}
    >
      {dot && <span className={`h-1.5 w-1.5 rounded-full ${active ? "bg-on-fill" : dot}`} />}
      {label}
    </button>
  );
}

/** Non-interactive pill shown wherever there is no connected mailbox to send
 *  from - shared by InlineComposer here and InboxPage's From-account header. */
export function NoMailboxChip() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-background-light px-2.5 py-1 text-[12px] font-medium text-text-secondary">
      <span className="h-1.5 w-1.5 rounded-full bg-neutral-strong" />
      {NO_MAILBOX_LABEL}
    </span>
  );
}

/** Copy for an org whose admin has switched outgoing email off. Single source,
 *  so the banner and any future surface cannot word it differently. */
export const SENDING_DISABLED_LABEL = "Email sending is off for this organization";

/**
 * Shown on every compose surface when the org's `email_sending_enabled` is
 * false, alongside a disabled Send.
 *
 * The address is still perfectly well-formed in that state, so the From row
 * goes on showing it - what changes is that a send would be REFUSED. Without
 * this the compose window looked entirely functional and the user only found
 * out at the end, after writing the whole message, when the API answered 409.
 * Telling them before they type is the only honest ordering.
 *
 * Renders nothing when sending is on, so callers can mount it unconditionally.
 */
export function SendingDisabledNotice({ sendingEnabled }: { sendingEnabled: boolean }) {
  if (sendingEnabled) return null;
  return (
    // `w-auto`: the Alert is `w-full`, and full width plus a 16 px margin each side is 32 px wider
    // than the window - clipped by the docked card, a sideways scroll in a full-screen form.
    <Alert tone="warning" role="status" className="mx-4 mt-2 w-auto">
      {SENDING_DISABLED_LABEL}. Ask an admin to turn it back on before sending.
    </Alert>
  );
}

/**
 * The "Sending as" line every compose surface carries (PRD 10, S10.11): the person's OWN address and the name the
 * recipient will see, from the same register lookup the send resolves its From header with. There is no From choice, so
 * there is nothing to pick here. A person with no address yet reads the address-needed sentence in its place (and Send is
 * disabled: see `sendBlockedReason`). With nothing to show it says so honestly, as it always has.
 */
export function SendingAsLine({
  address,
  name,
  addressNeeded = false,
  className,
}: {
  address?: string;
  name?: string;
  addressNeeded?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-2 border-b border-border px-4 py-2", className)}>
      <span className="w-14 flex-none text-[12px] text-text-secondary">Sending as</span>
      {addressNeeded ? (
        <span role="status" className="text-[13px] text-text-secondary">
          {ADDRESS_NEEDED_MESSAGE}
        </span>
      ) : (
        <span className="inline-flex min-w-0 flex-wrap items-center gap-x-1.5 text-[13px] text-text-secondary">
          <span className={`h-1.5 w-1.5 flex-none rounded-full ${address ? PRIMARY_ACCOUNT.dot : "bg-neutral-strong"}`} />
          {address ? (
            <>
              {name ? <span className="text-text-primary">{name}</span> : null}
              <span className="break-all">{name ? `<${address}>` : address}</span>
            </>
          ) : (
            NO_MAILBOX_LABEL
          )}
        </span>
      )}
    </div>
  );
}

/**
 * Why Send is disabled on a compose surface, or undefined when it is not: the person has no address of their own yet, or the
 * company has outgoing email switched off. Single source, so the line, the button's reason and the notice cannot disagree.
 */
export function sendBlockedReason({
  sendingEnabled,
  addressNeeded,
}: {
  sendingEnabled: boolean;
  addressNeeded: boolean;
}): string | undefined {
  if (addressNeeded) return ADDRESS_NEEDED_MESSAGE;
  return sendingEnabled ? undefined : SENDING_DISABLED_LABEL;
}

/** Chips showing attached files, each removable. Renders nothing when empty. */
export function AttachmentChips({
  attachments,
  onRemove,
}: {
  attachments: Attachment[];
  onRemove: (index: number) => void;
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 border-t border-border px-4 py-2.5">
      {attachments.map((a, i) => (
        <span
          key={`${a.name}-${i}`}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background-light py-1 pl-2 pr-1 text-[12px] text-text-primary"
        >
          <Paperclip className="h-3 w-3 text-text-secondary" />
          <span className="max-w-[160px] truncate">{a.name}</span>
          <span className="text-text-secondary">· {a.size}</span>
          <button
            type="button"
            onClick={() => onRemove(i)}
            aria-label={`Remove ${a.name}`}
            className="ml-0.5 rounded p-0.5 text-text-secondary hover:bg-border hover:text-text-primary"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
    </div>
  );
}

/** "Attach from this record" (email slice 7) - one-click chips for a draft's
 *  attach-by-origin entity's EXISTING uploads (GET .../emails/attach-source),
 *  so a compose session can pull in an already-uploaded job photo, estimate
 *  PDF, etc. without leaving the composer. Renders nothing at all when the
 *  draft carries no job/customer/estimate/invoice id (free compose - no
 *  record to attach from) or when that record has no uploads.
 *
 *  The backend read is a signed-URL LIST, not a file reference the send route
 *  can resolve server-side - POST /emails only ever accepts real bytes under
 *  its `files` field. Clicking a chip fetches the signed URL client-side and
 *  wraps the bytes back into a File, so it rides to send exactly like a
 *  freshly-picked one - it re-uploads, it does not alias the original. */
export function AttachFromRecord({
  origin,
  attachments,
  onAttach,
  onToast,
}: {
  origin: ComposeOrigin;
  /** The draft's current attachments - used only to grey out a chip already
   *  pulled in this session (matched by file name). */
  attachments: Attachment[];
  onAttach: (file: File) => void;
  onToast: (m: string) => void;
}) {
  const { data: sources = [] } = useAttachSources(origin);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const attachedNames = new Set(attachments.map((a) => a.name));

  if (sources.length === 0) return null;

  async function pull(src: (typeof sources)[number]) {
    setPendingId(src.id);
    try {
      const res = await fetch(src.file_url);
      if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
      const blob = await res.blob();
      onAttach(new File([blob], src.file_name, { type: src.file_type || blob.type }));
    } catch {
      onToast("Couldn't attach that file - try again");
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-t border-border px-4 py-2.5">
      <span className="flex-none text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
        Attach from this record
      </span>
      {sources.map((src) => {
        const already = attachedNames.has(src.file_name);
        const pending = pendingId === src.id;
        return (
          <Button
            key={src.id}
            type="button"
            variant="outline"
            tone="neutral"
            size="3xs"
            disabled={already || pending}
            onClick={() => pull(src)}
            className="gap-1.5 disabled:cursor-default"
          >
            <Paperclip className="h-3 w-3 text-text-secondary" />
            <span className="max-w-[160px] truncate">{src.display_name || src.file_name}</span>
            {already && <span className="text-text-secondary">· added</span>}
            {pending && <span className="text-text-secondary">…</span>}
          </Button>
        );
      })}
    </div>
  );
}

/** How long a queued compose stays cancellable before the real network send
 *  fires (email slice 7 - Gmail-style Undo Send). */
export const UNDO_SEND_WINDOW_MS = 10_000;

/**
 * Defers a compose send behind a cancellable window instead of firing the
 * network call the instant Send is clicked: `schedule` starts the countdown
 * and closes over the real send; `undo` cancels it and hands back the exact
 * draft that was queued so the caller can reopen the compose surface with it.
 *
 * Deliberately NOT owned by ComposeWindow/InlineComposer themselves - both
 * unmount the moment their caller clears `compose`/`reply` state (which
 * happens right when Send is clicked, Gmail-style), while the pending send
 * must keep counting down regardless. It lives in whichever page owns that
 * state instead (InboxPage, CustomerDetailPage) - see this hook's callers.
 *
 * The `setTimeout` here is deliberately never cleared on unmount: a page
 * navigation within the SPA only unmounts the component holding the ref, it
 * must not silently cancel a send the user already confirmed. Only closing
 * or reloading the tab loses a pending send - there is no service worker in
 * this app to persist the queue past that; an accepted, documented tradeoff.
 */
export function useUndoSend<TDraft>() {
  const pendingRef = useRef<{ timer: ReturnType<typeof setTimeout>; draft: TDraft } | null>(null);

  function schedule(draft: TDraft, fire: () => void, windowMs: number = UNDO_SEND_WINDOW_MS) {
    // Only one pending send per hook instance is possible in practice - Send
    // closes the compose surface, so a second Send cannot happen until this
    // one either fires or is undone. If that ever changes, the newer send
    // simply replaces the older timer's reference rather than stacking two
    // (the discarded timer still fires, but nothing reads its stale draft).
    const timer = setTimeout(() => {
      pendingRef.current = null;
      fire();
    }, windowMs);
    pendingRef.current = { timer, draft };
  }

  /** Cancels the queued send and returns the draft it was holding so the
   *  caller can restore it into an open compose surface. Returns null if
   *  nothing is pending (Undo clicked twice, or after the window elapsed). */
  function undo(): TDraft | null {
    if (!pendingRef.current) return null;
    clearTimeout(pendingRef.current.timer);
    const { draft } = pendingRef.current;
    pendingRef.current = null;
    return draft;
  }

  return { schedule, undo };
}

export const IconBtn = forwardRef<
  HTMLButtonElement,
  {
    label: string;
    onClick?: () => void;
    children: ReactNode;
  } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "children">
>(function IconBtn({ label, onClick, children, className, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        "flex h-8 w-8 items-center justify-center rounded-md text-text-secondary transition hover:bg-background-light hover:text-text-primary",
        className
      )}
      {...rest}
    >
      {children}
    </button>
  );
});

/** Gmail-style formatting/insert toolbar. Attach + emoji + link + template are
 *  live; formatting hints at a richer feature still to come. Shared by the
 *  compose window and inline reply.
 *
 *  `attachDisabled` is gone (decision 6, email slice 7): it gated the file
 *  picker on Boolean(fromAddress), which was permanently false because
 *  nothing has ever set fromAddress since the Gmail connect was deleted - the
 *  picker was already always enabled in practice. Real attachments landing in
 *  this slice make "free compose to any address, always attachable" the only
 *  behaviour that was ever actually live, so the dead conditional is deleted
 *  rather than wired to a new (nonexistent) reason to disable it. */
export function ComposerToolbar({
  onAddFiles,
  onInsert,
  onInsertTemplate,
  onToast,
}: {
  onAddFiles: (files: FileList | null) => void;
  onInsert: (text: string) => void;
  /** Separate from `onInsert`: emoji/link glue onto the end of whatever text
   *  is already there (no separator), but a template is a whole message body
   *  of its own - the caller joins it onto any existing text as its own
   *  paragraph instead of gluing it mid-sentence. */
  onInsertTemplate: (body: string) => void;
  onToast: (m: string) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const EMOJIS = ["🙂", "👍", "🙏", "✅", "🎉", "🚀", "💡", "⚠️", "📅", "📞", "💬", "🔧"];
  // Same text_templates data the SMS composer's template management reads
  // (useTextTemplates, communication.ts) - a signature is just a template a
  // user chooses to keep inserting, so there is no separate "signature"
  // concept or always-on auto-append to build here.
  const { data: templates = [] } = useTextTemplates();
  return (
    <div className="flex items-center gap-0.5">
      <input
        ref={fileRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          onAddFiles(e.target.files);
          e.currentTarget.value = "";
        }}
      />
      <IconBtn label="Formatting" onClick={() => onToast("Rich formatting coming soon")}>
        <Type className="h-4 w-4" />
      </IconBtn>
      <IconBtn label="Attach files" onClick={() => fileRef.current?.click()}>
        <Paperclip className="h-4 w-4" />
      </IconBtn>
      <IconBtn
        label="Insert link"
        onClick={() => {
          onInsert(" https://");
          onToast("Link inserted - edit the URL");
        }}
      >
        <LinkIcon className="h-4 w-4" />
      </IconBtn>
      <Popover open={emojiOpen} onOpenChange={setEmojiOpen}>
        <PopoverTrigger asChild>
          <IconBtn label="Emoji">
            <Smile className="h-4 w-4" />
          </IconBtn>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          side="top"
          className="w-auto border p-2"
        >
          <div className="grid grid-cols-6 gap-1">
            {EMOJIS.map((em) => (
              <button
                key={em}
                type="button"
                onClick={() => {
                  onInsert(em);
                  setEmojiOpen(false);
                }}
                className="rounded p-1 text-lg leading-none hover:bg-background-light"
              >
                {em}
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
      <IconBtn
        label="Insert image"
        onClick={() => fileRef.current?.click()}
      >
        <ImageIcon className="h-4 w-4" />
      </IconBtn>
      <Popover open={templateOpen} onOpenChange={setTemplateOpen}>
        <PopoverTrigger asChild>
          <IconBtn label="Insert template">
            <FileText className="h-4 w-4" />
          </IconBtn>
        </PopoverTrigger>
        <PopoverContent align="start" side="top" width="sm" pad={1}>
          {templates.length === 0 ? (
            <p className="px-2 py-1.5 text-[12px] text-text-secondary">No templates yet</p>
          ) : (
            <div className="max-h-64 overflow-y-auto overscroll-contain">
              {templates.map((t) => (
                <Button
                  key={t.id}
                  type="button"
                  variant="ghost"
                  tone="subtle"
                  size={null}
                  onClick={() => {
                    onInsertTemplate(t.body);
                    setTemplateOpen(false);
                  }}
                  className="block w-full px-2 py-1.5 text-left"
                >
                  <span className="block truncate font-medium text-text-primary">{t.name}</span>
                  <span className="block truncate text-[11px] text-text-secondary">{t.info}</span>
                </Button>
              ))}
            </div>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}

// Gmail-style compose window — docked bottom-right. Used for new mail, replies,
// and forwards (the parent prefills `state` accordingly). Send and draft-save
// are wired in the parent so sent mail lands in the Sent folder for real.
export function ComposeWindow({
  state,
  onChange,
  onSend,
  onClose,
  onDiscard,
  onToast,
  fromAddress,
  fromName,
  addressNeeded = false,
  sendingEnabled = true,
}: {
  state: ComposeState;
  onChange: (s: ComposeState) => void;
  onSend: () => void;
  onClose: () => void;
  onDiscard: () => void;
  onToast: (m: string) => void;
  /** The sender's own address for the "Sending as" line (PRD 10, S10.11); undefined while it loads. */
  fromAddress?: string;
  /** The display name the recipient sees ("<name> at <company>"), shown beside the address. */
  fromName?: string;
  /** True for a person with no address of their own yet: the line reads the address-needed sentence and Send is disabled. */
  addressNeeded?: boolean;
  /** The org's `email_sending_enabled`. Defaults to TRUE, deliberately: the
   *  identity query is undefined while in flight, and defaulting to false
   *  would flash a "sending is off" warning at every user on every open. A
   *  wrong banner is worse than a late one - the send path enforces the real
   *  rule regardless (409 `org_disabled`). */
  sendingEnabled?: boolean;
}) {
  const title =
    state.mode === "reply"
      ? "Reply"
      : state.mode === "forward"
        ? "Forward"
        : "New message";
  const [ccBccOpen, setCcBccOpen] = useState(Boolean(state.cc || state.bcc));
  const attachments = state.attachments ?? [];
  const blockedReason = sendBlockedReason({ sendingEnabled, addressNeeded });
  // Mobile slice 46: below md (and on a landscape phone) the compose window is a full-screen form
  // overlay instead of a docked card, so the title bar, the fields (the only scroller) and the
  // Send footer share the whole screen. At md and up it is the docked card it always was.
  const fullscreen = useOverlayPresentation("form") === "fullscreen";
  const windowBody = (
    <>
      {/* Title bar */}
      <div
        className={cn(
          "flex shrink-0 items-center justify-between bg-text-primary px-4 py-2.5 text-on-fill",
          // Clear of the status bar / notch when it fills the screen.
          fullscreen && "pt-[max(0.625rem,env(safe-area-inset-top))]",
        )}
      >
        {fullscreen ? (
          <DialogTitle className="text-sm font-semibold">{title}</DialogTitle>
        ) : (
          <span className="text-sm font-semibold">{title}</span>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className={cn(
            "rounded p-0.5 text-on-fill/70 hover:bg-on-fill/10 hover:text-on-fill",
            fullscreen && "grid size-11 place-items-center",
          )}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* The fields. A plain pass-through in the docked card; the one scroller when full-screen. */}
      <div
        className={cn(
          fullscreen ? "flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain" : "contents",
        )}
      >

      {/* Sending as - the sender's OWN address and name (no From choice), or the address-needed sentence. */}
      <SendingAsLine address={fromAddress} name={fromName} addressNeeded={addressNeeded} />

      <SendingDisabledNotice sendingEnabled={sendingEnabled} />

      {/* To + Cc/Bcc toggle (Gmail-style: collapsed until opened) */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-2">
        <span className="w-14 flex-none text-[12px] text-text-secondary">To</span>
        <input
          value={state.to}
          onChange={(e) => onChange({ ...state, to: e.target.value })}
          placeholder="Recipients"
          className="w-full bg-transparent text-sm mobile:!text-base text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/50 placeholder:text-text-secondary"
        />
        {!ccBccOpen && (
          <Button
            type="button"
            variant="ghost"
            tone="subtle"
            size="3xs"
            onClick={() => setCcBccOpen(true)}
            className="flex-none"
          >
            Cc/Bcc
          </Button>
        )}
      </div>
      {ccBccOpen && (
        <>
          <div className="flex items-center gap-2 border-b border-border px-4 py-2">
            <span className="w-14 flex-none text-[12px] text-text-secondary">Cc</span>
            <Input
              variant="ghost"
              value={state.cc ?? ""}
              onChange={(e) => onChange({ ...state, cc: e.target.value })}
              placeholder="Cc"
            />
          </div>
          <div className="flex items-center gap-2 border-b border-border px-4 py-2">
            <span className="w-14 flex-none text-[12px] text-text-secondary">Bcc</span>
            <Input
              variant="ghost"
              value={state.bcc ?? ""}
              onChange={(e) => onChange({ ...state, bcc: e.target.value })}
              placeholder="Bcc"
            />
          </div>
        </>
      )}

      {/* Subject */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-2">
        <span className="w-14 flex-none text-[12px] text-text-secondary">Subject</span>
        <input
          value={state.subject}
          onChange={(e) => onChange({ ...state, subject: e.target.value })}
          placeholder="Subject"
          className="w-full bg-transparent text-sm mobile:!text-base font-medium text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/50 placeholder:font-normal placeholder:text-text-secondary"
        />
      </div>

      {/* Body */}
      <textarea
        value={state.body}
        onChange={(e) => onChange({ ...state, body: e.target.value })}
        placeholder="Write your message…"
        /* The body gives way before the footer: 200 px when there is room, shrinking with the visible height. */
        className="min-h-[clamp(3rem,calc(var(--visible-height,100vh)-15rem),12.5rem)] flex-1 resize-none px-4 py-3 text-[14px] mobile:!text-base leading-relaxed text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/50 placeholder:text-text-secondary"
      />

      {/* Attachment chips */}
      <AttachmentChips
        attachments={attachments}
        onRemove={(i) =>
          onChange({
            ...state,
            attachments: attachments.filter((_, idx) => idx !== i),
          })
        }
      />

      {/* Attach from this record - conditional on attach-by-origin context */}
      <AttachFromRecord
        origin={state}
        attachments={attachments}
        onAttach={(file) =>
          onChange({ ...state, attachments: [...attachments, fileToAttachment(file)] })
        }
        onToast={onToast}
      />
      </div>

      {/* Footer. Sticky in the docked card (mobile slice 54); pinned below the scroller when
          full-screen (mobile slice 46), so Send is always on screen. */}
      <div
        className={cn(
          "flex items-center justify-between border-t border-border px-3",
          fullscreen
            ? "shrink-0 gap-2 py-2.5 pb-[max(0.625rem,var(--safe-bottom,0px))]"
            : "sticky bottom-0 z-10 bg-surface-light pt-2.5 pb-[max(0.625rem,var(--safe-bottom,0px))]",
        )}
        data-slot="compose-footer"
      >
        <div className={cn("flex items-center gap-1.5", fullscreen && "flex-wrap gap-y-1")}>
          <Button
            type="button"
            variant="solid"
            tone="brand"
            onClick={onSend}
            disabled={blockedReason !== undefined}
            disabledReason={blockedReason}
            className={cn(fullscreen && "min-h-11")}
          >
            <Send className="h-4 w-4" /> Send
          </Button>
          <AiAssistMenu
            body={state.body}
            original={null}
            draftLabel={state.mode === "new" ? "Draft an email" : "Draft a reply"}
            onResult={(text) => onChange({ ...state, body: text })}
            onToast={onToast}
          />
          <span className="mx-0.5 h-5 w-px bg-border" />
          <ComposerToolbar
            onAddFiles={(files) =>
              onChange({
                ...state,
                attachments: [...attachments, ...filesToAttachments(files)],
              })
            }
            onInsert={(t) => onChange({ ...state, body: state.body + t })}
            onInsertTemplate={(body) =>
              onChange({ ...state, body: state.body.trim() ? `${state.body}\n\n${body}` : body })
            }
            onToast={onToast}
          />
        </div>
        <button
          type="button"
          onClick={onDiscard}
          aria-label="Discard draft"
          title="Discard draft"
          className={cn(
            "flex h-9 w-9 items-center justify-center rounded-md text-text-secondary hover:bg-background-light hover:text-text-primary",
            fullscreen && "size-11 shrink-0",
          )}
        >
          <Trash2 className="h-[18px] w-[18px]" />
        </button>
      </div>
    </>
  );

  if (fullscreen) {
    // Closing by Escape is the same as the title bar's Close: it saves a non-empty draft.
    return (
      <Dialog
        open
        onOpenChange={(next) => {
          if (!next) onClose();
        }}
      >
        <DialogContent intent="form" showClose={false} aria-describedby={undefined}>
          {windowBody}
        </DialogContent>
      </Dialog>
    );
  }
  return (
    // Docked card: sits on top of the on-screen keyboard and never grows past what is visible (mobile
    // slice 54). The window scrolls and its footer is sticky, so Send stays reachable even where the
    // visible height is shorter than the fields; the footer carries the home-indicator padding, which
    // drops while the keyboard covers it.
    <div className="fixed bottom-[var(--keyboard-inset,0px)] right-[max(1.5rem,env(safe-area-inset-right,0px))] z-50 flex max-h-[min(80vh,var(--visible-height,100vh))] w-[540px] max-w-[calc(100vw-3rem)] flex-col overflow-y-auto overscroll-contain rounded-t-lg border border-border bg-surface-light shadow-2xl">
      {windowBody}
    </div>
  );
}

// Gmail-style inline reply/forward composer — sits at the bottom of the open
// thread. The original message is tucked into a collapsed "···" quote toggle.
export function InlineComposer({
  reply,
  original,
  onChange,
  onSend,
  onDiscard,
  onPopOut,
  onToast,
  fromAddress,
  fromName,
  addressNeeded = false,
  sendingEnabled = true,
}: {
  reply: ReplyDraft;
  original: Email;
  onChange: (r: ReplyDraft) => void;
  onSend: () => void;
  onDiscard: () => void;
  onPopOut: () => void;
  onToast: (m: string) => void;
  /** The sender's own address for the "Sending as" line (PRD 10, S10.11); undefined while it loads. */
  fromAddress?: string;
  /** The display name the recipient sees ("<name> at <company>"), shown beside the address. */
  fromName?: string;
  /** True for a person with no address of their own yet: the line reads the address-needed sentence and Send is disabled. */
  addressNeeded?: boolean;
  /** See ComposeWindow's own `sendingEnabled` doc - identical role, and it
   *  defaults to true for the same "never flash a wrong banner" reason. */
  sendingEnabled?: boolean;
}) {
  const [showQuote, setShowQuote] = useState(false);
  const [ccBccOpen, setCcBccOpen] = useState(Boolean(reply.cc || reply.bcc));
  const attachments = reply.attachments ?? [];
  const blockedReason = sendBlockedReason({ sendingEnabled, addressNeeded });
  return (
    <div className="mt-6 rounded-2xl border border-border bg-surface-light shadow-sm">
      {/* Header: who you're replying as / to */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <CornerUpLeft className="h-4 w-4 flex-none text-text-secondary" />
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] text-text-secondary">
          <span className="font-semibold text-text-primary">
            {reply.mode === "forward" ? "Forward" : "Reply"}
          </span>
        </div>
        <button
          type="button"
          onClick={onPopOut}
          aria-label="Pop out into a window"
          title="Pop out"
          className="flex h-7 w-7 flex-none items-center justify-center rounded-md text-text-secondary hover:bg-background-light hover:text-text-primary"
        >
          <Maximize2 className="h-[15px] w-[15px]" />
        </button>
      </div>

      {/* Sending as - the sender's OWN address and name in every conversation, a handed-over or shared mailbox's
          included (no From choice), or the address-needed sentence. */}
      <SendingAsLine address={fromAddress} name={fromName} addressNeeded={addressNeeded} className="px-4" />

      <SendingDisabledNotice sendingEnabled={sendingEnabled} />

      {/* To + Cc/Bcc toggle (Gmail-style: collapsed until opened) */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-2">
        <span className="w-12 flex-none text-[12px] text-text-secondary">To</span>
        <input
          value={reply.to}
          onChange={(e) => onChange({ ...reply, to: e.target.value })}
          placeholder="Recipients"
          className="w-full bg-transparent text-sm mobile:!text-base text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/50 placeholder:text-text-secondary"
        />
        {!ccBccOpen && (
          <Button
            type="button"
            variant="ghost"
            tone="subtle"
            size="3xs"
            onClick={() => setCcBccOpen(true)}
            className="flex-none"
          >
            Cc/Bcc
          </Button>
        )}
      </div>
      {ccBccOpen && (
        <>
          <div className="flex items-center gap-2 border-b border-border px-4 py-2">
            <span className="w-12 flex-none text-[12px] text-text-secondary">Cc</span>
            <Input
              variant="ghost"
              value={reply.cc ?? ""}
              onChange={(e) => onChange({ ...reply, cc: e.target.value })}
              placeholder="Cc"
            />
          </div>
          <div className="flex items-center gap-2 border-b border-border px-4 py-2">
            <span className="w-12 flex-none text-[12px] text-text-secondary">Bcc</span>
            <Input
              variant="ghost"
              value={reply.bcc ?? ""}
              onChange={(e) => onChange({ ...reply, bcc: e.target.value })}
              placeholder="Bcc"
            />
          </div>
        </>
      )}

      {/* Body */}
      <textarea
        autoFocus={canAutoFocus()}
        value={reply.body}
        onChange={(e) => onChange({ ...reply, body: e.target.value })}
        placeholder={
          reply.mode === "forward"
            ? "Add a message…"
            : `Reply to ${senderLabel(original.from)}…`
        }
        className="min-h-[140px] w-full resize-none px-4 py-3 text-[14px] mobile:!text-base leading-relaxed text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/50 placeholder:text-text-secondary"
      />

      {/* Collapsed quote of the original */}
      <div className="px-4 pb-2">
        <button
          type="button"
          onClick={() => setShowQuote((v) => !v)}
          aria-label="Show quoted text"
          className="rounded bg-background-light px-2 py-1 text-[12px] font-semibold leading-none text-text-secondary hover:bg-border"
        >
          ···
        </button>
        {showQuote && (
          <div className="mt-2 border-l-2 border-border pl-3 text-[12px] leading-relaxed text-text-secondary">
            <p className="mb-1">
              {/* Label plus address only when the row carries both, so a
                  nameless or addressless sender does not quote as
                  "null <undefined>". */}
              On {original.at}, {senderLabel(original.from)}
              {original.from.name?.trim() && senderAddress(original.from) ? (
                <> &lt;{senderAddress(original.from)}&gt;</>
              ) : null}{" "}
              wrote:
            </p>
            {original.body.map((p, i) => (
              <p key={i} className="whitespace-pre-line">
                {p}
              </p>
            ))}
          </div>
        )}
      </div>

      {/* Attachment chips */}
      <AttachmentChips
        attachments={attachments}
        onRemove={(i) =>
          onChange({
            ...reply,
            attachments: attachments.filter((_, idx) => idx !== i),
          })
        }
      />

      {/* Attach from this record - conditional on attach-by-origin context */}
      <AttachFromRecord
        origin={reply}
        attachments={attachments}
        onAttach={(file) =>
          onChange({ ...reply, attachments: [...attachments, fileToAttachment(file)] })
        }
        onToast={onToast}
      />

      {/* Footer */}
      <div className="flex items-center justify-between border-t border-border px-3 py-2.5">
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="solid"
            tone="brand"
            onClick={onSend}
            disabled={blockedReason !== undefined}
            disabledReason={blockedReason}
          >
            <Send className="h-4 w-4" /> Send
          </Button>
          <AiAssistMenu
            body={reply.body}
            original={original}
            draftLabel={reply.mode === "forward" ? "Draft a note" : "Draft a reply"}
            onResult={(text) => onChange({ ...reply, body: text })}
            onToast={onToast}
          />
          <span className="mx-0.5 h-5 w-px bg-border" />
          <ComposerToolbar
            onAddFiles={(files) =>
              onChange({
                ...reply,
                attachments: [...attachments, ...filesToAttachments(files)],
              })
            }
            onInsert={(t) => onChange({ ...reply, body: reply.body + t })}
            onInsertTemplate={(body) =>
              onChange({ ...reply, body: reply.body.trim() ? `${reply.body}\n\n${body}` : body })
            }
            onToast={onToast}
          />
        </div>
        <button
          type="button"
          onClick={onDiscard}
          aria-label="Discard"
          title="Discard"
          className="flex h-9 w-9 items-center justify-center rounded-md text-text-secondary hover:bg-background-light hover:text-text-primary"
        >
          <Trash2 className="h-[18px] w-[18px]" />
        </button>
      </div>
    </div>
  );
}
