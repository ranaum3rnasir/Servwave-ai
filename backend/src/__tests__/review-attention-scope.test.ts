/* =============================================================================
   Roles & Permissions, PRD 6, slice S06.24 - when the queued Office review alerts are sent.

   A writer inside a transaction only QUEUES the alert (services/notifications/reviewAttentionQueue); the request sends the
   queue once its response has gone out, and only for a success status: a request that failed alerts nobody, a request
   that landed several items sends them together, and a writer reached outside any request raises nothing (and says so).
   ========================================================================== */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const { sender } = vi.hoisted(() => ({ sender: vi.fn(async () => undefined) }));
vi.mock('../services/notifications/jobReviewAlerts', () => ({ alertQueuedReviewAttention: sender }));

import { reviewAttentionScope } from '../middleware/reviewAttentionScope';
import { queueReviewAttention, reviewAttentionSettled } from '../services/notifications/reviewAttentionQueue';
import { logger } from '../lib/logger';

const item = (title: string) => ({ reason: 'A file was deleted', title });
const pending = (title: string) => ({ orgId: 'org', actorId: 'u1', jobId: 'job-1', onlyIfDone: false, items: [item(title)] });

function appWith(handler: express.RequestHandler) {
  const app = express();
  app.use(reviewAttentionScope);
  app.get('/go', handler);
  return app;
}

beforeEach(() => sender.mockClear());

describe('the request-scoped queue of Office review alerts', () => {
  it('sends everything a successful request queued, together, after the response', async () => {
    const res = await request(appWith(async (_req, res) => {
      // Queued from inside awaited work, as a writer inside a transaction does.
      await Promise.resolve();
      queueReviewAttention(pending('File: A'));
      await new Promise((resolve) => setImmediate(resolve));
      queueReviewAttention(pending('File: B'));
      res.json({ ok: true });
    })).get('/go');
    expect(res.status).toBe(200);
    await reviewAttentionSettled();

    expect(sender).toHaveBeenCalledTimes(1);
    const queue = (sender.mock.calls[0] as unknown as [Array<{ items: Array<{ title: string }> }>])[0];
    expect(queue.flatMap((p) => p.items.map((i) => i.title))).toEqual(['File: A', 'File: B']);
  });

  it('sends nothing for a request that failed', async () => {
    const res = await request(appWith((_req, res) => {
      queueReviewAttention(pending('File: A'));
      res.status(500).json({ error: 'boom' });
    })).get('/go');
    expect(res.status).toBe(500);
    await reviewAttentionSettled();
    expect(sender).not.toHaveBeenCalled();
  });

  it('keeps each request\'s queue to itself', async () => {
    const app = appWith(async (_req, res) => {
      queueReviewAttention(pending(`File: ${String(_req.query.n)}`));
      await new Promise((resolve) => setTimeout(resolve, 5));
      res.json({});
    });
    await Promise.all([request(app).get('/go?n=1'), request(app).get('/go?n=2')]);
    await reviewAttentionSettled();
    const sentTitles = sender.mock.calls.map((c) => (c as unknown as [Array<{ items: Array<{ title: string }> }>])[0].flatMap((p) => p.items.map((i) => i.title)));
    expect(sentTitles.sort()).toEqual([['File: 1'], ['File: 2']]);
  });

  it('a writer reached outside any request raises nothing and says so, with no customer content', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    queueReviewAttention(pending('File: Private name.png'));
    expect(sender).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls[0])).not.toContain('Private name');
    warn.mockRestore();
  });
});
