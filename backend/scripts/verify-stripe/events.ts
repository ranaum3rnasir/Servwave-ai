import { randomUUID } from 'crypto';

/** The API version the backend's webhook is pinned to; every fixture event is shaped for it. */
export const ACACIA_VERSION = '2025-02-24.acacia';

export interface AcaciaEvent {
  id: string;
  object: 'event';
  api_version: string;
  type: string;
  created: number;
  account?: string;
  data: { object: Record<string, unknown> };
}

/**
 * A fixture event in the pinned version's envelope. `account` is set for an event that happened on
 * a connected account (a direct charge), which is how the backend finds the owning org.
 */
export function acaciaEvent(
  type: string,
  object: Record<string, unknown>,
  opts: { account?: string; id?: string; created?: number } = {},
): AcaciaEvent {
  return {
    id: opts.id ?? `evt_qa39_${randomUUID().replace(/-/g, '')}`,
    object: 'event',
    api_version: ACACIA_VERSION,
    type,
    created: opts.created ?? Math.floor(Date.now() / 1000),
    ...(opts.account ? { account: opts.account } : {}),
    data: { object },
  };
}
