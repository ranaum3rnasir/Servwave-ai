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
  it('logs an inbound webhook as its route shape: no URL token, no query values (#3446)', async () => {
    const token = 'f00d'.repeat(16);
    const cap = captureStdout();
    try {
      await request(app)
        .post(`/api/webhooks/call-tracking/callrail/${token}/pre?callername=DOE%2CJANE&callernum=%2B16095550123`)
        .set('Content-Type', 'application/json')
        .send('{}');
      await request(app).post(`/api/webhooks/web-form/forminator/${token}`).set('Content-Type', 'application/json').send('{}');
      await flush();
    } finally {
      cap.restore();
    }
    const out = cap.lines.join('');
    expect(out).toContain('/api/webhooks/call-tracking/callrail/REDACTED/pre?REDACTED');
    expect(out).toContain('/api/webhooks/web-form/forminator/REDACTED');
    for (const leaked of [token, 'DOE', '6095550123']) expect(out).not.toContain(leaked);
  });
});
