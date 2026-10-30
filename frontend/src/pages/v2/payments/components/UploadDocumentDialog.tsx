import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';

import {
  paymentsPageKeys, useDocumentTargets, type DocumentTarget, type DocumentTargetKind,
} from '@/lib/api/paymentsPage';
import { uploadAttachment } from '@/lib/attachments/uploadAttachment';
import { formatInstant, useScheduleTimezone } from '@/lib/schedule-tz';
import {
  ACCEPTED_UPLOAD_TYPES, oversizeRefusalMessage, unsupportedTypeRefusalMessage,
} from '@/lib/uploadTypes';
import { extractApiError, formatCurrency } from '@/lib/utils';
import { Button } from '@/ui-kit/components/ui/button';
import {
  Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/ui-kit/components/ui/dialog';
import { DialogList } from '@/ui-kit/components/ui/dialogList';
import { Input } from '@/ui-kit/components/ui/input';
import { Label } from '@/ui-kit/components/ui/label';
import { toast } from '@/ui-kit/components/ui/sonner';
import { useDebounce } from '@/ui-kit/hooks/useDebounce';
import { useReturnFocus } from '@/ui-kit/hooks/useReturnFocus';

import { RadioRow, onRadioGroupKeyDown } from '../../_shared/radioRow';
import { Segment, SegmentedGroup } from '../../_shared/segmented';
import { PHONE_TAP_AREA } from '../phoneTap';

const KINDS: Array<{ value: DocumentTargetKind; label: string }> = [
  { value: 'invoice', label: 'Invoice' },
  { value: 'job', label: 'Job' },
  { value: 'customer', label: 'Customer' },
];

const DUE_DAY: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };

/** The number or name the toast and the table both show: "INV-1302 · Dana Whitfield" is "INV-1302". */
const labelOf = (kind: DocumentTargetKind, target: DocumentTarget) =>
  kind === 'customer' ? target.main : target.main.split(' · ')[0]!;

type UploadDocumentDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after the file is stored and attached (the tab goes back to page 1). */
  onUploaded?: () => void;
};

/** The form mounts fresh on every open, so the file, the choice, the search and any error never carry over. */
export function UploadDocumentDialog(props: UploadDocumentDialogProps) {
  // The dialog stays mounted while closed so the library can hand focus back to the button that opened it; a fresh
  // form (new key) is made on each open instead.
  const [generation, setGeneration] = useState(0);
  const [wasOpen, setWasOpen] = useState(props.open);
  if (props.open !== wasOpen) {
    setWasOpen(props.open);
    if (props.open) setGeneration((g) => g + 1);
  }
  return <UploadDocumentForm key={generation} {...props} />;
}

function UploadDocumentForm({ open, onOpenChange, onUploaded }: UploadDocumentDialogProps) {
  const queryClient = useQueryClient();
  const timeZone = useScheduleTimezone();
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [kind, setKind] = useState<DocumentTargetKind>('invoice');
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<DocumentTarget | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  // A second press while the first is on its way would attach the file twice; the ref closes the gap before React re-renders.
  const sending = useRef(false);
  // Radix hands focus back only to a Trigger; this dialog opens from state, so the opener is remembered here.
  const returnFocus = useReturnFocus();
  const errorRef = useRef<HTMLParagraphElement>(null);
  // An error sits above the (long) list and takes focus, so it is seen and read out even on a phone.
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);

  const q = useDebounce(search.trim(), 250);
  const targets = useDocumentTargets(kind, q);

  const chooseKind = (next: DocumentTargetKind) => {
    if (next === kind) return;
    setKind(next);
    setPicked(null);
    setSearch('');
    setError(null);
  };

  const chooseFile = (chosen: File | undefined) => {
    if (!chosen) return;
    const refusal = unsupportedTypeRefusalMessage(chosen) ?? oversizeRefusalMessage(chosen);
    setError(null);
    if (refusal) {
      setFile(null);
      setFileError(refusal);
      return;
    }
    setFile(chosen);
    setFileError(null);
  };

  const describe = (t: DocumentTarget): string | null => {
    if (kind !== 'invoice') return t.sub;
    const parts: string[] = [];
    if (typeof t.amount === 'number') parts.push(formatCurrency(t.amount));
    if (t.due_date) parts.push(`due ${formatInstant(t.due_date, timeZone, DUE_DAY)}`);
    return parts.join(', ') || null;
  };

  const submit = async () => {
    if (sending.current) return;
    if (!file) { setError('Choose a file first.'); return; }
    if (!picked) { setError('Choose what to attach it to.'); return; }
    setError(null);
    sending.current = true;
    setUploading(true);
    try {
      await uploadAttachment({ entityType: kind, entityId: picked.id, file, source: 'PAYMENTS_DOCUMENTS' });
    } catch (err) {
      setError(extractApiError(err, 'Could not upload this file. Please try again.'));
      sending.current = false;
      setUploading(false);
      return;
    }
    toast.success(`Uploaded ${file.name} and attached it to ${kind} ${labelOf(kind, picked)}`);
    await queryClient.invalidateQueries({ queryKey: [...paymentsPageKeys.all, 'documents'] });
    onUploaded?.();
    onOpenChange(false);
  };

  const rows = targets.data ?? [];

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!uploading) onOpenChange(next); }}>
      <DialogContent intent="choice" onCloseAutoFocus={returnFocus} className={`sm:max-w-md ${PHONE_TAP_AREA}`}>
        <DialogHeader>
          <DialogTitle>Upload document</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="upload-document-file">File</Label>
            <input
              ref={fileInput}
              id="upload-document-file"
              type="file"
              className="sr-only"
              tabIndex={-1}
              accept={ACCEPTED_UPLOAD_TYPES}
              onChange={(e) => { chooseFile(e.target.files?.[0]); e.target.value = ''; }}
            />
            <div>
              <Button type="button" variant="outline" onClick={() => fileInput.current?.click()}>
                <Plus aria-hidden />
                Choose file
              </Button>
            </div>
            <p className="text-muted-foreground text-[13px]" aria-live="polite">{file ? file.name : 'No file chosen'}</p>
            {fileError && <p role="alert" className="text-destructive text-[13px] font-medium">{fileError}</p>}
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Attach to</span>
            <SegmentedGroup aria-label="Attach to" className="w-fit">
              {KINDS.map((k) => (
                <Segment key={k.value} active={kind === k.value} onClick={() => chooseKind(k.value)} className="max-sm:min-h-11">
                  {k.label}
                </Segment>
              ))}
            </SegmentedGroup>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="upload-document-find">Find</Label>
            <Input
              id="upload-document-find"
              kind="search"
              placeholder="Number or name"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              // Enter searches; it must never press the dialog's primary button by accident.
              onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }}
            />
            {error && <p ref={errorRef} role="alert" tabIndex={-1} className="text-destructive text-[13px] font-medium outline-none">{error}</p>}
            {targets.isError ? (
              <div role="alert" className="flex items-center gap-3 p-3 text-sm">
                <span>Couldn’t search.</span>
                <Button type="button" variant="outline" size="sm" onClick={() => void targets.refetch()}>Retry</Button>
              </div>
            ) : (
            <DialogList
              cap="max-h-[260px] overflow-y-auto"
              role="radiogroup"
              aria-label="Attach to"
              onKeyDown={onRadioGroupKeyDown}
              className="flex flex-col"
            >
              {rows.length === 0 && !targets.isPending ? (
                <p className="text-muted-foreground p-3 text-sm">Nothing matches</p>
              ) : (
                rows.map((t, i) => (
                  <RadioRow
                    key={t.id}
                    checked={picked?.id === t.id}
                    tabIndex={picked ? (picked.id === t.id ? 0 : -1) : (i === 0 ? 0 : -1)}
                    onClick={() => { setPicked(t); setError(null); }}
                    label={t.main}
                    description={describe(t)}
                    className="min-h-11 py-1.5"
                  />
                ))
              )}
            </DialogList>
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={uploading}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void submit()} isLoading={uploading}>
            Upload and attach
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
