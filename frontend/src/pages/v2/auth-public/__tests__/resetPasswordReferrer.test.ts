/**
 * /reset-password is served with `Referrer-Policy: no-referrer` (conductor brief §3.3), so the first
 * load - before the page strips the token - never sends its address on as a referrer. Vercel applies
 * every matching header rule in order, and for the same key the later rule wins.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const vercel = JSON.parse(readFileSync(join(here, '../../../../../vercel.json'), 'utf8')) as {
  headers?: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
};

function lastValue(path: string, key: string): string | undefined {
  const values = (vercel.headers ?? [])
    .filter((rule) => new RegExp(`^${rule.source.replace(/\(\.\*\)/g, '.*')}$`).test(path))
    .flatMap((rule) => rule.headers)
    .filter((h) => h.key.toLowerCase() === key.toLowerCase())
    .map((h) => h.value);
  return values.at(-1);
}

describe('reset page referrer policy', () => {
  it('is no-referrer on /reset-password', () => {
    expect(lastValue('/reset-password', 'Referrer-Policy')).toBe('no-referrer');
  });

  it('leaves every other page on the site-wide policy', () => {
    expect(lastValue('/login', 'Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });
});
