// Email slice 9 (render hardening) - the message-body region of one row in
// InboxPage's conversation chain. Routes to EmailBodyFrame for a sanitized
// HTML body, or the existing plain-paragraph render otherwise; either way,
// an INBOUND message's quoted history is hidden by default behind a "Show
// trimmed content" toggle (mirroring InlineComposer's existing "···" quote
// toggle - same quote-block visual language (left border, muted secondary
// colour), same ghost/subtle Button recipe).
//
// Quote-stripping is scoped to `direction === "in"` only, per the plan: a
// message ServWave itself sent should never have its own content trimmed,
// and `direction` is absent on prototype/seed rows (real DB rows only, per
// the Email type's own doc) - both read as "do not trim" here, which is the
// safe default until Slice 6 (inbound capture) starts writing direction="in"
// rows with a real bodyHtml.
import { useState } from "react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { EmailBodyFrame } from "@/components/communication/inbox/EmailBodyFrame";
import { splitQuotedHtml, splitQuotedText } from "@/lib/communication/emailQuoteSplit";

interface EmailMessageBodyProps {
  bodyHtml?: string;
  body: string[];
  direction?: "in" | "out";
}

function TrimToggle({
  visible,
  onToggle,
  children,
}: {
  visible: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="mt-2">
      <Button
        type="button"
        variant="ghost"
        tone="subtle"
        size="3xs"
        aria-expanded={visible}
        onClick={onToggle}
      >
        {visible ? "Hide trimmed content" : "Show trimmed content"}
      </Button>
      {visible && (
        <div className="mt-2 border-l-2 border-border pl-3 text-[12px] leading-relaxed text-text-secondary">
          {children}
        </div>
      )}
    </div>
  );
}

export function EmailMessageBody({ bodyHtml, body, direction }: EmailMessageBodyProps) {
  const [showTrimmed, setShowTrimmed] = useState(false);
  const isInbound = direction === "in";

  if (bodyHtml) {
    const { visibleHtml, quotedHtml } = isInbound
      ? splitQuotedHtml(bodyHtml)
      : { visibleHtml: bodyHtml, quotedHtml: "" };

    return (
      <div>
        <EmailBodyFrame html={visibleHtml} />
        {quotedHtml && (
          <TrimToggle visible={showTrimmed} onToggle={() => setShowTrimmed((v) => !v)}>
            <EmailBodyFrame html={quotedHtml} />
          </TrimToggle>
        )}
      </div>
    );
  }

  const { visible, quoted } = isInbound ? splitQuotedText(body) : { visible: body, quoted: [] };

  return (
    <div className="space-y-3 text-[14px] leading-relaxed text-text-primary">
      {visible.map((p, i) => (
        <p key={i} className="whitespace-pre-line">
          {p}
        </p>
      ))}
      {quoted.length > 0 && (
        <TrimToggle visible={showTrimmed} onToggle={() => setShowTrimmed((v) => !v)}>
          {quoted.map((p, i) => (
            <p key={i} className="whitespace-pre-line">
              {p}
            </p>
          ))}
        </TrimToggle>
      )}
    </div>
  );
}
