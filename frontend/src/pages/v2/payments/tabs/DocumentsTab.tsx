import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ConnectComponentsProvider, ConnectDocuments } from '@stripe/react-connect-js';
import { FileText, Upload } from 'lucide-react';

import { useAppAbility } from '@/contexts/AbilityContext';
import { useStripeStatus } from '@/lib/api/organization';
import { fetchDocumentsPage, paymentsPageKeys, useDocuments, type DocumentRow } from '@/lib/api/paymentsPage';
import { downloadAttachment } from '@/lib/attachments/downloadAttachment';
import { discardViewerConnect, getViewerConnect, onSessionRequestFailed, onSessionRequestSucceeded } from '@/lib/payments/payout-connect';
import { useScheduleTimezone } from '@/lib/schedule-tz';
import { useAuthStore } from '@/stores/auth.store';
import { Button } from '@/ui-kit/components/ui/button';
import { DataTable } from '@/ui-kit/components/data/dataTable/dataTable';
import { EmptyState } from '@/ui-kit/components/data/emptyState';

import { LoadError } from '../../_shared/loadError';
import { buildDocumentColumns } from '../components/documentsColumns';
import { UploadDocumentDialog } from '../components/UploadDocumentDialog';
import type { PaymentsTabProps } from '../types';

/** The stored file name ends the signed link's path, and it is where the saved file gets its extension from. */
const storedNameOf = (url: string): string => {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
  } catch {
    return '';
  }
};

/**
 * The Documents tab (payments go-live v7): the files the team uploaded, newest first, each with a Download button and a
 * link to the record it hangs on, and an "Upload document" button. Under the list, in the same card, sits the payment
 * processor's own Documents box (tax forms and statements): ServWave keeps no copy of those, so it has no rows here.
 * The period picker does not filter either part.
 *
 * The box runs on the VIEWER session (the server enables exactly that set and checks "View payments and payouts"). A
 * refused or failed session request ends in the same retry state as a component that reports a load error, because the
 * library may mount nothing at all and never call the component's own hook. It mounts only for an organization that has
 * a payout account, so an organization without one makes no session request.
 */
export default function DocumentsTab(_props: PaymentsTabProps) {
  const timeZone = useScheduleTimezone();
  const queryClient = useQueryClient();
  const orgId = useAuthStore((s) => s.user?.organization_id);
  // A document is the own data of the invoice, job or customer it goes on (P10), so the Edit of one of them uploads it.
  const ability = useAppAbility();
  const canUpload = ability.can('update', 'Invoice') || ability.can('update', 'Job') || ability.can('update', 'Customer');
  const connected = useStripeStatus().data?.connected === true;

  const [page, setPage] = useState(1);
  const [uploadOpen, setUploadOpen] = useState(false);
  const list = useDocuments(page);
  const rows = useMemo(() => list.data?.documents ?? [], [list.data]);
  const pagination = list.data?.pagination;

  const [loadFailures, setLoadFailures] = useState(0);
  const [attempt, setAttempt] = useState(0);

  useEffect(
    () => onSessionRequestFailed((surface) => { if (surface === 'viewer') setLoadFailures((n) => n + 1); }),
    [],
  );
  // The retry state shows only while the section is failed: a session that now answers clears it.
  useEffect(
    () => onSessionRequestSucceeded((surface) => { if (surface === 'viewer') setLoadFailures(0); }),
    [],
  );

  const retry = () => {
    discardViewerConnect();
    setLoadFailures(0);
    setAttempt((n) => n + 1);
  };

  const download = useCallback((row: DocumentRow) => {
    if (!row.download_url) return;
    void downloadAttachment(
      { id: row.id, file_url: row.download_url, display_name: row.name, file_name: storedNameOf(row.download_url) },
      {
        // A stale link: read the page again and take this row's fresh one.
        refresh: async () => {
          const fresh = await fetchDocumentsPage(page);
          queryClient.setQueryData(paymentsPageKeys.documents(orgId, page), fresh);
          return fresh.documents.find((d) => d.id === row.id)?.download_url ?? null;
        },
      },
    );
  }, [page, queryClient, orgId]);

  const columns = useMemo(() => buildDocumentColumns({ timeZone, onDownload: download }), [timeZone, download]);

  const listFailed = list.isError && !list.data;

  return (
    <div className="pt-4">
      <div className="bg-kit-card overflow-hidden rounded-xl border">
        <div className="flex items-center justify-between gap-3 p-4 max-sm:flex-col max-sm:items-stretch">
          <h2 className="text-base font-semibold">Documents</h2>
          {canUpload && (
            <Button type="button" onClick={() => setUploadOpen(true)} className="max-sm:min-h-11 max-sm:w-full">
              <Upload aria-hidden />
              Upload document
            </Button>
          )}
        </div>
        {listFailed ? (
          <LoadError title="Couldn’t load documents." onRetry={() => void list.refetch()} retrying={list.isFetching} />
        ) : !list.isPending && rows.length === 0 && page === 1 ? (
          // Nothing uploaded: the message alone, with no pager chrome under it.
          <div className="border-t"><EmptyState icon={<FileText />} title="No documents yet" /></div>
        ) : (
          <DataTable<DocumentRow, unknown>
            className="rounded-none border-x-0 border-b-0 shadow-none"
            columns={columns}
            data={rows}
            getRowId={(d) => d.id}
            isLoading={list.isPending}
            isFetching={list.isFetching}
            page={page}
            pageCount={pagination?.totalPages ?? 1}
            onPageChange={setPage}
            pageSize={pagination?.limit ?? 25}
            rowCount={pagination?.total ?? 0}
            hidePageSize
            mobileCards
            empty={<EmptyState icon={<FileText />} title="No documents yet" />}
          />
        )}
        {connected && (
          <div className="flex flex-col gap-4 border-t p-4">
            <ConnectComponentsProvider key={attempt} connectInstance={getViewerConnect()}>
              <ConnectDocuments onLoadError={() => setLoadFailures((n) => n + 1)} />
            </ConnectComponentsProvider>
            {/* One failure line: when the list failed too, its message (the same words) is the one on screen. */}
            {loadFailures > 0 && !listFailed && <LoadError title="Couldn’t load documents." onRetry={retry} />}
          </div>
        )}
      </div>
      <UploadDocumentDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        onUploaded={() => setPage(1)}
      />
    </div>
  );
}
