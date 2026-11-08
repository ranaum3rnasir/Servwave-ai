import sanitizeHtml from 'sanitize-html';

// Provider-neutral email helpers. Nothing here knows about a mail provider:
// sanitization, address parsing and size labels apply to any inbound or
// outbound message, whichever service carries it.

/**
 * Sanitize inbound email HTML for in-app rendering. Conservative allowlist:
 * formatting + tables + http(s) images; scripts/iframes/handlers stripped;
 * links hardened with target=_blank + noopener.
 *
 * This server-side pass is layer 1 of two: the frontend reader (email slice
 * 9, frontend/src/lib/communication/emailBodyFrame.ts) now renders the
 * stored HTML inside a sandboxed <iframe srcDoc> (no allow-scripts, no
 * allow-same-origin), not a plain div, so a bug or future relaxation here no
 * longer means immediate script execution in the authenticated app's own
 * DOM. Still treat this allowlist as load-bearing and do not relax it
 * casually - it is the only layer for any consumer that isn't that reader
 * (e.g. a future export/print path), and the client sandbox is deliberately
 * not a re-sanitizer.
 */
export function sanitizeEmailHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [
      'a', 'b', 'i', 'em', 'strong', 'u', 's', 'p', 'br', 'hr', 'div', 'span',
      'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
      'img', 'font', 'center', 'small', 'big', 'sub', 'sup',
    ],
    allowedAttributes: {
      a: ['href', 'name', 'target', 'rel'],
      img: ['src', 'alt', 'width', 'height'],
      td: ['colspan', 'rowspan', 'align', 'valign'],
      th: ['colspan', 'rowspan', 'align', 'valign'],
      table: ['width', 'cellpadding', 'cellspacing', 'border', 'align'],
      font: ['color', 'size', 'face'],
      '*': ['style'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['http', 'https'] }, // cid:/data: inline images dropped
    allowedStyles: {
      '*': {
        color: [/^.+$/],
        'background-color': [/^.+$/],
        'font-size': [/^.+$/],
        'font-weight': [/^.+$/],
        'font-family': [/^.+$/],
        'font-style': [/^.+$/],
        'text-align': [/^.+$/],
        'text-decoration': [/^.+$/],
        padding: [/^.+$/],
        margin: [/^.+$/],
        width: [/^.+$/],
        'max-width': [/^.+$/],
        border: [/^.+$/],
        'line-height': [/^.+$/],
      },
    },
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }),
    },
    disallowedTagsMode: 'discard',
  });
}

/** Parse `"Name" <a@b.c>` / `Name <a@b.c>` / `a@b.c` into name+email. */
export function parseAddress(headerValue: string): { name: string; email: string } {
  const value = (headerValue ?? '').trim();
  if (!value) return { name: '', email: '' };
  const angled = value.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/);
  if (angled) {
    const email = angled[2].trim().toLowerCase();
    const name = angled[1].trim();
    return { name: name || email, email };
  }
  const email = value.toLowerCase();
  return { name: value, email };
}

export function formatSizeLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
