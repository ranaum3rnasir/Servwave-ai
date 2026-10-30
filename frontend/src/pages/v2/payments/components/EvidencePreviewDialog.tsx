import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

import { fetchDisputeEvidenceFile, useDisputeEvidenceFile } from '@/lib/api/paymentsPage';
import { downloadAttachment } from '@/lib/attachments/downloadAttachment';
import { Button } from '@/ui-kit/components/ui/button';
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/ui-kit/components/ui/dialog';
import { Skeleton } from '@/ui-kit/components/ui/skeleton';

import { LoadError } from '../../_shared/loadError';
import { PHONE_TAP_AREA } from '../phoneTap';
import { formatSize } from './evidenceFormat';

/** What the list already knows about a file, so the label reads before its link has loaded. */
export interface PreviewFile {
  attachment_id: string;
  file_name: string;
  mime: string;
  size_bytes: number | null;
}

interface Props {
  disputeId: string;
  files: PreviewFile[];
  /** The file that was clicked. The dialog is mounted per open, so this is where it starts every time. */
  start: number;
  onClose: () => void;
  /** Where focus goes when the preview closes: the row that opened it. */
  returnFocusTo?: { current: HTMLElement | null };
}

/**
 * One evidence file at a time, with Previous / Next through the dispute's files. Only the file on screen asks for its
 * link (good for an hour), and Download saves the file instead of opening it.
 */
export function EvidencePreviewDialog({ disputeId, files, start, onClose, returnFocusTo }: Props) {
  const [index, setIndex] = useState(Math.min(Math.max(start, 0), files.length - 1));
  const [downloading, setDownloading] = useState(false);
  const file = files[index]!;
  const link = useDisputeEvidenceFile(disputeId, file.attachment_id);
  const isPdf = file.mime === 'application/pdf';
  const size = file.size_bytes != null ? `, ${formatSize(file.size_bytes)}` : '';

  const download = async () => {
    if (!link.data || downloading) return;
    setDownloading(true);
    try {
      await downloadAttachment(
        { id: file.attachment_id, file_url: link.data.url, file_name: file.file_name, display_name: file.file_name },
        { refresh: () => fetchDisputeEvidenceFile(disputeId, file.attachment_id).then((r) => r.url).catch(() => null) },
      );
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        intent="choice"
        showClose={false}
        className={`${PHONE_TAP_AREA} max-w-[680px]`}
        onCloseAutoFocus={(event) => {
          const target = returnFocusTo?.current;
          if (target?.isConnected) {
            event.preventDefault();
            target.focus();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle className="[overflow-wrap:anywhere]">{file.file_name}</DialogTitle>
          <DialogDescription className="sr-only">{`Preview of ${file.file_name}`}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="bg-muted grid min-h-48 place-items-center rounded-[10px] p-3">
            {link.isError ? (
              <LoadError title="Couldn’t open this file." onRetry={() => void link.refetch()} retrying={link.isFetching} />
            ) : !link.data ? (
              <Skeleton className="h-48 w-full" />
            ) : isPdf ? (
              <object data={link.data.url} type="application/pdf" tabIndex={-1} aria-label={file.file_name} className="h-[52vh] w-full">
                <p className="text-sm">This file can’t be shown here. Use Download to open it.</p>
              </object>
            ) : (
              <img src={link.data.url} alt={file.file_name} className="block h-auto max-h-[52vh] w-full object-contain" />
            )}
          </div>
          <div className="text-text-secondary mt-3 flex items-center justify-between gap-2 text-[13px]">
            <Button type="button" variant="outline" size="sm" disabled={index === 0} onClick={() => setIndex(index - 1)}>
              <ChevronLeft aria-hidden />
              Previous
            </Button>
            <span className="text-center tabular-nums">{`${isPdf ? 'PDF' : 'Image'}${size} · ${index + 1} of ${files.length}`}</span>
            <Button type="button" variant="outline" size="sm" disabled={index === files.length - 1} onClick={() => setIndex(index + 1)}>
              Next
              <ChevronRight aria-hidden />
            </Button>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button type="button" isLoading={downloading} disabled={!link.data} onClick={() => void download()}>Download</Button>
          <Button type="button" variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
