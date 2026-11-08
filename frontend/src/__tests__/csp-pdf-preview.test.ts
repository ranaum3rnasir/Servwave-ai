import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The PDF previews (estimate/invoice dialog, Branding live preview, Org settings)
// render the generated PDF as `<iframe src={blob-url}>`. The deployed CSP lives in
// frontend/vercel.json; if `frame-src` omits `blob:`, the browser blocks the iframe
// ("This content is blocked"). Guard against that regression — the preview has broken
// this way before.
function deployedCsp(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const cfg = JSON.parse(readFileSync(join(here, '../../vercel.json'), 'utf8'));
  for (const route of cfg.headers ?? []) {
    for (const h of route.headers ?? []) {
      if (String(h.key).toLowerCase() === 'content-security-policy') return String(h.value);
    }
  }
  return '';
}

describe('deployed CSP (frontend/vercel.json)', () => {
  it('frame-src allows blob: so blob-URL PDF previews can render in an iframe', () => {
    const csp = deployedCsp();
    const frameSrc = csp
      .split(';')
      .map((d) => d.trim())
      .find((d) => d.startsWith('frame-src')) ?? '';
    expect(frameSrc, `frame-src directive was: "${frameSrc}"`).toContain('blob:');
  });

  // connect-src used to carry `https://*.onrender.com`, which let the page talk to ANY
  // app on that shared hosting platform. Prod moved to api.servwave.com (2026-09-22) and
  // the old vendor origin was closed at Render's router (2026-09-24). This sandbox's own
  // API runs on that domain, so name it explicitly rather than wildcarding.
  it('connect-src names the sandbox API host explicitly, with no onrender wildcard', () => {
    const connectSrc = deployedCsp()
      .split(';')
      .map((d) => d.trim())
      .find((d) => d.startsWith('connect-src')) ?? '';

    expect(connectSrc, 'connect-src directive was not found').not.toBe('');
    expect(connectSrc, `connect-src was: "${connectSrc}"`).not.toContain('*.onrender.com');
    // The sandbox frontend calls this host for every API request; dropping it breaks the app.
    expect(connectSrc).toContain('https://servwave-dev-api.onrender.com');
    // Production's own API host must stay reachable too.
    expect(connectSrc).toContain('https://api.servwave.com');
  });
});
