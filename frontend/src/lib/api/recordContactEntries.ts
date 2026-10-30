import { useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';
import { toast } from '@/components/ui/use-toast';

/**
 * Roles & Permissions, PRD 5: a job's or a lead's own phones, emails, name and company, added or replacing a
 * customer's with the pencil on the customer block.
 *
 * An entry belongs to the job or the lead and never reaches the customer record; the office review decides that. The
 * job and lead detail carry the live entries as `contact_entries`; the write answers with the live entries after it,
 * which these hooks put straight into the cached record so the new line shows at once. Correcting and removing an
 * entry (S05.9) answer the same way, and are open to anyone who holds the pencil for that kind of value, whoever
 * added the entry.
 */
export interface RecordContactEntry {
  id: string;
  kind: 'PHONE' | 'EMAIL' | 'FIRST_NAME' | 'LAST_NAME' | 'COMPANY_NAME';
  intent: 'ADDED' | 'CHANGED';
  value: string;
  extension: string | null;
  label: string | null;
  overridden_field: string | null;
  overridden_row_id: string | null;
  customer_value_at_change: string | null;
  created_by: { id: string | null; name: string | null };
  created_at: string;
  updated_by: { id: string | null; name: string | null };
  updated_at: string;
  source_entry_id: string | null;
}

export type NewContactEntry =
  | { kind: 'PHONE'; value: string; extension?: string; label?: string }
  | { kind: 'EMAIL'; value: string; label?: string };

/** A customer's phone or email replaced on this record: `replaces` is the customer's value being replaced. */
export type ContactEntryChange =
  | { kind: 'PHONE'; replaces: string; value: string; extension?: string; label?: string }
  | { kind: 'EMAIL'; replaces: string; value: string; label?: string };

/** A correction: any of the entry's value, extension or label; an empty extension or label clears it. */
export interface ContactEntryCorrection {
  id: string;
  value?: string;
  extension?: string;
  label?: string;
}

/** The record the entries belong to: the job or the lead whose page holds the block. */
export type ContactRecordRef = { kind: 'job' | 'lead'; id: string };

/** What the person is told a save did, naming the record ("Saved on this job only"). */
export const savedOnRecord = (kind: ContactRecordRef['kind']) => `Saved on this ${kind} only`;
export const removedFromRecord = (kind: ContactRecordRef['kind']) => `Removed from this ${kind}`;

/** What a pencil form says about where its change lands: a job's is read at the office review, a lead's stays on the lead. */
export const recordOnlyNote = (kind: ContactRecordRef['kind']) =>
  kind === 'lead' ? 'This changes the lead only.' : 'This changes the job only. The office decides at review whether the customer record changes too.';

const entriesPath = ({ kind, id }: ContactRecordRef) => `/api/${kind}s/${id}/contact-entries`;

/** The plain sentence a refused save carries: the first field message when the server names one, else its error. */
export function contactEntryErrorMessage(err: unknown): string {
  const data = (err as { response?: { data?: { error?: string; details?: { message?: string }[] } } })?.response?.data;
  return data?.details?.find((d) => d.message)?.message ?? data?.error ?? "Couldn't save this. Try again in a moment.";
}

/** The writes answer with the record's live entries: they go straight into the cached record so the line shows at once. */
function useCacheEntries(record: ContactRecordRef) {
  const queryClient = useQueryClient();
  return (entries: RecordContactEntry[]) => {
    queryClient.setQueryData<Record<string, unknown> | undefined>([record.kind, record.id], (cached) =>
      cached ? { ...cached, contact_entries: entries } : cached,
    );
    // Each write is one entry on the record's history; the readers of its timeline pick it up.
    queryClient.invalidateQueries({ queryKey: [`${record.kind}-timeline`, record.id] });
    queryClient.invalidateQueries({ queryKey: ['timeline', record.kind.toUpperCase(), record.id] });
  };
}

function useEntriesSaved(record: ContactRecordRef, title = savedOnRecord(record.kind)) {
  const cache = useCacheEntries(record);
  return (entries: RecordContactEntry[]) => {
    cache(entries);
    toast({ title });
  };
}

export function useAddContactEntry(record: ContactRecordRef) {
  const saved = useEntriesSaved(record);
  return useMutation({
    mutationFn: async (entry: NewContactEntry) => {
      const { data } = await api.post(entriesPath(record), entry);
      return data.entries as RecordContactEntry[];
    },
    onSuccess: saved,
  });
}

export function useChangeContactEntry(record: ContactRecordRef) {
  const saved = useEntriesSaved(record);
  return useMutation({
    mutationFn: async (change: ContactEntryChange) => {
      const { data } = await api.post(`${entriesPath(record)}/change`, change);
      return data.entries as RecordContactEntry[];
    },
    onSuccess: saved,
  });
}

export function useCorrectContactEntry(record: ContactRecordRef) {
  const saved = useEntriesSaved(record);
  return useMutation({
    mutationFn: async ({ id, ...correction }: ContactEntryCorrection) => {
      const { data } = await api.patch(`${entriesPath(record)}/${id}`, correction);
      return data.entries as RecordContactEntry[];
    },
    onSuccess: saved,
  });
}

/** Removing an entry sets it aside for the history; a removed change leaves the customer's own value on the record. */
export function useRemoveContactEntry(record: ContactRecordRef) {
  const saved = useEntriesSaved(record, removedFromRecord(record.kind));
  return useMutation({
    mutationFn: async (id: string) => {
      const { data } = await api.delete(`${entriesPath(record)}/${id}`);
      return data.entries as RecordContactEntry[];
    },
    onSuccess: saved,
  });
}

/** What the name form can ask for on the record, one request each, in the order given. */
export type NameChange =
  /** A name or company the record has not changed yet: the entry is made, the customer record stays. */
  | { op: 'change'; kind: 'FIRST_NAME' | 'LAST_NAME' | 'COMPANY_NAME'; value: string }
  /** The record's own name entry corrected. */
  | { op: 'correct'; id: string; value: string }
  /** The record's own name entry set aside: the customer's name stands again. */
  | { op: 'remove'; id: string };

/**
 * The name pencil's form (Edit jobs / Edit leads): the first name, last name or company name changed for this record only. The form may
 * change two parts at once, so the requests run one after another and the person gets one confirmation. A request that
 * fails stops the rest; what was saved before it stays saved and shows.
 */
export function useSaveNameChanges(record: ContactRecordRef) {
  const cache = useCacheEntries(record);
  return useMutation({
    mutationFn: async (changes: NameChange[]) => {
      let latest: RecordContactEntry[] | null = null;
      try {
        for (const change of changes) {
          const { data } =
            change.op === 'change'
              ? await api.post(`${entriesPath(record)}/name`, { kind: change.kind, value: change.value })
              : change.op === 'correct'
                ? await api.patch(`${entriesPath(record)}/${change.id}`, { value: change.value })
                : await api.delete(`${entriesPath(record)}/${change.id}`);
          latest = data.entries as RecordContactEntry[];
        }
      } catch (err) {
        if (latest) cache(latest);
        throw err;
      }
      return { entries: latest, removedOnly: changes.every((c) => c.op === 'remove') };
    },
    onSuccess: ({ entries, removedOnly }) => {
      if (!entries) return;
      cache(entries);
      toast({ title: removedOnly ? removedFromRecord(record.kind) : savedOnRecord(record.kind) });
    },
  });
}
