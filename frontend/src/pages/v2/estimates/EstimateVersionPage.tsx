/**
 * `/estimates/:id/versions/:version` — a past version of an estimate, read as the customer
 * received it (#2030 slice 3).
 *
 * ITS OWN ROUTE, not a mode flag on the workspace. Read-only is then structural: there is nothing
 * on this page that could write, and the API has no write verb on the path at all, so it cannot
 * be got wrong by a later change to a shared component's props.
 *
 * The document is rendered by `EstimateDocumentView` — the SAME component the live estimate and
 * the public page use — from the frozen view-model the snapshot holds. That is what guarantees a
 * past version looks like what was actually sent, rather than like today's template applied to
 * old data.
 */
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, History } from 'lucide-react';
import api from '@/lib/axios';
import { Card } from '@/components/ui/card';
import { Heading } from '@/components/ui/heading';
import { EstimateDocumentView } from '@/components/estimates/EstimateDocumentView';
import { customerDisplayName } from '@/lib/customer-name';
import { extractApiError } from '@/lib/utils';
import type { EstimateDocumentModel } from '@/lib/estimate-document-view';
import { useRecordVisit } from '../pageBreadcrumbs';

interface FrozenDocument {
  /** The backend's view-model. A superset of the component's own — same rows, same totals. */
  view: EstimateDocumentModel & { number: string; taxRate: number };
  customer: { first_name?: string | null; last_name?: string | null; company_name?: string | null } | null;
}

interface EstimateVersion {
  version: number;
  trigger: string | null;
  sent_at: string;
  estimate_id: string;
  estimate_number: string;
  document: FrozenDocument;
}

/** How the version was delivered, in the words a salesperson would use. */
const TRIGGER_LABEL: Record<string, string> = {
  SEND: 'emailed to the customer',
  MARK_SENT: 'marked as sent',
  COPY_TO_INVOICE: 'copied to an invoice',
};

export default function EstimateVersionPage() {
  const { id, version } = useParams<{ id: string; version: string }>();
  const [data, setData] = useState<EstimateVersion | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get(`/api/estimates/${id}/versions/${version}`)
      .then((res) => { if (!cancelled) setData(res.data.version as EstimateVersion); })
      .catch((err) => { if (!cancelled) setError(extractApiError(err, 'That version could not be opened.')); });
    return () => { cancelled = true; };
  }, [id, version]);

  // Same nav key as the live workspace page (`EstimateWorkspacePage.tsx`), so both read as one
  // "Estimates" journey in the trail rather than two unrelated sections. Named only once the
  // version has loaded — before that, the layout's own fallback ("Estimates") is exactly as
  // good a guess as this page could make, and is what it fell back to before this fix, too.
  useRecordVisit('estimates', data ? `${data.estimate_number} · Version ${data.version}` : undefined);

  if (error) {
    return (
      <Card padding="sm" tone="danger">
        <p className="text-sm text-danger-text">{error}</p>
        <Link to={`/estimates/${id}`} className="mt-2 inline-flex items-center gap-1.5 text-sm text-primary hover:underline">
          <ArrowLeft className="h-4 w-4" />
          Back to the current estimate
        </Link>
      </Card>
    );
  }

  if (!data) return <p className="text-sm text-text-secondary">Loading…</p>;

  const doc = data.document;
  const sentAt = new Date(data.sent_at).toLocaleString('en-US');

  return (
    <div className="mx-auto max-w-3xl space-y-4 py-4">
      {/* Marked as a past version FIRST, before any of the document — so nobody reads a stale
          total believing it is the current one. */}
      <Card padding="sm" tone="info">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-start gap-2">
            <History className="mt-0.5 h-4 w-4 shrink-0 text-info-text" aria-hidden />
            <div>
              <Heading level={2} scale="base" weight="bold">
                Version {data.version} of {data.estimate_number}
              </Heading>
              <p className="text-xs text-text-secondary">
                This is a past version, exactly as it was {TRIGGER_LABEL[data.trigger ?? ''] ?? 'sent'} on {sentAt}. It cannot be edited.
              </p>
            </div>
          </div>
          <Link
            to={`/estimates/${data.estimate_id}`}
            className="inline-flex items-center gap-1.5 whitespace-nowrap text-sm font-medium text-primary hover:underline"
          >
            <ArrowLeft className="h-4 w-4" />
            Current estimate
          </Link>
        </div>
      </Card>

      {/* The SAME component the live estimate and the public page render, fed the frozen
          view-model instead of the live one. That is what makes a past version look like what was
          actually sent rather than like today's template applied to old data. */}
      <EstimateDocumentView
        estimateNumber={doc.view.number}
        customerName={customerDisplayName(doc.customer ?? undefined, '')}
        companyName={doc.customer?.company_name}
        document={doc.view}
        taxRate={doc.view.taxRate}
      />
    </div>
  );
}
