import { useEffect, useRef, useState } from 'react';
import { Clock, MapPin, Lock, Loader2, Square, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  useIsClockedIn,
  useRecordPunch,
  type OverrideVerdict,
  type RequiresOverrideBody,
} from '@/lib/api/timeclock';

/**
 * The geofenced clock in/out flow, rendered INLINE inside the header user
 * dropdown (placement "Option A"). Status is server-derived via useIsClockedIn;
 * a transient local `phase` drives the GPS-acquire / out-of-zone / confirm steps.
 *
 * This is plain content (not a DropdownMenuItem) so clicking its buttons doesn't
 * close the menu mid-flow. If the menu does close (e.g. the browser's location
 * prompt steals focus), the punch still records — status re-derives on refetch.
 */

type Phase = 'idle' | 'acquiring' | 'denied' | 'out_of_zone' | 'error' | 'confirm_out';
type Coords = { lat: number; lng: number; accuracy_m?: number };

function fmtDistance(m: number): string {
  if (!isFinite(m)) return '—';
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${h}:${m}:${ss}`;
}

function getPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('unavailable'));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 0,
    });
  });
}

/** Live HH:MM:SS since `sinceTs`, ticking each second while mounted. */
function useElapsed(sinceTs: number | null): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (sinceTs == null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [sinceTs]);
  return sinceTs == null ? '00:00:00' : fmtElapsed(now - sinceTs);
}

export function ClockInOutMenu() {
  const { isClockedIn, sinceTs, zoneLabel } = useIsClockedIn();
  const recordPunch = useRecordPunch();
  const elapsed = useElapsed(sinceTs);

  const [phase, setPhase] = useState<Phase>('idle');
  const [verdict, setVerdict] = useState<OverrideVerdict | null>(null);
  const [lastPos, setLastPos] = useState<Coords | null>(null);
  // Guards a double-click recording two INs; cleared when the flow resolves.
  const submitting = useRef(false);

  const submitIn = async (here: Coords, override: boolean) => {
    if (submitting.current) return;
    submitting.current = true;
    try {
      await recordPunch.mutateAsync({
        type: 'IN',
        lat: here.lat,
        lng: here.lng,
        accuracy_m: here.accuracy_m,
        override,
      });
      // Success → server flips isClockedIn on refetch; drop back to the resting view.
      submitting.current = false;
      setPhase('idle');
      setVerdict(null);
    } catch (err) {
      submitting.current = false;
      const e = err as { response?: { status?: number; data?: RequiresOverrideBody } };
      const status = e.response?.status;
      if (status === 422) {
        setVerdict(e.response?.data?.verdict ?? null);
        setPhase('out_of_zone');
      } else if (status === 409) {
        // Already clocked in on the server — reconcile to the resting view.
        setPhase('idle');
      } else {
        setPhase('error');
      }
    }
  };

  const acquire = async () => {
    if (phase === 'acquiring') return;
    setPhase('acquiring');
    setVerdict(null);
    try {
      const pos = await getPosition();
      const here: Coords = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy_m: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : undefined,
      };
      setLastPos(here);
      await submitIn(here, false);
    } catch {
      setPhase('denied');
    }
  };

  const requestOverride = async () => {
    if (lastPos) await submitIn(lastPos, true);
  };

  const clockOut = async () => {
    // OUT is never blocked — best-effort geolocation, fall back to last known.
    let here: Coords | null = lastPos;
    try {
      const pos = await getPosition();
      here = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy_m: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : undefined,
      };
    } catch {
      /* OUT is never blocked — fall back to last known position (or 0,0). */
    }
    const coords = here ?? { lat: 0, lng: 0 };
    try {
      await recordPunch.mutateAsync({
        type: 'OUT',
        lat: coords.lat,
        lng: coords.lng,
        accuracy_m: coords.accuracy_m,
      });
    } catch {
      /* useRecordPunch toasts on real failures; status refreshes on next fetch. */
    }
    submitting.current = false;
    setPhase('idle');
    setVerdict(null);
  };

  // ── Transient flow states (take precedence over the server-derived view) ──
  if (phase === 'acquiring') {
    return (
      <div className="flex items-center gap-2 px-3 py-3 text-sm text-text-secondary">
        <Loader2 className="h-4 w-4 animate-spin" /> Getting your location…
      </div>
    );
  }

  if (phase === 'denied') {
    return (
      <div className="space-y-2 px-3 py-3">
        <div className="flex items-center gap-2 text-sm font-medium text-danger">
          <Lock className="h-4 w-4" /> Turn on location to clock in
        </div>
        <p className="text-xs text-text-secondary">
          Location access is off or was denied. Enable it in your browser, then try again.
        </p>
        <Button variant="outline" size="sm" className="w-full" onClick={() => void acquire()}>
          Try again
        </Button>
      </div>
    );
  }

  if (phase === 'out_of_zone') {
    return (
      <div className="space-y-2 px-3 py-3">
        <div className="flex items-center gap-2 text-sm font-medium text-warning">
          <MapPin className="h-4 w-4" /> You&apos;re {fmtDistance(verdict?.distanceM ?? Infinity)} from{' '}
          {verdict?.nearest?.label ?? 'any valid spot'}
        </div>
        <p className="text-xs text-text-secondary">
          Move closer to clock in, or request a manager override.
        </p>
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          onClick={() => void requestOverride()}
          disabled={recordPunch.isPending}
        >
          Request manager override
        </Button>
      </div>
    );
  }

  if (phase === 'error') {
    return (
      <div className="space-y-2 px-3 py-3">
        <div className="flex items-center gap-2 text-sm font-medium text-danger">
          <Lock className="h-4 w-4" /> Couldn&apos;t clock in
        </div>
        <p className="text-xs text-text-secondary">Something went wrong. Please try again.</p>
        <Button variant="outline" size="sm" className="w-full" onClick={() => void acquire()}>
          Try again
        </Button>
      </div>
    );
  }

  // ── Resting view: derived from the server ──
  if (isClockedIn) {
    return (
      <div className="space-y-2.5 px-3 py-3">
        <div className="rounded-lg border border-sage-200 bg-sage-50 px-3 py-2">
          <div className="flex items-center gap-2 text-sm font-semibold text-sage-700">
            <span className="h-2 w-2 animate-pulse rounded-full bg-sage-500" />
            On the clock · <span className="font-mono tabular-nums">{elapsed}</span>
          </div>
          {zoneLabel && <div className="mt-0.5 text-[11px] text-sage-700/80">{zoneLabel}</div>}
        </div>
        {phase === 'confirm_out' ? (
          <div className="space-y-2">
            <p className="text-xs text-text-secondary">End your shift after {elapsed}?</p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="flex-1"
                onClick={() => setPhase('idle')}
                disabled={recordPunch.isPending}
              >
                Cancel
              </Button>
              <Button
                variant="solid" tone="danger"
                size="sm"
                className="flex-1"
                onClick={() => void clockOut()}
                disabled={recordPunch.isPending}
              >
                Clock Out
              </Button>
            </div>
          </div>
        ) : (
          <Button
            variant="solid" tone="danger"
            size="sm"
            className="w-full"
            onClick={() => setPhase('confirm_out')}
          >
            <Square className="mr-2 h-4 w-4" /> Clock Out
          </Button>
        )}
      </div>
    );
  }

  // Clocked out
  return (
    <div className="space-y-2 px-3 py-3">
      <div className="flex items-center gap-2 text-xs text-text-secondary">
        <Clock className="h-4 w-4" /> You&apos;re clocked out
      </div>
      <Button
        size="sm"
        className="w-full"
        onClick={() => void acquire()}
        disabled={recordPunch.isPending}
      >
        <Play className="mr-2 h-4 w-4" /> Clock In
      </Button>
      <p className="text-[11px] text-text-secondary">Checks the store and your job sites.</p>
    </div>
  );
}

export default ClockInOutMenu;
