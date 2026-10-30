/**
 * Automatic mail (PRD 10, M11b "Automatic mail"): out-of-office replies, auto-replies, bounces and bulk or list mail.
 *
 * Such a message is held in the Needs review list as automatic mail: it rings no bell, starts no conversation in the inbox
 * list, counts toward no unread badge and never triggers anything. That is what keeps out-of-office replies and bounces from
 * flooding mailboxes now that the sending domain receives mail.
 *
 * A message is automatic when ANY of these holds:
 *   - it carries an Auto-Submitted header whose value is anything but "no" (RFC 3834: "no" is the one value that says a person
 *     wrote it; auto-generated, auto-replied and auto-notified all say a program did);
 *   - its Precedence header is bulk, junk, list or auto_reply (the older convention, still sent by mailing-list software);
 *   - it has an empty sender: no address in its From header, or an empty return path (`<>`), which is how a bounce arrives.
 *
 * Pure: the From header and the headers are all it reads, so it is driven without a database.
 */

const AUTOMATIC_PRECEDENCE = new Set(['bulk', 'junk', 'list', 'auto_reply', 'auto-reply', 'autoreply']);

/** One header's value, found whatever its case, trimmed and lowercased; undefined when the message has no such header. */
function headerValue(headers: Record<string, string> | null | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key === undefined ? undefined : String(headers[key] ?? '').trim().toLowerCase();
}

/** Whether a From header names an address at all: `Name <addr>` or a bare `addr`, with an `@` in it. */
function hasSenderAddress(from: string): boolean {
  const angled = from.match(/<([^>]*)>/);
  return (angled ? angled[1]! : from).trim().includes('@');
}

export function isAutomaticMail(message: { from: string; headers: Record<string, string> | null | undefined }): boolean {
  const autoSubmitted = headerValue(message.headers, 'auto-submitted');
  // The value may carry parameters (`auto-replied; owner-email="..."`): only its first word says which kind it is.
  if (autoSubmitted !== undefined && autoSubmitted.split(';')[0]!.trim() !== 'no') return true;

  const precedence = headerValue(message.headers, 'precedence');
  if (precedence !== undefined && AUTOMATIC_PRECEDENCE.has(precedence)) return true;

  if (!hasSenderAddress(message.from ?? '')) return true;
  return headerValue(message.headers, 'return-path') === '<>';
}
