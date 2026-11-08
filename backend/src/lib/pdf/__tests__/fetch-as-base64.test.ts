import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// F-16 hardening: fetchAsBase64 fetches the org logo for PDF embedding. The only
// legitimate source is the org's Supabase Storage public URL, so we pin the
// allowlisted host to THIS test's loopback origin and exercise both the allowed
// and the disallowed branches deterministically. No live network, no PII.
let baseHost = '';
vi.mock('../../../config/env', () => ({
  env: {
    get SUPABASE_URL() {
      return `http://${baseHost}`;
    },
  },
}));

// Imported AFTER the mock is registered so the module picks up the mocked env.
import { fetchAsBase64 } from '../index';

describe('fetchAsBase64 (F-16 hardening)', () => {
  let server: http.Server;
  let port = 0;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/ok.png') {
        res.setHeader('content-type', 'image/png');
        res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47])); // tiny PNG-ish payload
        return;
      }
      if (req.url === '/huge') {
        // Stream well past the 2MB cap; the fetch must abort mid-stream.
        res.setHeader('content-type', 'image/png');
        const chunk = Buffer.alloc(512 * 1024, 0);
        let written = 0;
        const pump = () => {
          // ~10MB total, far past the cap. Stop once the client tears down.
          if (written >= 20 || res.writableEnded || res.destroyed) return;
          written += 1;
          if (res.write(chunk)) {
            setImmediate(pump);
          } else {
            res.once('drain', pump);
          }
        };
        pump();
        return; // never .end() — relies on the byte cap to abort
      }
      if (req.url === '/redirect') {
        res.statusCode = 302;
        res.setHeader('location', 'http://169.254.169.254/latest/meta-data/');
        res.end();
        return;
      }
      if (req.url === '/hang') {
        // Never respond — the 5s timeout must fire.
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as AddressInfo).port;
    baseHost = `127.0.0.1:${port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('fetches and base64-encodes a logo from the allowlisted host', async () => {
    const out = await fetchAsBase64(`http://${baseHost}/ok.png`);
    expect(out.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('rejects a non-allowlisted host (SSRF block)', async () => {
    await expect(
      fetchAsBase64('http://169.254.169.254/latest/meta-data/'),
    ).rejects.toThrow(/Disallowed logo host/);
  });

  it('rejects a disallowed protocol', async () => {
    await expect(fetchAsBase64('file:///etc/passwd')).rejects.toThrow(/protocol/);
  });

  it('refuses to follow redirects (no off-host bounce)', async () => {
    await expect(
      fetchAsBase64(`http://${baseHost}/redirect`),
    ).rejects.toThrow(/Redirect not allowed/);
  });

  it('aborts when the response exceeds the byte cap', async () => {
    await expect(fetchAsBase64(`http://${baseHost}/huge`)).rejects.toThrow(
      /maximum size/,
    );
  });

  it('times out a hanging host within ~5s', async () => {
    await expect(fetchAsBase64(`http://${baseHost}/hang`)).rejects.toThrow(
      /timed out/,
    );
  }, 8_000);
});
