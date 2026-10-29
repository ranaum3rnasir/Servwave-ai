import { Phone } from 'lucide-react';
import { openPhoneTab } from '@/lib/communication/phoneTabHandoff';

/* ───────────────────────── Global dialer ─────────────────────────
 * Header entry point: a phone button that opens the dedicated `/phone`
 * pop-out tab — the ONE softphone device owner (Task A3) — instead of the
 * old in-app overlay popup. It shares the singleton `servwave-phone` tab with
 * every entity "Call" button (phoneTabHandoff), so the header button, a call
 * from a Job, and a call from a Customer all land on the same live phone tab.
 * The full search + softphone + right-panel workspace lives inside that
 * tab (PhoneTabPage → DialerWorkspace), not here.
 *
 * This is its own module (mobile slice 61) because the staff layout imports it into the first
 * download, and the file it used to live in (Dialer.tsx) brings the whole softphone workspace,
 * the call-control SDK wrapper, the inventory API and the date picker with it. Dialer.tsx
 * re-exports this, so every existing import keeps working. Keep this file free of those. */
export function GlobalDialer() {
  return (
    <button
      type="button"
      onClick={() => openPhoneTab()}
      aria-label="Open dialer"
      title="Dialer - open the phone"
      className="rounded-md p-2 text-text-secondary transition hover:bg-background-light hover:text-primary"
    >
      <Phone className="h-4 w-4" />
    </button>
  );
}
