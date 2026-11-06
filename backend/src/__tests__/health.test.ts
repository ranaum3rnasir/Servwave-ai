/* =============================================================================
   GET /health (#3106) - the platform's restart check. It says the process is alive, from memory: no database call.
   It fails only when the event loop was blocked for longer than the limit (2 s).

   A blocked event loop cannot answer at all, so "fails" means: the first answer after the loop was blocked past the
   limit is a 503, and the answers after the loop has been free again are 200 once more. The test blocks the loop of
   this very process, then asks over HTTP.

   The database side (every line held, /health/deep) is health-db.test.ts, on a real database.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../app';

/** Block this process's event loop, doing nothing else, for `ms`. */
function blockEventLoop(ms: number) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    /* busy */
  }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('GET /health', () => {
  it('answers 200 with status ok and a timestamp', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.timestamp).toBe('string');
  });

  it('answers 200 after the event loop was blocked for 300 ms', async () => {
    await pause(600); // let the lag measurement settle from any earlier test's block
    blockEventLoop(300);
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
  });

  it('answers 503 after the event loop was blocked for 2.5 s, and 200 again once it has been free', async () => {
    await pause(600);
    blockEventLoop(2500);

    const blocked = await request(app).get('/health');
    expect(blocked.status).toBe(503);
    expect(blocked.body.status).toBe('error');

    await pause(1000);
    const recovered = await request(app).get('/health');
    expect(recovered.status).toBe(200);
  });
});
