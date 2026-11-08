// Pure logic for the Call Tracking report (call history + recordings log).
// No React, no I/O — filtering + statistics over CallSession records so it can
// be unit-tested and later mirrored to a backend reporting endpoint (the S1
// pure-logic pattern). Data generation lives in `call-tracking-data.ts`.

import type { CallSession } from '@/lib/api/communication-shared/phone-calls';

export interface CallFilters {
  from: Date | null;
  to: Date | null;
  /** Matches client display name OR either phone number (case-insensitive). */
  clientQuery: string;
  recordedOnly: boolean;
  direction: 'all' | 'inbound' | 'outbound';
}

export interface CallStats {
  total: number;
  answered: number; // status === 'completed'
  missed: number; // status === 'missed'
  voicemail: number; // status === 'voicemail'
  answeredRate: number; // answered / total * 100 (0 when total 0)
  inbound: number;
  outbound: number;
  totalTalkSec: number;
  avgTalkSec: number; // over calls with a durationSec > 0
  recorded: number;
  attributedRevenue: number;
  bookings: number; // disposition === 'booked'
  bookingRate: number; // bookings / total * 100
}

/** A call decorated with its resolved client display name (for search + table). */
export interface DecoratedCall extends CallSession {
  clientName: string;
}

export function filterCalls(calls: DecoratedCall[], f: CallFilters): DecoratedCall[] {
  const q = f.clientQuery.trim().toLowerCase();
  return calls.filter((c) => {
    const t = new Date(c.startedAt).getTime();
    if (f.from && t < f.from.getTime()) return false;
    if (f.to && t > f.to.getTime()) return false;
    if (f.recordedOnly && !c.hasRecording) return false;
    if (f.direction !== 'all' && c.direction !== f.direction) return false;
    if (q) {
      const hay = `${c.clientName} ${c.fromNumber} ${c.toNumber}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export function computeStats(calls: DecoratedCall[]): CallStats {
  const total = calls.length;
  const answered = calls.filter((c) => c.status === 'completed').length;
  const missed = calls.filter((c) => c.status === 'missed').length;
  const voicemail = calls.filter((c) => c.status === 'voicemail').length;
  const inbound = calls.filter((c) => c.direction === 'inbound').length;
  const outbound = calls.filter((c) => c.direction === 'outbound').length;
  const durations = calls.map((c) => c.durationSec ?? 0).filter((d) => d > 0);
  const totalTalkSec = durations.reduce((a, d) => a + d, 0);
  const avgTalkSec = durations.length ? Math.round(totalTalkSec / durations.length) : 0;
  const recorded = calls.filter((c) => c.hasRecording).length;
  const attributedRevenue = calls.reduce((a, c) => a + (c.revenue ?? 0), 0);
  const bookings = calls.filter((c) => c.disposition === 'booked').length;
  return {
    total,
    answered,
    missed,
    voicemail,
    answeredRate: total ? (answered / total) * 100 : 0,
    inbound,
    outbound,
    totalTalkSec,
    avgTalkSec,
    recorded,
    attributedRevenue,
    bookings,
    bookingRate: total ? (bookings / total) * 100 : 0,
  };
}

/** Seconds → "m:ss" (or "—" when missing/zero). */
export function formatDuration(sec?: number): string {
  if (!sec) return '—';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Seconds → compact talk-time ("1h 12m", "8m", "0m") for KPI tiles. */
export function formatTalkTime(sec: number): string {
  if (!sec) return '0m';
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}
