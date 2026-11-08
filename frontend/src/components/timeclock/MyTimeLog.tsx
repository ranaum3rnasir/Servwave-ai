import { useMemo } from 'react';
import { Card } from '@/components/ui/card';
import { Heading } from '@/components/ui/heading';
import { usePunches } from '@/lib/api/timeclock';
import { buildSessions } from '@/lib/timeclock/aggregate';
import { useScheduleTimezone, formatInstant } from '@/lib/schedule-tz';

// Mirrors TimesheetsReport.tsx — viewer-local time, same as the header widget.
const fmtHrs = (min: number) => `${(min / 60).toFixed(1)}h`;
// Punch times are the COMPANY's clock: a shift that started at 8am started at 8am for
// payroll, whatever zone the person reading the log happens to be in.
const fmtClock = (ts: number, tz: string) =>
  formatInstant(ts, tz, { hour: '2-digit', minute: '2-digit' });
const fmtDate = (ts: number, tz: string) =>
  formatInstant(ts, tz, { month: 'short', day: 'numeric' });

export function MyTimeLog() {
  const tz = useScheduleTimezone();
  const { data: punches = [], isLoading } = usePunches({ scope: 'me' });
  // buildSessions returns ascending by inTs; show newest first.
  const sessions = useMemo(() => [...buildSessions(punches)].reverse(), [punches]);
  const totalMin = useMemo(() => sessions.reduce((a, s) => a + s.minutes, 0), [sessions]);

  return (
    <Card className="space-y-4">
      <Heading level={3}>Time In &amp; Time Out</Heading>
      {isLoading ? (
        <p className="text-sm text-text-secondary">Loading…</p>
      ) : sessions.length === 0 ? (
        <p className="text-sm text-text-secondary">No clock-in activity yet.</p>
      ) : (
        <>
          <p className="text-sm text-text-secondary">
            Total hours worked:{' '}
            <span className="font-semibold tabular-nums text-text-primary">{fmtHrs(totalMin)}</span>
          </p>
          <div className="max-h-80 overflow-y-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-text-secondary">
                  <th className="py-2 pr-4 font-medium">Date</th>
                  <th className="py-2 pr-4 font-medium">Clock In</th>
                  <th className="py-2 pr-4 font-medium">Clock Out</th>
                  <th className="py-2 text-right font-medium">Hours</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.inTs} className="border-b border-border last:border-0">
                    <td className="py-2 pr-4 text-text-primary">{fmtDate(s.inTs, tz)}</td>
                    <td className="py-2 pr-4 tabular-nums text-text-primary">{fmtClock(s.inTs, tz)}</td>
                    <td className="py-2 pr-4 tabular-nums">
                      {s.outTs !== null ? (
                        <span className="text-text-primary">{fmtClock(s.outTs, tz)}</span>
                      ) : (
                        <span className="font-medium text-sage-700">On the clock</span>
                      )}
                    </td>
                    <td className="py-2 text-right tabular-nums text-text-primary">
                      {s.outTs !== null ? fmtHrs(s.minutes) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}

export default MyTimeLog;
