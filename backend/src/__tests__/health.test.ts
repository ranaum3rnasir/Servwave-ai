import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';

describe('GET /health', () => {
  it('returns 200 with status and db:ok fields on success', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.db).toBe('ok');
    expect(res.body.timestamp).toBeDefined();
  });

  it('returns 503 with db:error when DB query fails', async () => {
    const spy = vi.spyOn(prisma, '$queryRaw').mockRejectedValueOnce(new Error('db down'));
    const res = await request(app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.db).toBe('error');
    spy.mockRestore();
  });

  it('leaves no armed timer behind after a fast success', async () => {
    // The probe budget is a setTimeout that the success path never waits for.
    // Without the clearTimeout in the handler's `finally`, it stays armed and
    // holds a ref on the event loop, so every shutdown stalls up to 2s. Nothing
    // else in the suite notices that, which is how an untested `finally` turns
    // into a test that cannot fail. Count live Timeout handles across the
    // request instead: real timers only, so no fake-timer setup here.
    const armedTimers = () =>
      process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

    const before = armedTimers();
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(armedTimers()).toBe(before);
  });

  it('answers 503 instead of hanging when the DB probe never settles', async () => {
    // Only setTimeout/clearTimeout are faked: the request still travels over a
    // real socket, so supertest works, but the handler's probe budget is ours
    // to advance instantly instead of waiting 2s of wall clock.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const errorSpy = vi.mocked(logger.error);
    errorSpy.mockClear();

    let probeEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      probeEntered = resolve;
    });
    const spy = vi.spyOn(prisma, '$queryRaw').mockImplementationOnce(() => {
      probeEntered();
      // Never settles: neither a row nor an error, which is exactly what CI saw.
      return new Promise(() => {}) as never;
    });

    try {
      // .then() is what makes supertest actually issue the request; without a
      // subscriber it would sit unsent and `entered` would never resolve.
      const pending = request(app)
        .get('/health')
        .then((r) => r);
      await entered;
      await vi.advanceTimersByTimeAsync(2000);
      const res = await pending;

      expect(res.status).toBe(503);
      expect(res.body.status).toBe('ok');
      expect(res.body.db).toBe('error');
      expect(res.body.timestamp).toBeDefined();

      const logged = errorSpy.mock.calls.map((args) => String(args[0])).join('\n');
      expect(logged).toMatch(/timed out/i);
      expect(logged).toContain('2000');
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
  });
});
