/**
 * The line between the new-invoice tab and the Payments tab it was opened from (V7-09, spec 7.17).
 *
 * "Create invoice" on an unapplied payment opens `/invoices/new` in a second browser tab. When that tab saves, the
 * payment is already on the new invoice, so the first tab (Payments) must refresh its card, table and tiles on its own.
 * Both pages share the channel name and the message shape from here, so neither can drift from the other.
 *
 * A browser with no `BroadcastChannel` gets a quiet no-op; the Payments page covers that case with a window-focus refetch.
 */
export const PAYMENTS_CHANNEL = 'servwave-payments';

export interface AttachedMessage {
  /** The number of the invoice that now carries the payment. */
  invoice_number: string;
  /** Dollars recorded on it. */
  amount: number;
}

type Wire = AttachedMessage & { type: 'unapplied-attached' };

const supported = () => typeof BroadcastChannel !== 'undefined';

/** False in a browser with no BroadcastChannel: the Payments page then needs its own fallback. */
export const channelAvailable = supported;

/** What an invoice number looks like on the wire: letters, digits and dashes, no spaces, at most 32 characters. */
const INVOICE_NUMBER = /^[A-Za-z0-9][A-Za-z0-9-]{0,31}$/;

function isAttached(data: unknown): data is Wire {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  return d.type === 'unapplied-attached'
    && typeof d.invoice_number === 'string' && INVOICE_NUMBER.test(d.invoice_number)
    && typeof d.amount === 'number' && Number.isFinite(d.amount) && d.amount > 0;
}

/** Tell every other tab that a payment was just recorded on a new invoice. */
export function postAttached(message: AttachedMessage): void {
  if (!supported()) return;
  try {
    const channel = new BroadcastChannel(PAYMENTS_CHANNEL);
    channel.postMessage({ type: 'unapplied-attached', ...message } satisfies Wire);
    channel.close();
  } catch {
    // The invoice is saved either way; the other tab still refreshes when it regains focus.
  }
}

/** Listen for {@link postAttached} from other tabs. Returns the function that stops listening and closes the channel. */
export function subscribe(onAttached: (message: AttachedMessage) => void): () => void {
  if (!supported()) return () => {};
  const channel = new BroadcastChannel(PAYMENTS_CHANNEL);
  channel.onmessage = (event: MessageEvent) => {
    if (isAttached(event.data)) onAttached({ invoice_number: event.data.invoice_number, amount: event.data.amount });
  };
  return () => channel.close();
}
