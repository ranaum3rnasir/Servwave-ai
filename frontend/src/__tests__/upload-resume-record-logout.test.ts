/**
 * The logout sweep for resume records must be armed WITHOUT the transport.
 *
 * `storeReset.ts` documents the invariant the registry leans on: "Only modules that have
 * actually been imported register, which is exactly right — a store nobody loaded holds
 * nothing to leak." That is true of a Zustand singleton, whose state is created and lost with
 * the module.
 *
 * It is FALSE of `localStorage`, which is the whole difference here. A resume record written
 * in one page load outlives that page load; the module that would clear it does not. So if
 * registration is a side effect of the transport module, the sweep is armed only in sessions
 * that already loaded the transport — and the record it exists to clear typically arrives
 * from an EARLIER session, which is exactly when nothing has imported it.
 *
 * Measured, not assumed: the prefix lands in a lazy route chunk, statically imported by the
 * job, lead and invoice detail pages and reachable from `index.html` only through the entry's
 * preload manifest. A session that signs in, works on the dashboard or in settings, and signs
 * out never loads it — and leaves a signed WRITE credential, good for about two hours, in
 * browser storage for whoever signs in next on that tablet.
 *
 * This file therefore imports the REGISTRY and never the transport. Importing
 * `resumableTransport` (or anything that pulls it) here would arm the sweep as a side effect
 * of the test itself and prove nothing.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { resetAccountScopedStores } from '@/lib/storeReset';

/** Spelled out rather than imported: importing the constant means importing the module. */
const PREFIX = 'servwave:upload-resume:';

const FRONTEND = join(__dirname, '..', '..');
const STORE_PATH = 'src/lib/attachments/resumeRecordStore.ts';

/**
 * Enumerated through the Storage API, never `Object.keys(localStorage)`.
 *
 * The harness installs a class-based in-memory shim whose entries live in a field holding a
 * `Map`. `Object.keys` on it returns `["store"]` — that field — because TypeScript's `private`
 * is compile-time only and the field is a real own property at runtime. So the filtered idiom
 * always answers `[]` whatever is stored (a test that cannot fail), and the unfiltered form is
 * worse: it answers `["store"]`, so a naive `toHaveLength(0)` FAILS and reads as real signal.
 */
function resumeKeys(): string[] {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(PREFIX)) keys.push(key);
  }
  return keys;
}

/**
 * Every module reachable from the entry through STATIC imports, as repo-relative paths.
 *
 * This is the property the bundler actually uses. A module lands in the eager entry chunk if
 * and only if the entry reaches it without crossing a dynamic `import()`; cross one and it
 * becomes a lazy chunk that `index.html` never references. Asserting only that `main.tsx`
 * contains a string would pass a module imported from somewhere that is itself lazy, which is
 * precisely one level of indirection away from how the original bug happened.
 *
 * `import('…')` is deliberately NOT followed, because not following it is the whole point.
 */
function staticallyReachableFromEntry(): Set<string> {
  const seen = new Set<string>();
  const queue = ['src/main.tsx'];

  const resolve = (spec: string, fromDir: string): string | null => {
    let base: string;
    if (spec.startsWith('@/')) base = join('src', spec.slice(2));
    else if (spec.startsWith('.')) base = join(fromDir, spec);
    else return null; // a package, not ours
    for (const candidate of [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      `${base}/index.ts`,
      `${base}/index.tsx`,
    ]) {
      if (existsSync(join(FRONTEND, candidate)) && statSync(join(FRONTEND, candidate)).isFile()) {
        return candidate;
      }
    }
    return null;
  };

  while (queue.length > 0) {
    const current = queue.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);

    let source: string;
    try {
      source = readFileSync(join(FRONTEND, current), 'utf8');
    } catch {
      continue;
    }
    // Static forms only: `import x from '…'`, `import '…'`, `export … from '…'`.
    const specs = [
      ...source.matchAll(/^\s*import\s+(?:.*?\s+from\s+)?['"]([^'"]+)['"]/gm),
      ...source.matchAll(/^\s*export\s+.*?\s+from\s+['"]([^'"]+)['"]/gm),
    ].map((m) => m[1]!);

    const dir = current.split('/').slice(0, -1).join('/');
    for (const spec of specs) {
      const resolved = resolve(spec, dir);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return seen;
}

beforeEach(() => {
  localStorage.clear();
});

describe('resume records are swept at logout without loading the transport', () => {
  it('is armed by the record store alone — no transport module, no chunked client', async () => {
    localStorage.setItem(
      `${PREFIX}job|job-1|clip.mp4|41943040|1700000000000|video/mp4`,
      JSON.stringify({ uploadUrl: 'https://example.test/u/1', ticket: 't', token: 'k' })
    );
    localStorage.setItem('servwave:nav-layout', 'wide');
    expect(resumeKeys()).toHaveLength(1);

    // The ONLY import of ours in this file, and deliberately dynamic so it happens here
    // rather than at module load: this line is the thing under test.
    await import('@/lib/attachments/resumeRecordStore');

    resetAccountScopedStores();

    expect(resumeKeys()).toHaveLength(0);
    // Scoped, not a `localStorage.clear()`: other subsystems keep per-viewer state here.
    expect(localStorage.getItem('servwave:nav-layout')).toBe('wide');
  });

  it('is imported by the entry, so a session that never opens an attachment surface sweeps too', () => {
    /**
     * The behavioural case above proves the record store is SUFFICIENT. This one proves it is
     * actually LOADED — which is the half that was broken, and which no test that has to
     * import a module can observe. Read the entry's source instead.
     */
    const reachable = staticallyReachableFromEntry();
    if (!reachable.has('src/lib/attachments/resumeRecordStore.ts')) {
      throw new Error(
        'resumeRecordStore is no longer reachable from src/main.tsx through STATIC imports, ' +
          'so the bundler will not put it in the entry chunk and the logout sweep will not ' +
          'be armed on a page load that never opens a detail page. That is the ordinary ' +
          'case - signing out from the dashboard or settings - and it leaves a signed write ' +
          'credential in browser storage for the next person on the device. If the import ' +
          'moved somewhere else that is still eager, this walk will find it; if it went ' +
          'behind a dynamic import(), that is the bug. Do not delete this test.'
      );
    }
  });

  it('does not drag the chunked client into the entry bundle', () => {
    /**
     * The reason this is a separate module at all. The entry has to import something that
     * registers the sweep; it must not be something that pulls `tus-js-client` in with it,
     * which would put the whole transport in the initial bundle for every page load.
     */
    const store = readFileSync(join(FRONTEND, STORE_PATH), 'utf8');
    // IMPORTS, not mentions: the module explains in prose why it is separate from the
    // transport, and a bare substring match would forbid saying so.
    //
    // BOTH import forms. An earlier version of this matched only `import … from '…'`, and a
    // mutation walked straight through it: `import '@/lib/attachments/resumableTransport';`
    // has no `from`, drags the whole chunked client into the entry bundle, and passed. A
    // side-effect import is exactly the shape someone would reach for here, so it is exactly
    // the shape this has to see.
    const imports = [...store.matchAll(/^\s*import\s+(?:.*?\s+from\s+)?'([^']+)';/gm)].map(
      (m) => m[1]!
    );
    expect(imports).toEqual(['@/lib/storeReset']);
  });

  it('keeps one definition of the prefix, in the module the entry loads', () => {
    // Two copies of a storage prefix is two chances for the sweep to miss what the writer
    // wrote. The transport reads it from here rather than restating it.
    const store = readFileSync(join(FRONTEND, STORE_PATH), 'utf8');
    expect(store).toContain(`'${PREFIX}'`);

    const transport = readFileSync(
      join(FRONTEND, 'src/lib/attachments/resumableTransport.ts'),
      'utf8'
    );
    expect(transport).not.toContain(`'${PREFIX}'`);
    expect(transport).toMatch(/from '@\/lib\/attachments\/resumeRecordStore'/);
  });
});
