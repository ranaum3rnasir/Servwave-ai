import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// #229 — the Communication data seam must be real-API only. The mock seed
// (frontend/src/lib/api/_mock/communication, ~2.7k lines) was dropped; types,
// label maps, and business config moved to lib/api/communication-shared.
// Guard the two seam files so the USE_MOCK branch can never silently return.
//
// Deliberately scoped to the two #229 files ONLY: inventory.ts and dashboard.ts
// legitimately carry their own USE_MOCK flags (separate modules, separate issues).
const here = dirname(fileURLToPath(import.meta.url));
const apiDir = join(here, '../lib/api');

const SEAM_FILES = ['communication.ts', 'callJob.ts'];
const FORBIDDEN = ['USE_MOCK', 'VITE_COMM_USE_MOCK', '_mock/communication'];

describe('communication seam (#229) — no mock mode', () => {
  for (const file of SEAM_FILES) {
    it(`${file} contains no mock seam remnants`, () => {
      const src = readFileSync(join(apiDir, file), 'utf8');
      for (const needle of FORBIDDEN) {
        expect(src.includes(needle), `${file} must not contain "${needle}"`).toBe(false);
      }
    });
  }

  it('the _mock/communication seed directory no longer exists', () => {
    expect(existsSync(join(apiDir, '_mock/communication'))).toBe(false);
  });

  // Slice 2.2 — the dialer's demo dialIndex was the last _mock-adjacent
  // consumer in the communication components (#666/#357). Pin the invariant:
  // NO component under components/communication may import from a _mock path
  // (seam files in lib/api may — they gate it — but components never).
  it('components/communication imports nothing from a _mock path', () => {
    const componentsDir = join(here, '../components/communication');
    const files = readdirSync(componentsDir, { recursive: true })
      .map(String)
      .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.(ts|tsx)$/.test(f));
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const rel of files) {
      const src = readFileSync(join(componentsDir, rel), 'utf8');
      if (/from\s+['"][^'"]*_mock/.test(src)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
