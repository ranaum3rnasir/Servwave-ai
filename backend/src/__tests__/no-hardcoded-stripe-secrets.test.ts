import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const SRC_ROOT = join(__dirname, '..');
const WHSEC_LITERAL = /whsec_[A-Za-z0-9]{16,}/g;

const ALLOWED_PATHS = [
  /^__tests__\//,
  /^lib\/stripe\.ts$/,
];

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walkTsFiles(full));
    } else if (full.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('no hardcoded Stripe webhook secrets in backend/src', () => {
  it('contains zero whsec_* literals outside allowlisted paths', () => {
    const findings: string[] = [];
    for (const file of walkTsFiles(SRC_ROOT)) {
      const rel = relative(SRC_ROOT, file).replace(/\\/g, '/');
      if (ALLOWED_PATHS.some((re) => re.test(rel))) continue;
      const text = readFileSync(file, 'utf8');
      const matches = text.match(WHSEC_LITERAL);
      if (matches) findings.push(`${rel}: ${matches.length} match(es)`);
    }
    expect(findings).toEqual([]);
  });
});
