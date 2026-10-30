import type { ColumnDef } from '@tanstack/react-table';
import { Download } from 'lucide-react';

import type { DocumentRow } from '@/lib/api/paymentsPage';
import { formatInstant } from '@/lib/schedule-tz';
import { Button } from '@/ui-kit/components/ui/button';

import { AttachedTo } from './AttachedTo';

const SHORT_DATE: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' };

/**
 * The Documents tab's columns (payments go-live v7): Document, Type, Attached to, Date and a Download button. The
 * button is absent when the server withheld the link (a file on a record the viewer cannot open).
 */
export function buildDocumentColumns({
  timeZone, onDownload,
}: {
  timeZone: string;
  onDownload: (row: DocumentRow) => void;
}): ColumnDef<DocumentRow>[] {
  return [
    { id: 'document', header: 'Document', meta: { label: 'Document' }, size: 300, cell: ({ row }) => <span className="break-words">{row.original.name}</span> },
    { id: 'type', header: 'Type', meta: { label: 'Type' }, size: 110, cell: ({ row }) => row.original.type },
    { id: 'attached', header: 'Attached to', meta: { label: 'Attached to' }, size: 240, cell: ({ row }) => <AttachedTo to={row.original.attached_to} /> },
    { id: 'date', header: 'Date', meta: { label: 'Date' }, size: 130, cell: ({ row }) => formatInstant(row.original.date, timeZone, SHORT_DATE) },
    {
      id: 'download',
      header: () => <span className="sr-only">Download</span>,
      meta: { label: 'Download' },
      size: 130,
      cell: ({ row }) =>
        row.original.download_url ? (
          <div className="flex justify-end">
            <Button type="button" variant="outline" size="sm" aria-label={`Download ${row.original.name}`} onClick={() => onDownload(row.original)}>
              <Download aria-hidden />
              Download
            </Button>
          </div>
        ) : null,
    },
  ];
}
