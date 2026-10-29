/** "3 hours", "2 days": time since `fromIso`, in the largest whole unit (at least a minute). */
export function formatDurationSince(fromIso: string, now: number = Date.now()): string | null {
  const from = Date.parse(fromIso);
  if (Number.isNaN(from)) return null;
  const minutes = Math.max(1, Math.floor((now - from) / 60_000));
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (minutes < 60) return plural(minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return plural(hours, 'hour');
  return plural(Math.floor(hours / 24), 'day');
}

/** Live time in status from when Spider started counting, else what the server wrote at alert time. */
export function formatTimeInStatus(fromIso: string | null, fallback: string | null): string {
  return (fromIso && formatDurationSince(fromIso)) || fallback || 'a while';
}
