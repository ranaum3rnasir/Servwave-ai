/**
 * The browser-console lines the gate judges for the `vendorConsole` check.
 *
 * The check is ENFORCED for every line our own document writes (or the browser writes about our own
 * document: a failed request, a socket, a blocked resource). The one exception is a line that comes
 * from a vendor's embedded frame: the phone dialer and the payment form run in cross-origin frames
 * and print their own console lines, which no ServWave code can change. Ran accepted that on
 * 2026-10-08; it is recorded under `acceptedExceptions.vendorConsole` in allowlist.json.
 *
 * Ran extended it on 2026-10-09 to two Firefox engine warnings (`Feature Policy: Skipping unsupported
 * feature name "clipboard-read"` / `"clipboard-write"`) that the dialer's embed script causes by
 * setting `allow=` on its own iframe; see isDialerFeaturePolicyWarning for how narrow the match is.
 *
 * How a line is attributed: Playwright reports, for each console message, the URL of the script or
 * resource it came from. A line whose source is on the origin of a cross-origin frame the page
 * embedded is the frame's. Anything else, including a line about a request our own page made to a
 * vendor host, is ours, and is judged. A vendor script that our document loads into itself and that
 * shares an origin with one of those frames is attributed to the frame; the app's own console filter
 * (src/lib/communication/vendorConsoleFilter.ts) already covers that script's output.
 */
import type { Page } from '@playwright/test';
import { findVendorTerms } from './vendor-terms';

export interface FrameLine {
  text: string;
  /** The origin the line came from, for the report. */
  origin: string;
}

export interface ConsoleRecord {
  /** Lines from our own document: judged by the check. */
  lines: string[];
  /** Lines from vendor frames: the documented exception, listed in the report, never judged. */
  frameLines: FrameLine[];
  /**
   * The two Firefox Feature Policy warnings the dialer's embed script causes (isDialerFeaturePolicyWarning):
   * the documented exception, listed in the report, never judged.
   */
  dialerWarnings: string[];
}

/** The origin of a URL, or '' when it has none worth comparing (about:blank, a data: URL, junk). */
export function originOf(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'ws:' || u.protocol === 'wss:' ? u.origin.replace(/^ws/, 'http') : '';
  } catch {
    return '';
  }
}

/** True when a console message that came from `sourceUrl` belongs to one of the embedded frames' origins. */
export function isFromVendorFrame(sourceUrl: string, frameOrigins: ReadonlySet<string>): boolean {
  const origin = originOf(sourceUrl);
  return origin !== '' && frameOrigins.has(origin);
}

/**
 * The phone dialer's own embed script, on the vendor's host: `ctm-phone-embed*.js` at the host's
 * root (the file Firefox names in the warning). Anchored, so a look-alike host, a longer path or
 * the file name in a query string never matches.
 */
const DIALER_SCRIPT_URL = /^https:\/\/(?:[a-z0-9-]+\.)*calltrackingmetrics\.com\/ctm-phone-embed[A-Za-z0-9._-]*\.js$/;

/**
 * The one Firefox engine warning accepted from the dialer script, optionally in the form Firefox
 * prints it: `[JavaScript Warning: "<message>" {file: "<url>" line: <n>}]`. The feature name is a
 * closed list of two.
 */
// Measured 2026-10-09: Firefox wraps the feature name in typographic quotes (U+201C / U+201D) inside the
// message; a straight pair is accepted too, so a later engine release that changes them does not matter.
const FEATURE_POLICY_MESSAGE = 'Feature Policy: Skipping unsupported feature name ["“](?:clipboard-read|clipboard-write)["”]\\.';
const FEATURE_POLICY_WRAPPED = new RegExp(`^\\[JavaScript Warning: "${FEATURE_POLICY_MESSAGE}" \\{file: "([^"\\s]+)" line: \\d+\\}\\]$`);
const FEATURE_POLICY_BARE = new RegExp(`^${FEATURE_POLICY_MESSAGE}$`);

/**
 * True for the two Firefox warnings the dialer's embed script causes and no ServWave code can
 * change: `Feature Policy: Skipping unsupported feature name "clipboard-read"` and the same for
 * `"clipboard-write"`, printed because that script sets `allow="clipboard-read; clipboard-write;"`
 * on the iframe it creates. Ran accepted them on 2026-10-09 as an extension of the 2026-10-08
 * embedded-frame exception (`acceptedExceptions.vendorConsole` in allowlist.json).
 *
 * Narrow by construction, all three at once: (a) the text is exactly that Feature Policy warning
 * and nothing else (a second line, a prefix or a suffix fails), (b) the feature name is
 * clipboard-read or clipboard-write, (c) the script it came from is the dialer's embed script on
 * the vendor host. The script is the `{file: ...}` Firefox prints in the text, or, for a bare
 * message, the console message's own source URL; when both are present they must agree.
 */
export function isDialerFeaturePolicyWarning(text: string, sourceUrl = ''): boolean {
  const wrapped = FEATURE_POLICY_WRAPPED.exec(text);
  if (wrapped) {
    const file = wrapped[1]!;
    return DIALER_SCRIPT_URL.test(file) && (sourceUrl === '' || sourceUrl === file);
  }
  return FEATURE_POLICY_BARE.test(text) && DIALER_SCRIPT_URL.test(sourceUrl);
}

/** Start recording the page's console. Call before the page opens. */
export function recordConsole(page: Page): ConsoleRecord {
  const record: ConsoleRecord = { lines: [], frameLines: [], dialerWarnings: [] };
  const frameOrigins = new Set<string>();
  const remember = (frame: { url(): string }) => {
    const o = originOf(frame.url());
    if (!o) return;
    let pageOrigin = '';
    try { pageOrigin = originOf(page.url()); } catch { /* page closed */ }
    // A same-origin frame is our own document; only cross-origin frames are the vendors'.
    if (o !== pageOrigin) frameOrigins.add(o);
  };
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) remember(frame);
  });
  page.on('console', (m) => {
    const source = m.location().url;
    // MOBILE_GATE_DEBUG_CONSOLE=1: print every console line that names a vendor, whole, with the URL it came from and
    // which side of the frame split it landed on (the failure report shows only an excerpt).
    if (process.env.MOBILE_GATE_DEBUG_CONSOLE === '1' && findVendorTerms([{ source: 'console', text: m.text() }]).length) {
      console.log(`[console-lines] ${isFromVendorFrame(source, frameOrigins) ? 'FRAME' : 'OWN'} source=${source} type=${m.type()} text=${m.text()}`);
    }
    if (isFromVendorFrame(source, frameOrigins)) record.frameLines.push({ text: m.text(), origin: originOf(source) });
    else if (isDialerFeaturePolicyWarning(m.text(), source)) record.dialerWarnings.push(m.text());
    else record.lines.push(m.text());
  });
  page.on('pageerror', (e) => {
    if (process.env.MOBILE_GATE_DEBUG_CONSOLE === '1' && findVendorTerms([{ source: 'pageerror', text: String(e.message) }]).length) {
      console.log(`[console-lines] OWN pageerror name=${e.name} message=${e.message} stack=${(e.stack ?? '').slice(0, 900)}`);
    }
    record.lines.push(String(e.message));
  });
  return record;
}
