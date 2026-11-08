// Email slice 9 (render hardening) - replaces InboxPage's old
// `dangerouslySetInnerHTML={{ __html: m.bodyHtml }}` render path. A sanitized
// HTML body now only ever reaches the DOM inside a sandboxed <iframe
// srcDoc>: the server's sanitizeEmailHtml (backend/src/lib/email-html.ts) is
// defense layer 1, this component is layer 2 - see emailBodyFrame.ts's own
// header comment for the full sandbox-value rationale (AdGuard's config, not
// Close's) and why auto-sizing is a fixed height with an internal scrollbar
// rather than a measured one.
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  EMAIL_IFRAME_SANDBOX,
  EMAIL_IFRAME_HEIGHT_PX,
  buildEmailSrcDoc,
  htmlHasBlockableImages,
} from "@/lib/communication/emailBodyFrame";

interface EmailBodyFrameProps {
  /** Already server-sanitized HTML (sanitizeEmailHtml). Never re-sanitized
   *  here - this component's job is the render sandbox, not a second
   *  allowlist pass. */
  html: string;
  className?: string;
}

export function EmailBodyFrame({ html, className }: EmailBodyFrameProps) {
  const [loadImages, setLoadImages] = useState(false);
  const showImageNotice = !loadImages && htmlHasBlockableImages(html);
  const srcDoc = buildEmailSrcDoc(html, loadImages);

  return (
    <div className={className}>
      {showImageNotice && (
        <div className="mb-2 flex items-center gap-2 text-[12px] text-text-secondary">
          <span>Images are hidden</span>
          <Button
            type="button"
            variant="ghost"
            tone="subtle"
            size="3xs"
            onClick={() => setLoadImages(true)}
          >
            Load images
          </Button>
        </div>
      )}
      <iframe
        title="Email message body"
        srcDoc={srcDoc}
        sandbox={EMAIL_IFRAME_SANDBOX}
        referrerPolicy="no-referrer"
        className="w-full rounded-lg border border-border"
        style={{ height: EMAIL_IFRAME_HEIGHT_PX }}
      />
    </div>
  );
}
