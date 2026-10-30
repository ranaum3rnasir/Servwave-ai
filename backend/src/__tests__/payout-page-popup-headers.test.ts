// Payments go-live slice 34 - the processor's embedded flow opens its sign-in in a popup that talks back to
// the opener. A strict same-origin Cross-Origin-Opener-Policy on a response served to that opener severs the
// link. Helmet's default is same-origin, so the API must relax it (and must never send a COEP either).
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../app';

describe('API responses leave popup windows working', () => {
  it('does not send a strict same-origin Cross-Origin-Opener-Policy', async () => {
    const res = await request(app).get('/api');
    const coop = res.headers['cross-origin-opener-policy'];
    if (coop !== undefined) expect(['unsafe-none', 'same-origin-allow-popups']).toContain(coop);
  });

  it('sends no Cross-Origin-Embedder-Policy', async () => {
    const res = await request(app).get('/api');
    expect(res.headers['cross-origin-embedder-policy']).toBeUndefined();
  });
});
