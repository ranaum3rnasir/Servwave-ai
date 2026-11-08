import { useEffect, useMemo, useState } from 'react';
import { Check, AlertCircle } from 'lucide-react';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { cn } from '@/lib/utils';
import { AI_SALES_REP } from '@/lib/ai-center/agents';
import api from '@/lib/axios';

export interface BookingTarget {
  name: string;
  role: string;
  initial: string;
  color: string;
}

const SLOTS = ['9:00 AM', '10:30 AM', '11:00 AM', '1:00 PM', '2:30 PM', '4:00 PM'];

/** The next `count` weekdays starting tomorrow (mock availability). */
function upcomingWeekdays(count: number) {
  const days: { label: string; sub: string; key: string }[] = [];
  const d = new Date();
  d.setDate(d.getDate() + 1);
  while (days.length < count) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) {
      days.push({
        label: d.toLocaleDateString('en-US', { weekday: 'short' }),
        sub: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        key: d.toISOString().slice(0, 10),
      });
    }
    d.setDate(d.getDate() + 1);
  }
  return days;
}

/** "Book a call" flow — calendar + slots → real booking request → confirmation. */
export function BookingModal({
  target,
  onOpenChange,
}: {
  target: BookingTarget | null;
  onOpenChange: (open: boolean) => void;
}) {
  // Recomputed per open so the dates stay current; target is the trigger.
  const days = useMemo(() => upcomingWeekdays(8), [target]);
  const [dayIdx, setDayIdx] = useState(0);
  const [slot, setSlot] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDayIdx(0);
    setSlot(null);
    setConfirmed(false);
    setSubmitting(false);
    setError(null);
  }, [target]);

  const selectedDay = days[dayIdx];

  async function confirmBooking() {
    if (!target || !slot || !selectedDay) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.post('/api/ai-farm/bookings', {
        agentName: target.name,
        agentRole: target.role,
        day: `${selectedDay.label} ${selectedDay.sub}`,
        slot,
      });
      setConfirmed(true);
    } catch {
      setError("Something went wrong sending your booking request. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={!!target} onOpenChange={onOpenChange}>
      <DialogContent
        overlayClassName="bg-ocean-900/40"
        className="flex max-h-[88vh] w-[94vw] max-w-md flex-col gap-0 overflow-hidden p-0"
      >
        {target && (
          <VisuallyHidden>
            <DialogTitle>Book a call about {target.name}</DialogTitle>
          </VisuallyHidden>
        )}

        {target && !confirmed && (
          <>
            <div className="border-b border-border p-5 pr-14">
              <Heading level={2} scale="lg" weight="bold">
                Book a call about {target.name}
              </Heading>
              <p className="text-sm text-text-secondary">{target.role} · 30 min</p>
            </div>

            <div className="flex-1 overflow-y-auto p-5">
              {/* Sales rep */}
              <div className="mb-5 flex items-center gap-3 rounded-xl border border-border bg-background-light p-3">
                <Avatar className="h-10 w-10">
                  <AvatarFallback tone="solid">
                    {AI_SALES_REP.initials}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0">
                  <p className="text-sm font-bold text-text-primary">{AI_SALES_REP.name}</p>
                  <p className="truncate text-xs text-text-secondary">
                    {AI_SALES_REP.company} · {AI_SALES_REP.title}
                  </p>
                </div>
              </div>

              <p className="mb-4 text-sm text-text-secondary">
                Talk to {AI_SALES_REP.name} about getting {target.name} set up for your business.
              </p>

              {/* Day picker */}
              <p className="mb-2 text-xs font-bold uppercase tracking-wide text-text-soft">
                Select a day
              </p>
              <div className="mb-5 grid grid-cols-2 sm:grid-cols-4 gap-2">
                {days.map((d, i) => (
                  // Day picker cell (segmented toggle grid) - not Button-shaped. Deferred.
                  <button
                    key={d.key}
                    type="button"
                    onClick={() => setDayIdx(i)}
                    className={cn(
                      'flex flex-col items-center rounded-lg border px-1 py-2 text-center transition-colors',
                      i === dayIdx
                        ? 'border-ai-600 bg-ai-600 text-on-fill'
                        : 'border-border text-text-secondary hover:border-ai-200'
                    )}
                  >
                    <span className="text-[11px] font-semibold uppercase">{d.label}</span>
                    <span className="text-xs font-bold">{d.sub}</span>
                  </button>
                ))}
              </div>

              {/* Slots */}
              <p className="mb-2 text-xs font-bold uppercase tracking-wide text-text-soft">
                Select a time
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {SLOTS.map((s) => (
                  // Time-slot picker cell (segmented toggle grid) - not Button-shaped. Deferred.
                  <button
                    key={s}
                    type="button"
                    onClick={() => setSlot(s)}
                    className={cn(
                      'rounded-lg border px-2 py-2 text-sm font-semibold transition-colors',
                      slot === s
                        ? 'border-ai-600 bg-ai-600 text-on-fill'
                        : 'border-border text-text-primary hover:border-ai-200'
                    )}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>

            <div className="border-t border-border p-4">
              {error && (
                <div className="mb-3 flex items-center gap-2 rounded-lg border border-danger/20 bg-danger/5 px-3 py-2 text-xs font-medium text-danger">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  {error}
                </div>
              )}
              <Button
                variant="solid" tone="ai"
                className="w-full"
                disabled={!slot || submitting}
                onClick={confirmBooking}
              >
                {submitting
                  ? 'Booking…'
                  : slot
                    ? `Confirm ${selectedDay?.label} ${selectedDay?.sub} at ${slot}`
                    : 'Pick a time to continue'}
              </Button>
            </div>
          </>
        )}

        {target && confirmed && (
          <div className="flex flex-col items-center px-6 py-10 text-center">
            <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-sage-50 text-sage-700">
              <Check className="h-7 w-7" />
            </span>
            <Heading level={2} scale="xl" weight="bold">You're booked!</Heading>
            <p className="mt-1 text-sm font-semibold text-text-primary">
              {selectedDay?.label} {selectedDay?.sub} · {slot}
            </p>
            <p className="mt-3 max-w-xs text-sm text-text-secondary">
              We sent you a confirmation email. {AI_SALES_REP.name} will reach out shortly.
            </p>
            <Button variant="outline" className="mt-6 w-full" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
