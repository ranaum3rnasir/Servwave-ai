/**
 * Banned vendor terms for the mobile gate's copy check (check 6, enforced from day one).
 *
 * Project rule (CLAUDE.md): third-party vendor names never appear in anything a user can see -
 * rendered text, page titles, accessible names, placeholders, the URL, or the browser console.
 * Every capability is presented as ServWave's own.
 *
 * Words that are also ordinary English UI verbs are matched only in their vendor forms: "Resend
 * invite" and "render" are fine, "resend.com" or "Render dashboard" are not.
 *
 * One accepted exception (Ran, 13 Oct 2026; allowlist.json acceptedExceptions.gateTestInbox): the copy
 * check ignores exactly the address the gate seeds its customers with (gate-inbox.ts), so a customer's
 * email can render. Nothing else about the provider is exempt, and the console is never exempted.
 *
 * Real customer company names are banned too, but they are banned EVERYWHERE in the repo, this
 * file included, so they cannot be listed here. Add a vendor by appending a row.
 */
import { GATE_TEST_INBOX } from './gate-inbox';

export interface VendorTerm {
  /** Label used in offender messages. */
  term: string;
  pattern: RegExp;
}

export const VENDOR_TERMS: VendorTerm[] = [
  { term: 'CTM', pattern: /\bCTM\b/ },
  { term: 'CallTrackingMetrics', pattern: /call\s*tracking\s*metrics/i },
  { term: 'Supabase', pattern: /supabase/i },
  { term: 'Render', pattern: /onrender\.com|\brender\.com\b|\bRender\s+(dashboard|service|deploy|account)/i },
  { term: 'Vercel', pattern: /vercel/i },
  { term: 'Twilio', pattern: /twilio/i },
  { term: 'Resend', pattern: /resend\.(com|dev)\b|\bResend\s+(API|dashboard|domain|account)\b/i },
  { term: 'Stripe', pattern: /\bstripe\b/i },
  { term: 'Sentry', pattern: /\bsentry\b/i },
  { term: 'Geoapify', pattern: /geoapify/i },
  { term: 'Groq', pattern: /\bgroq\b/i },
];

/** Sources the gate's own test-inbox address is never exempt in: the page title and the URL. */
const NOT_EXEMPT_SOURCES = new Set(['title', 'url']);

/**
 * Remove the gate's own test-inbox address (gate-inbox.ts) from `text`, and say what was removed.
 * The accepted exception `gateTestInbox` (Ran, 13 Oct 2026): exactly the address the gate builds, as a
 * whole token, and nothing else. Every other occurrence of the provider's name is left in place.
 */
export function stripGateTestInbox(text: string): { text: string; removed: string[] } {
  const removed: string[] = [];
  const stripped = text.replace(GATE_TEST_INBOX, (m) => { removed.push(m); return ' '; });
  return { text: stripped, removed };
}

/** The line the gate prints for the addresses the accepted exception ignored. */
export function gateTestInboxLine(removed: readonly string[]): string {
  const shown = [...new Set(removed)].slice(0, 2).join(' | ');
  return `  EXEMPT gateTestInbox: ${removed.length} gate test-inbox address(es) in the copy (${shown}${new Set(removed).size > 2 ? ' | ...' : ''}) - accepted exception (allowlist.json acceptedExceptions); the console is not exempted`;
}

export interface VendorHit {
  term: string;
  source: string;
  excerpt: string;
}

export interface FindOptions {
  /**
   * Apply the accepted exception `gateTestInbox`: ignore the gate's own test-inbox address in rendered
   * text, placeholders and accessible names (never the title or the URL). Only the gate's copy check
   * asks for it; the browser console and every other caller get the full list.
   */
  gateTestInbox?: boolean;
}

/** The gate's test-inbox addresses `findVendorTerms` would ignore in these sources (for the EXEMPT line). */
export function gateTestInboxIn(sources: Array<{ source: string; text: string }>): string[] {
  return sources.filter((s) => s.text && !NOT_EXEMPT_SOURCES.has(s.source)).flatMap((s) => stripGateTestInbox(s.text).removed);
}

/** Find every banned term in each labelled text source. */
export function findVendorTerms(sources: Array<{ source: string; text: string }>, options: FindOptions = {}): VendorHit[] {
  const hits: VendorHit[] = [];
  for (const { source, text: raw } of sources) {
    if (!raw) continue;
    const text = options.gateTestInbox && !NOT_EXEMPT_SOURCES.has(source) ? stripGateTestInbox(raw).text : raw;
    for (const { term, pattern } of VENDOR_TERMS) {
      const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const from = Math.max(0, m.index - 30);
        hits.push({ term, source, excerpt: text.slice(from, m.index + m[0].length + 30).replace(/\s+/g, ' ').trim() });
        if (!re.global) break;
      }
    }
  }
  return hits;
}
