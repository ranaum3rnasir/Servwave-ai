// Inbox module — "✨ AI" assist menu for the email composers.
//
// Extracted from Emanuel's InboxPage monolith (AI-assist helpers L1452-1540 +
// AiAssistMenu L1544-1620). Used by both ComposeWindow and the inline reply
// composer to draft a message from scratch or reshape what's been written
// (Gemini-style tone controls).
//
// Faithful cut — prop signature and behaviour preserved verbatim. Two changes:
//   1. Tailwind tokens swapped indigo/slate -> ALPHA design tokens. emerald,
//      amber, rose status tints are kept.
//   2. The `Email` domain type now comes from the `@/lib/api/communication`
//      seam, not a module-scope definition.
//
// Scaffold honesty: the "AI" here is a deterministic, offline prototype so the
// UX can be demoed without an LLM. Production swaps `aiDraft`/`aiRefine` for a
// real model call (the seam already exposes `useAiAssist`).
import { ChevronDown, Sparkles } from "lucide-react";
import type { Email } from "@/lib/api/communication";
import { useAuthStore, userDisplayName } from "@/stores/auth.store";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/* ─────────────────────────── AI assist ───────────────────────────
 * Prototype "AI" for the composers — deterministic, context-aware text so the
 * UX can be demoed offline. Production swaps these for a real LLM call. Two
 * jobs: draft a message from scratch, or reshape what you've written (Gemini-
 * style tone controls). */

type RefineTone =
  | "professional"
  | "friendly"
  | "concise"
  | "detailed"
  | "bombastic"
  | "grammar";

const REFINE_OPTIONS: { tone: RefineTone; label: string }[] = [
  { tone: "professional", label: "Polish — professional" },
  { tone: "friendly", label: "Make it friendlier" },
  { tone: "concise", label: "Shorten it" },
  { tone: "detailed", label: "Elaborate" },
  { tone: "bombastic", label: "More bold & bombastic" },
  { tone: "grammar", label: "Fix spelling & grammar" },
];

/** First name for a greeting, or '' when the sender set no display name.
 *
 *  Nullable because a bare-address sender (a personal Gmail reply) carries no
 *  name at all - this was typed `string` and threw on `null.trim()`. The
 *  address is deliberately NOT a fallback here: "Hi art.nakamura@example.com," is a
 *  worse greeting than none, so the caller says "there" instead. */
function firstNameOf(name: string | null | undefined): string {
  const trimmed = (name ?? "").trim();
  return trimmed.split(/\s+/)[0] || trimmed;
}
function capitalizeFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean);
}
function fixGrammar(text: string): string {
  return splitSentences(text)
    .map((s) => {
      let x = capitalizeFirst(s.trim()).replace(/\bi\b/g, "I");
      if (!/[.!?]$/.test(x)) x += ".";
      return x;
    })
    .join(" ");
}

// Generate a fresh draft. With an original email it answers in context;
// otherwise it seeds a blank new message.
function aiDraft(original: Email | null, ownerName: string): string {
  if (original) {
    const who = firstNameOf(original.from.name) || "there";
    const subj = original.subject.replace(/^(re|fwd):\s*/i, "");
    return [
      `Hi ${who},`,
      `Thanks for reaching out about "${subj}". I've reviewed the details and we're glad to help.`,
      `I'll follow up shortly with the next steps — in the meantime, just let me know if any questions come up.`,
      `Best regards,\n${ownerName}`,
    ].join("\n\n");
  }
  return [
    `Hi there,`,
    `I hope you're doing well. I wanted to reach out regarding `,
    `Please let me know if this works for you and I'll take it from there.`,
    `Best regards,\n${ownerName}`,
  ].join("\n\n");
}

// Reshape existing text into a requested tone (prototype transforms).
function aiRefine(text: string, tone: RefineTone, ownerName: string): string {
  const t = text.trim();
  if (!t) return text;
  switch (tone) {
    case "professional":
      return `Hello,\n\n${fixGrammar(t)}\n\nThank you for your time - please don't hesitate to reach out with any questions.\n\nKind regards,\n${ownerName}`;
    case "friendly":
      return `Hi there!\n\nHope you're having a great day. ${capitalizeFirst(t)}\n\nThanks so much - talk soon!\n${ownerName}`;
    case "concise": {
      const s = splitSentences(t);
      return s.slice(0, Math.min(2, s.length)).join(" ");
    }
    case "detailed":
      return `${fixGrammar(t)}\n\nTo add a little more context: we'll handle this end to end and I'll keep you updated at each step so nothing falls through the cracks. If it helps, I'm also happy to hop on a quick call.`;
    case "bombastic":
      return `Fantastic news! ${fixGrammar(t).replace(/\.$/, "!")} This is going to be absolutely outstanding — we couldn't be more excited to make it happen for you!`;
    case "grammar":
      return fixGrammar(t);
  }
}

// "✨ AI" menu used in both composers. Drafts or refines, then hands the new
// text back via onResult.
export function AiAssistMenu({
  body,
  original,
  draftLabel,
  onResult,
  onToast,
}: {
  body: string;
  original: Email | null;
  draftLabel: string;
  onResult: (text: string) => void;
  onToast: (m: string) => void;
}) {
  const hasText = body.trim().length > 0;
  // The drafted signature is the signed-in user, never a hardcoded owner.
  const user = useAuthStore((s) => s.user);
  const ownerName = userDisplayName(user);

  function apply(text: string, msg: string) {
    onResult(text);
    onToast(msg);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-lg border border-primary/20 bg-primary/10 px-3 py-2 text-[13px] font-semibold text-primary transition hover:bg-primary/20"
        >
          <Sparkles className="h-4 w-4" /> AI
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-64 overflow-hidden py-1">
        <DropdownMenuItem
          onClick={() => apply(aiDraft(original, ownerName), "✨ AI drafted your message")}
          className="gap-2 px-3 py-2 text-[13px] font-semibold"
        >
          <Sparkles className="h-4 w-4 text-primary" />
          <span className="text-primary">{hasText ? "Regenerate draft" : draftLabel}</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="px-3 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wider">
          Refine your text
        </DropdownMenuLabel>
        {REFINE_OPTIONS.map((o) => (
          <DropdownMenuItem
            key={o.tone}
            disabled={!hasText}
            onClick={() => apply(aiRefine(body, o.tone, ownerName), `✨ ${o.label}`)}
            tone="strong"
            className="px-3 py-2 text-[13px]"
          >
            {o.label}
          </DropdownMenuItem>
        ))}
        {!hasText && (
          <p className="px-3 pb-1.5 pt-1 text-[11px] text-text-secondary">
            Write a few words first to refine them.
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
