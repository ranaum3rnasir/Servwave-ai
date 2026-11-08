import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../app';

describe('security headers', () => {
  it('sets X-Frame-Options: DENY on API responses', async () => {
    const res = await request(app).get('/api');
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('emits a non-empty Content-Security-Policy header', async () => {
    const res = await request(app).get('/api');
    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.headers['content-security-policy']!.length).toBeGreaterThan(0);
  });

  it('does not expose X-Powered-By header', async () => {
    const res = await request(app).get('/api');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
