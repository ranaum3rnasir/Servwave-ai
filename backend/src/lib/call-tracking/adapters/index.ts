import type { CallTrackingProvider } from '@prisma/client';
import type { TrackedCallEvent } from '../types';
import { parseCallRail } from './callrail';
import { parseWhatConverts } from './whatconverts';

export const CALL_TRACKING_PROVIDERS: ReadonlySet<string> = new Set<CallTrackingProvider>([
  'callrail',
  'whatconverts',
]);

export function isCallTrackingProvider(v: string): v is CallTrackingProvider {
  return CALL_TRACKING_PROVIDERS.has(v);
}

/**
 * Parse a vendor body into the normalised event, or null when the body does
 * not carry the fields that provider's adapter needs. `phase` is the route's
 * hint (CallRail posts pre_call and post_call to the same URL, telling them
 * apart only by content, so the hint is optional).
 */
export function parseTrackedCallEvent(
  provider: CallTrackingProvider,
  body: unknown,
  phase?: 'pre' | 'post',
): TrackedCallEvent | null {
  switch (provider) {
    case 'callrail':
      return parseCallRail(body, phase);
    case 'whatconverts':
      return parseWhatConverts(body);
    default:
      return null;
  }
}
