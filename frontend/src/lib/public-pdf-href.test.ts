import { describe, it, expect, afterEach, vi } from 'vitest';
import { publicPdfHref } from './public-pdf-href';

afterEach(() => vi.unstubAllEnvs());

describe('publicPdfHref (payments go-live slice 33: built from the configured API base, never a hardcoded host)', () => {
  it('uses whatever API base the environment configures', () => {
    vi.stubEnv('VITE_API_URL', 'https://api.example-servwave.test');
    expect(publicPdfHref('invoices', 'inv-1', 'tok en')).toBe(
      'https://api.example-servwave.test/api/invoices/inv-1/public/pdf?token=tok%20en',
    );
  });

  it('follows the base when it changes, so no host is baked into the link', () => {
    vi.stubEnv('VITE_API_URL', 'https://other.example.test');
    expect(publicPdfHref('estimates', 'e-1', 't')).toMatch(/^https:\/\/other\.example\.test\/api\/estimates\/e-1\//);
  });
});
