import { create } from 'zustand';

import type { DialerEntityContext } from '@/stores/dialer.store';

/**
 * The same-tab dialer (mobile slice 63).
 *
 * On a phone and in the installed app the dialer is never a new window or tab: it is a full-screen
 * sheet over the page the user is on (`sheet`). Once a call is in progress the sheet collapses to a
 * small call bar that stays on screen while the user moves around the app (`bar`); the call itself
 * lives in the one dialer instance the host keeps mounted, so collapsing never drops it.
 *
 * This store is only the shared switchboard. `lib/communication/phoneTabHandoff.ts` opens it from
 * every Call in the app; `PhoneSheetHost` (mounted once, in the staff layout) reads it; the dialer
 * inside the sheet reports the call's progress back through `reportCall`.
 */
export type PhoneSheetMode = 'closed' | 'sheet' | 'bar';

/** Where the call is, as far as the sheet and the bar are concerned. */
export type CallPhase = 'idle' | 'calling' | 'placed' | 'active' | 'ringing' | 'ended';

export interface CallProgress {
  phase: CallPhase;
  /** The number being called (E.164), once there is one. */
  number: string | null;
}

const IDLE_CALL: CallProgress = { phase: 'idle', number: null };

/** Calling, the user's phone ringing, on the line, or an inbound ring: the call is not over. */
export function isCallInProgress(call: CallProgress): boolean {
  return call.phase === 'calling' || call.phase === 'placed' || call.phase === 'active' || call.phase === 'ringing';
}

interface PhoneSheetState {
  mode: PhoneSheetMode;
  /** The number to put in the dial field; cleared once the dialer has taken it. */
  prefillNumber: string | null;
  /** The record the call is attributed to (job, lead, customer). */
  context: DialerEntityContext | null;
  call: CallProgress;

  /** Show the dialer, pre-filled when a number is given. A call in progress is shown as it is. */
  open: (number?: string, context?: DialerEntityContext | null) => void;
  /** Minimise: a call in progress becomes the call bar; otherwise the dialer closes. */
  collapse: () => void;
  /** The call bar back up to the full sheet. */
  expand: () => void;
  /** Dismiss the dialer and forget the call (the dialer calls this when its call is done). */
  close: () => void;
  consumePrefill: () => void;
  reportCall: (call: CallProgress) => void;
  reset: () => void;
}

const INITIAL = { mode: 'closed' as PhoneSheetMode, prefillNumber: null, context: null, call: IDLE_CALL };

export const usePhoneSheetStore = create<PhoneSheetState>((set, get) => ({
  ...INITIAL,
  open: (number, context) => {
    // A call in progress owns the dialer: re-filling it would reset the live call. Show it instead.
    if (isCallInProgress(get().call)) {
      set({ mode: 'sheet' });
      return;
    }
    set({ mode: 'sheet', prefillNumber: number ?? null, context: context ?? null });
  },
  collapse: () => {
    const { call } = get();
    if (isCallInProgress(call)) set({ mode: 'bar' });
    else set({ ...INITIAL });
  },
  expand: () => set({ mode: 'sheet' }),
  close: () => set({ ...INITIAL }),
  consumePrefill: () => set({ prefillNumber: null }),
  reportCall: (call) => set({ call }),
  reset: () => set({ ...INITIAL }),
}));
