import type { Punch } from './types';

export const SHIFT_START_MIN = 8 * 60; // 08:00 local
export const ON_TIME_GRACE_MIN = 5;

export type Session = {
  userId: string;
  userName: string;
  inTs: number;
  outTs: number | null; // null => still clocked in
  minutes: number; // 0 while open
  /** Where the clock-in happened. */
  inLat: number;
  inLng: number;
  /** Where the clock-out happened; null while the session is still open. */
  outLat: number | null;
  outLng: number | null;
};

export function minutesOfDay(ts: number): number {
  const d = new Date(ts);
  return d.getHours() * 60 + d.getMinutes();
}

export function isLate(inTs: number): boolean {
  return minutesOfDay(inTs) > SHIFT_START_MIN + ON_TIME_GRACE_MIN;
}

function toSession(inP: Punch, outP: Punch | null): Session {
  return {
    userId: inP.userId,
    userName: inP.userName,
    inTs: inP.ts,
    outTs: outP ? outP.ts : null,
    minutes: outP ? Math.max(0, Math.round((outP.ts - inP.ts) / 60000)) : 0,
    inLat: inP.lat,
    inLng: inP.lng,
    outLat: outP ? outP.lat : null,
    outLng: outP ? outP.lng : null,
  };
}

export function buildSessions(punches: Punch[]): Session[] {
  const byUser = new Map<string, Punch[]>();
  for (const p of punches) {
    const arr = byUser.get(p.userId) ?? [];
    arr.push(p);
    byUser.set(p.userId, arr);
  }
  const sessions: Session[] = [];
  for (const arr of byUser.values()) {
    const sorted = [...arr].sort((a, b) => a.ts - b.ts);
    let open: Punch | null = null;
    for (const p of sorted) {
      if (p.type === 'IN') {
        if (open) sessions.push(toSession(open, null)); // previous IN never closed
        open = p;
      } else {
        if (open) {
          sessions.push(toSession(open, p));
          open = null;
        }
        // OUT with no open IN => ignore
      }
    }
    if (open) sessions.push(toSession(open, null));
  }
  return sessions.sort((a, b) => a.inTs - b.inTs);
}
