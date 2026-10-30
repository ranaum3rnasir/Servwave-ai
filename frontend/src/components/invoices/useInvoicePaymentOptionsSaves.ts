import { useCallback, useLayoutEffect, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';
import { extractApiError } from '@/lib/utils';
import type { PaymentMethod } from '@/types/entities';
import { toast } from '@/ui-kit/components/ui/sonner';

export type OverridesBody = {
  payment_methods_override?: PaymentMethod[] | null;
  allow_partial_payment?: boolean | null;
};

/** Choices made on screen that are newer than the invoice's stored value. */
export type OptionsDraft = { methods?: PaymentMethod[]; partial?: boolean };

type Snapshot = { saving: boolean; draft: OptionsDraft | null };

const IDLE: Snapshot = { saving: false, draft: null };

interface Entry {
  snapshot: Snapshot;
  /** Changes made while a save is on its way, merged, sent next. */
  waiting: OverridesBody | null;
  sending: boolean;
  /** The stored value the cards last showed, to tell a refetch that brings a new one. */
  stored: string | undefined;
  listeners: Set<() => void>;
}

/**
 * One queue per invoice, shared by every Payment options card mounted for it (the detail page and
 * its send sheets), so their saves go one at a time in the order they were made and each card
 * shows the same choices.
 */
const entries = new Map<string, Entry>();

function entryFor(invoiceId: string): Entry {
  let entry = entries.get(invoiceId);
  if (!entry) {
    entry = { snapshot: IDLE, waiting: null, sending: false, stored: undefined, listeners: new Set() };
    entries.set(invoiceId, entry);
  }
  return entry;
}

function publish(entry: Entry, next: Partial<Snapshot>) {
  entry.snapshot = { ...entry.snapshot, ...next };
  entry.listeners.forEach((listener) => listener());
}

/** Forgets an invoice once no card shows it and nothing is saving, so a later visit starts fresh. */
function release(invoiceId: string, entry: Entry) {
  if (entries.get(invoiceId) === entry && entry.listeners.size === 0 && !entry.sending) entries.delete(invoiceId);
}

/**
 * The save queue and on-screen choices for one invoice's payment options.
 *
 * `storedKey` identifies the invoice's stored value. A refetch that brings a new one while nothing
 * is saving puts the stored value back on screen; one landing while a save is on its way is only
 * noted, since the screen is newer (F1). After a refused save the stored value is put back once
 * the invoice is read again, because the refetch may bring the very value it started from.
 */
export function useInvoicePaymentOptionsSaves(invoiceId: string, storedKey: string) {
  const queryClient = useQueryClient();

  const subscribe = useCallback((listener: () => void) => {
    const entry = entryFor(invoiceId);
    entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
      release(invoiceId, entry);
    };
  }, [invoiceId]);
  const { saving, draft } = useSyncExternalStore(subscribe, () => entries.get(invoiceId)?.snapshot ?? IDLE);

  useLayoutEffect(() => {
    const entry = entryFor(invoiceId);
    if (entry.stored === storedKey) return;
    const first = entry.stored === undefined;
    entry.stored = storedKey;
    if (!first && !entry.sending) publish(entry, { draft: null });
  }, [invoiceId, storedKey]);

  const save = useCallback((next: OptionsDraft, body: OverridesBody) => {
    const entry = entryFor(invoiceId);
    entry.waiting = { ...entry.waiting, ...body };
    publish(entry, { draft: { ...entry.snapshot.draft, ...next }, saving: true });
    if (entry.sending) return;
    entry.sending = true;
    void (async () => {
      let failed = false;
      while (entry.waiting) {
        const sendNow = entry.waiting;
        entry.waiting = null;
        try {
          await api.patch(`/api/invoices/${invoiceId}`, sendNow);
        } catch (err) {
          failed = true;
          toast.error(extractApiError(err, 'Could not save the payment options'));
        }
      }
      entry.sending = false;
      publish(entry, { saving: false });
      await queryClient.invalidateQueries({ queryKey: ['invoice', invoiceId] });
      if (failed && !entry.sending) publish(entry, { draft: null });
      release(invoiceId, entry);
    })();
  }, [invoiceId, queryClient]);

  return { saving, draft, save };
}
