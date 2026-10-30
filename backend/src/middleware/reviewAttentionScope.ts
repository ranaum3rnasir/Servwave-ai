import type { NextFunction, Request, Response } from 'express';
import { flushReviewAttention, runWithAttentionQueue } from '../services/notifications/reviewAttentionQueue';

/**
 * Gives each API request its own queue for the Office review attention alerts its writers raise (see
 * services/notifications/reviewAttentionQueue). The queue is sent once the response has gone out with a success status,
 * so the alert never waits on the person's request and never fires for a change that did not land.
 */
export function reviewAttentionScope(_req: Request, res: Response, next: NextFunction): void {
  const { queue } = runWithAttentionQueue(() => next());
  res.once('finish', () => {
    if (res.statusCode < 400) flushReviewAttention(queue);
  });
}
