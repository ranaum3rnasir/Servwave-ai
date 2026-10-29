import { create } from 'zustand';

/** Entity context carried with a click-to-call so the placed call gets
 *  attributed (E2): POST /api/communication/calls accepts job_id / lead_id /
 *  customer_id and the CTM webhook stamps them onto the CallSession. Labels
 *  (J/L numbers, customer name) only drive UI copy — ids are the contract. */
export interface DialerEntityContext {
  jobId?: string;
  jobLabel?: string;
  leadId?: string;
  leadLabel?: string;
  customerId?: string;
  customerName?: string;
}

/** Cross-page launcher for the header GlobalDialer (#572). A page sets
 *  pendingNumber (plus optional entity context); the (singleton) GlobalDialer
 *  opens and seeds its softphone dial field, then clears it. Prefill only —
 *  no auto-call (CTM owns calling). */
interface DialerLauncherState {
  pendingNumber: string | null;
  pendingContext: DialerEntityContext | null;
  requestCall: (num: string, ctx?: DialerEntityContext) => void;
  clearPending: () => void;
}

export const useDialerStore = create<DialerLauncherState>((set) => ({
  pendingNumber: null,
  pendingContext: null,
  requestCall: (num, ctx) => set({ pendingNumber: num, pendingContext: ctx ?? null }),
  clearPending: () => set({ pendingNumber: null, pendingContext: null }),
}));
