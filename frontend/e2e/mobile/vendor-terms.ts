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
 * Real customer company names are banned too, but they are banned EVERYWHERE in the repo, this
 * file included, so they cannot be listed here. Add a vendor by appending a row.
 */
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

export interface VendorHit {
  term: string;
  source: string;
  excerpt: string;
}

/** Find every banned term in each labelled text source. */
export function findVendorTerms(sources: Array<{ source: string; text: string }>): VendorHit[] {
  const hits: VendorHit[] = [];
  for (const { source, text } of sources) {
    if (!text) continue;
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
