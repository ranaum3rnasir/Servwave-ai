import { useEffect, useState } from 'react';

const HOUR_MS = 3_600_000;
const URGENT_UNDER_HOURS = 48;

export interface TimeLeft {
  text: string;
  /** Under 48 hours left: the deadline shows in red and bold. */
  urgent: boolean;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * How long is left to answer a dispute, as the Payments page words it: "Past due" once it has passed; under 48 hours
 * "{n} hour(s) left" (never below 1 hour) and urgent; otherwise whole days, rounded down. Written once: the card, the
 * Needs-attention table, the payment drawer and the dispute drawer all import this and never build a second one.
 * Null when there is no (readable) deadline, so the caller leaves the part out rather than print a placeholder.
 */
export function timeLeft(respondByIso: string | null | undefined, now: number | Date): TimeLeft | null {
  if (!respondByIso) return null;
  const end = Date.parse(respondByIso);
  if (Number.isNaN(end)) return null;
  const ms = end - (typeof now === 'number' ? now : now.getTime());
  if (ms <= 0) return { text: 'Past due', urgent: false };
  const hours = Math.floor(ms / HOUR_MS);
  if (hours < URGENT_UNDER_HOURS) return { text: `${plural(Math.max(hours, 1), 'hour')} left`, urgent: true };
  return { text: `${plural(Math.floor(hours / 24), 'day')} left`, urgent: false };
}

/** The current time in ms, refreshed every `intervalMs`; its timer is cleared when the component goes away. */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
