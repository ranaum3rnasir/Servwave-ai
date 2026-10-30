import type { NextFunction, Request, Response } from 'express';
import { runWithPingScope } from '../services/notifications/realtimePublish';

/**
 * Holds the live-update pings an API request raises (an alert's recipients) until its response has been written, so the
 * pings never compete with the handler that is still reading to build its answer (see services/notifications/realtimePublish).
 */
export function realtimePingScope(_req: Request, res: Response, next: NextFunction): void {
  runWithPingScope(res, () => next());
}
