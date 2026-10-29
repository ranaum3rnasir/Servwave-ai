import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Token guard for the phone re-skin (Calm Intelligence 2.0). Pins the invariant
// that phone components carry NO raw Tailwind palette utility classes — emerald/
// amber/rose/sky/blue/slate were migrated to semantic + chrome tokens. Modal
// scrims use dark tokens (text-primary/black/primary @ opacity), never a raw
// palette family.
const phoneDir = join(dirname(fileURLToPath(import.meta.url)), '..');

const RAW_PALETTE =
  /\b(bg|text|ring|border(?:-[trblxyse])?|from|to|via|fill|stroke|divide)-(emerald|amber|rose|green|red|orange|sky|blue|slate|violet|indigo|teal|cyan|lime|fuchsia|pink|yellow|purple)-\d{2,3}\b/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter(
      (e) =>
        e.isFile() &&
        (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) &&
        !e.name.endsWith('.test.ts') &&
        !e.name.endsWith('.test.tsx'),
    )
    .map((e) => join(dir, e.name));
}

describe('phone re-skin (token guard)', () => {
  it('no phone component uses a raw Tailwind palette utility class', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(phoneDir)) {
      const src = readFileSync(file, 'utf8');
      for (const line of src.split('\n')) {
        if (RAW_PALETTE.test(line)) offenders.push(`${file}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
