import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { formatInstant, useScheduleTimezone } from '@/lib/schedule-tz';
import { Button } from '@/ui-kit/components/ui/button';
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/ui-kit/components/ui/dialog';
import { DialogList } from '@/ui-kit/components/ui/dialogList';
import { Input } from '@/ui-kit/components/ui/input';
import { Skeleton } from '@/ui-kit/components/ui/skeleton';

import { LoadError } from '../../_shared/loadError';
import { formatSize } from './evidenceFormat';
import { fetchInvoiceFiles, invoiceFilesKey, isEvidenceMime, type InvoiceFileItem } from './invoiceFiles';

const DAY: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' };
const SEARCH_AFTER = 10;

/**
 * The invoice's own files, to attach one to a row of the evidence form. Only PDF, JPG and PNG are listed. Searching
 * appears once the list is long enough to need it. A file already used in another row is shown but cannot be picked.
 * It mounts fresh on every open, so a search never carries over.
 */
export function InvoiceFilePicker({
  open, onOpenChange, invoiceId, usedIn, onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invoiceId: string;
  /** attachment id -> the label of the row that already holds it. */
  usedIn: Record<string, string>;
  onPick: (file: InvoiceFileItem) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent intent="form" className="sm:max-w-lg">
        {open && <PickerBody invoiceId={invoiceId} usedIn={usedIn} onPick={onPick} onCancel={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function PickerBody({
  invoiceId, usedIn, onPick, onCancel,
}: {
  invoiceId: string;
  usedIn: Record<string, string>;
  onPick: (file: InvoiceFileItem) => void;
  onCancel: () => void;
}) {
  const timeZone = useScheduleTimezone();
  const query = useQuery({ queryKey: invoiceFilesKey(invoiceId), queryFn: () => fetchInvoiceFiles(invoiceId), staleTime: 0 });
  const [search, setSearch] = useState('');
  const usable = useMemo(() => (query.data ?? []).filter((f) => isEvidenceMime(f.file_type)), [query.data]);
  const needle = search.trim().toLowerCase();
  const shown = needle
    ? usable.filter((f) => `${f.display_name} ${f.file_name}`.toLowerCase().includes(needle))
    : usable;

  return (
    <>
      <DialogHeader>
        <DialogTitle>Choose from invoice files</DialogTitle>
        <DialogDescription className="sr-only">Pick a file already attached to this invoice</DialogDescription>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-3">
        {query.isError ? (
          <LoadError title="Couldn’t load the invoice files." onRetry={() => void query.refetch()} retrying={query.isFetching} />
        ) : query.isPending ? (
          <div className="flex flex-col gap-2"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>
        ) : usable.length === 0 ? (
          <p className="py-4 text-sm text-text-secondary">No PDF, JPG or PNG files on this invoice yet.</p>
        ) : (
          <>
            {usable.length > SEARCH_AFTER && (
              <Input
                kind="search"
                aria-label="Search files"
                placeholder="Search files"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            )}
            {shown.length === 0 ? (
              <p className="py-4 text-sm text-text-secondary">No files match.</p>
            ) : (
              <DialogList as="ul" cap="max-h-[50dvh] overflow-y-auto overscroll-contain" className="flex flex-col gap-1">
                {shown.map((f) => {
                  const used = usedIn[f.id];
                  const who = f.uploader ? `${f.uploader.first_name} ${f.uploader.last_name}`.trim() : '';
                  return (
                    <li key={f.id}>
                      <Button
                        type="button"
                        variant="outline"
                        disabled={Boolean(used)}
                        onClick={() => onPick(f)}
                        className="h-auto min-h-11 w-full flex-col items-start justify-start gap-0.5 whitespace-normal px-3 py-2 text-left shadow-none"
                      >
                        <span className="break-all text-sm font-medium">{f.file_name}</span>
                        <span className="text-xs text-text-secondary">
                          {[formatSize(f.file_size), formatInstant(f.created_at, timeZone, DAY), who].filter(Boolean).join(' · ')}
                        </span>
                        {used && <span className="text-xs font-medium text-text-secondary">Used in {used}</span>}
                      </Button>
                    </li>
                  );
                })}
              </DialogList>
            )}
          </>
        )}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="ghost" className="max-sm:h-11 touch:h-11" onClick={onCancel}>Cancel</Button>
      </DialogFooter>
    </>
  );
}
