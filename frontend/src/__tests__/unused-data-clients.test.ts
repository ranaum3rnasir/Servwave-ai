/**
 * Mobile slice 61, round 2 (PERF-02): the staff app's first download leaves out the database,
 * file-storage and functions clients that the auth/realtime umbrella package builds eagerly.
 *
 * vite.config.ts aliases those three packages to `src/shims/unused-data-clients-shim.ts`. That is
 * only safe while nothing in the app calls them, so this test holds both halves: the aliases exist
 * (without them the 12 KB gzipped is back in the entry and the staff budget is over again), and no
 * source file uses `supabase.from / rpc / schema / storage / functions` or imports the packages.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

import * as shim from '../shims/unused-data-clients-shim';

const SRC = resolve(__dirname, '..');
const PACKAGES = ['@supabase/functions-js', '@supabase/postgrest-js', '@supabase/storage-js'];
// The realtime client is swapped too (mobile slice 75 follow-up: the bell polls, so no socket to
// the auth provider is ever opened). Same shim file, different guard: see the last describe.
const REALTIME_PACKAGE = '@supabase/realtime-js';

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      sourceFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec|stories)\.(ts|tsx)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

describe('the data clients the app does not use', () => {
  it('are replaced by the shim in the build (all three packages aliased)', () => {
    const config = readFileSync(resolve(SRC, '..', 'vite.config.ts'), 'utf8');
    for (const pkg of PACKAGES) {
      expect(config, `${pkg} is aliased to the shim`).toContain(
        `'${pkg}': path.resolve(__dirname, './src/shims/unused-data-clients-shim.ts')`,
      );
    }
  });

  it('are not used by any source file', () => {
    const offenders: string[] = [];
    const call = /\bsupabase\s*\.\s*(from|rpc|schema|storage|functions)\b/;
    const importsPackage = new RegExp(`from\\s+['"](${PACKAGES.join('|')})['"]`);
    for (const file of sourceFiles(SRC)) {
      if (file.includes(`${sep}shims${sep}`)) continue;
      const text = readFileSync(file, 'utf8');
      if (call.test(text) || importsPackage.test(text)) offenders.push(relative(SRC, file));
    }
    expect(offenders, 'these files use a data client that is not part of the app build').toEqual([]);
  });
});

describe('the realtime client (no socket to the auth provider)', () => {
  it('is replaced by the shim in the build', () => {
    const config = readFileSync(resolve(SRC, '..', 'vite.config.ts'), 'utf8');
    expect(config, `${REALTIME_PACKAGE} is aliased to the shim`).toContain(
      `'${REALTIME_PACKAGE}': path.resolve(__dirname, './src/shims/unused-data-clients-shim.ts')`,
    );
  });

  it('is not used by any source file: no channel, no realtime token', () => {
    const offenders: string[] = [];
    const call = /\bsupabase\s*\.\s*(channel|removeChannel|removeAllChannels|getChannels|realtime)\b/;
    const importsPackage = new RegExp(`from\\s+['"]${REALTIME_PACKAGE}['"]`);
    for (const file of sourceFiles(SRC)) {
      if (file.includes(`${sep}shims${sep}`)) continue;
      const text = readFileSync(file, 'utf8');
      if (call.test(text) || importsPackage.test(text)) offenders.push(relative(SRC, file));
    }
    expect(offenders, 'these files open a realtime channel, which the app build cannot do').toEqual([]);
  });

  it('opens nothing: a client built from the shim has no socket and takes a token without error', async () => {
    const client = new shim.RealtimeClient('wss://example.invalid/realtime/v1', {}) as unknown as {
      setAuth: (t?: string) => Promise<void>;
      connect: () => void;
      getChannels: () => unknown[];
    };
    await expect(client.setAuth('token')).resolves.toBeUndefined();
    await expect(client.setAuth()).resolves.toBeUndefined();
    expect(() => client.connect()).not.toThrow();
    expect(client.getChannels()).toEqual([]);
  });

  it('throws a plain message, naming no vendor, if a channel is requested', () => {
    const client = new shim.RealtimeClient('wss://example.invalid/realtime/v1', {}) as unknown as { channel: (n: string) => unknown };
    expect(() => client.channel('x')).toThrow('This data client is not part of the app build.');
  });
});

describe('the shim', () => {
  it('builds a client without doing anything, so the umbrella package can construct it', () => {
    expect(() => new shim.StorageClient()).not.toThrow();
    expect(() => new shim.PostgrestClient()).not.toThrow();
    expect(() => new shim.FunctionsClient()).not.toThrow();
  });

  it('throws a plain message, naming no vendor, when one is used', () => {
    const client = new shim.PostgrestClient() as unknown as { from: (t: string) => unknown };
    expect(() => client.from('anything')).toThrow('This data client is not part of the app build.');
  });

  it('keeps every export name the umbrella package imports', () => {
    for (const name of [
      'FunctionRegion',
      'FunctionsClient',
      'FunctionsError',
      'FunctionsFetchError',
      'FunctionsHttpError',
      'FunctionsRelayError',
      'PostgrestClient',
      'PostgrestError',
      'RealtimeClient',
      'StorageApiError',
      'StorageClient',
    ]) {
      expect(shim, name).toHaveProperty(name);
    }
  });
});
