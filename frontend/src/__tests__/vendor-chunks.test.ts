/**
 * Mobile slice 61 (PERF-01): which vendor packages the build pins into a fixed chunk.
 *
 * A fixed chunk is downloaded whole by everything that imports any part of it. All of @tanstack in
 * one chunk put the table engine and the virtual-list engine (about 138 KB of source that only
 * lazy pages use) into the staff first download, because the query client, which the first screen
 * does need, lives in the same package scope. The table and virtual engines get their own chunks so
 * the query client's chunk carries only the query client.
 */
import { describe, expect, it } from 'vitest';

import { vendorChunk } from '../../vendor-chunks';

const nm = (pkg: string, file = 'build/modern/index.js') => `/repo/node_modules/${pkg}/${file}`;

describe('vendorChunk', () => {
  it.each([
    ['@tanstack/react-query', 'vendor-query'],
    ['@tanstack/query-core', 'vendor-query'],
    ['@tanstack/react-table', 'vendor-table'],
    ['@tanstack/table-core', 'vendor-table'],
    ['@tanstack/react-virtual', 'vendor-virtual'],
    ['@tanstack/virtual-core', 'vendor-virtual'],
    ['react-dom', 'vendor-react'],
    ['react-router', 'vendor-react'],
    ['tslib', 'vendor-react'],
    ['@supabase/auth-js', 'vendor-auth'],
    ['iceberg-js', 'vendor-auth'],
  ])('puts %s in %s', (pkg, chunk) => {
    expect(vendorChunk(nm(pkg))).toBe(chunk);
  });

  it('leaves everything else to the bundler', () => {
    expect(vendorChunk(nm('axios'))).toBeUndefined();
    expect(vendorChunk('/repo/frontend/src/main.tsx')).toBeUndefined();
  });

  it('names no chunk after a vendor (chunk names reach the served head)', () => {
    for (const pkg of ['@supabase/auth-js', '@tanstack/react-table', '@tanstack/react-query', 'react-dom']) {
      expect(vendorChunk(nm(pkg))).not.toMatch(/supabase|tanstack|sentry|stripe/i);
    }
  });
});
