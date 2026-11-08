import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../app';
import { parseCorsOrigins } from '../lib/cors-origins';
import { env } from '../config/env';

describe('CORS preflight caching', () => {
  it('sets Access-Control-Max-Age on an allowed-origin preflight', async () => {
    const allowedOrigin = parseCorsOrigins(env)[0];

    const res = await request(app)
      .options('/api/estimates')
      .set('Origin', allowedOrigin)
      .set('Access-Control-Request-Method', 'GET');

    // Without maxAge the browser re-fires a preflight every few seconds; the
    // header tells it to cache the result and skip that round-trip.
    expect(res.headers['access-control-max-age']).toBe('86400');
  });
});
