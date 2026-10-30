// Payments go-live slice 34 - the embedded components open the processor's verification windows as popups and
// talk back to the opener. A strict Cross-Origin-Opener-Policy (same-origin) severs that link and the sign-in
// check silently never completes. The page is served by Vercel (frontend/vercel.json) and the API by Express.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const vercel = JSON.parse(readFileSync(join(here, '../../vercel.json'), 'utf8')) as {
  headers?: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
};

/** Every header Vercel would put on /settings/payout-account (the catch-all source rules). */
function headersFor(path: string): Array<{ key: string; value: string }> {
  return (vercel.headers ?? [])
    .filter((rule) => new RegExp(`^${rule.source.replace(/\(\.\*\)/g, '.*')}$`).test(path))
    .flatMap((rule) => rule.headers);
}

describe('the payout account page is served without a strict Cross-Origin-Opener-Policy', () => {
  const served = headersFor('/settings/payout-account');

  it('is matched by at least the catch-all rule, so this test is looking at real headers', () => {
    expect(served.some((h) => h.key.toLowerCase() === 'content-security-policy')).toBe(true);
  });

  it('sends no Cross-Origin-Opener-Policy, or only one that leaves popups working', () => {
    const coop = served.filter((h) => h.key.toLowerCase() === 'cross-origin-opener-policy');
    for (const h of coop) expect(['unsafe-none', 'same-origin-allow-popups']).toContain(h.value);
  });

  it('sends no Cross-Origin-Embedder-Policy, which would block the embedded frames', () => {
    expect(served.some((h) => h.key.toLowerCase() === 'cross-origin-embedder-policy')).toBe(false);
  });

  it('does not set one from a meta tag in index.html either', () => {
    const html = readFileSync(join(here, '../../index.html'), 'utf8');
    expect(html).not.toMatch(/cross-origin-opener-policy/i);
  });

  it('lets the page frame and script the processor surfaces it embeds', () => {
    const csp = served.find((h) => h.key.toLowerCase() === 'content-security-policy')!.value;
    const directive = (name: string) => csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(name)) ?? '';
    expect(directive('script-src')).toContain('https://connect-js.stripe.com');
    expect(directive('frame-src')).toContain('https://*.stripe.com');
  });
});
