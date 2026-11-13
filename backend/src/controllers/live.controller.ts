/**
 * GET /api/live (#3472): opens the signed-in person's live line (services/live/liveLines.ts). The route's
 * `authenticate` is the one sign-in check; this reads nothing from the database. Its first message (live.hello) says
 * whether Spider's check runs on this server (#3469). A refused line answers 429 (this
 * person holds too many) or 503 (the server is full or stopping) with Retry-After: the screen keeps its 30-second
 * checks and tries again later.
 */
import type { Request, Response } from 'express';
import { isSuperUser } from '../lib/permissions/effectiveRole';
import { LIVE_RETRY_AFTER_S, openLiveLine } from '../services/live/liveLines';
import { spiderTickRunning } from '../services/spider/tick';

export function openLive(req: Request, res: Response): void {
  const user = req.user!;
  // The first message says whether Spider's check runs on this server (#3469): only then does the screen slow its own
  // Spider check to the 5-minute safety net; otherwise it keeps asking every 30 s even with the line open.
  const refused = openLiveLine({ id: user.id, orgId: user.organization_id, isAdmin: isSuperUser(user) }, req, res, {
    spider_tick: spiderTickRunning(),
    // The bell's messages are sent from here on (#3473): only then does the screen slow the bell's own check.
    bell: true,
  });
  if (!refused) return;
  // The browser gave up while its sign-in was being checked: nobody is left to answer.
  if (refused.reason === 'gone') return;
  res.setHeader('Retry-After', String(LIVE_RETRY_AFTER_S));
  res.status(refused.status).json({
    error: refused.status === 429 ? 'Too many live updates open for this account' : 'Live updates are not available right now',
  });
}
