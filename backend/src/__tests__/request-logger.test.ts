import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import app from '../app';

/** Capture everything written to stdout (where morgan logs) during a block. */
function captureStdout() {
  const lines: string[] = [];
  const spy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation(((chunk: unknown) => {
      lines.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    }) as typeof process.stdout.write);
  return { lines, restore: () => spy.mockRestore() };
}

// Let morgan's response-'finish' listener run before we assert.
const flush = () => new Promise((r) => setImmediate(r));

describe('request logger redaction', () => {
  it('masks sensitive query values and never logs their raw value', async () => {
    const cap = captureStdout();
    try {
      await request(app).get('/api?token=zzsecretzz-9988&page=2');
      await flush();
    } finally {
      cap.restore();
    }
    const out = cap.lines.join('');
    expect(out).not.toContain('zzsecretzz-9988');
    expect(out).toContain('token=REDACTED');
    expect(out).toContain('page=2'); // non-sensitive params survive
  });

  it('never logs the Authorization header value', async () => {
    const cap = captureStdout();
    try {
      await request(app).get('/api').set('Authorization', 'Bearer authzz-7766');
      await flush();
    } finally {
      cap.restore();
    }
    expect(cap.lines.join('')).not.toContain('authzz-7766');
  });
});
