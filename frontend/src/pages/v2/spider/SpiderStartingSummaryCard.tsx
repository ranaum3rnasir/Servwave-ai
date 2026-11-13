import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useSpiderSummary } from '@/lib/api/spider';
import {
  SPIDER_COMPANY_SUMMARY_PATH,
  downloadSummaryCsv,
  summaryCardSentence,
  summaryWhen,
} from '@/lib/spider/summary';

/**
 * The "Starting summary" card on the Spider page (#2794, placement A, as the demo shows it): directly
 * under the header card with the status, above Configuration | History. It shows only while
 * Spider is Active (the page mounts it then) and a summary exists; otherwise nothing at all.
 *
 * View opens the company-wide summary; Download CSV saves the whole company's list, read again so
 * "Now" is as of the download.
 */
export function SpiderStartingSummaryCard() {
  const navigate = useNavigate();
  // Read again when the window comes back into focus, and when the live line says a summary is ready (#3472).
  const query = useSpiderSummary('company', { refetchOnFocus: true });
  const summary = query.data;
  const [downloading, setDownloading] = useState(false);
  if (!summary) return null;

  const download = async () => {
    setDownloading(true);
    try {
      const fresh = await query.refetch();
      downloadSummaryCsv(fresh.data ?? summary);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <section
      aria-labelledby="spider-starting-summary-title"
      data-spider-starting-summary
      className="flex flex-wrap items-center gap-3.5 rounded-2xl border border-ai-200 bg-ai-50 py-3 pl-3.5 pr-3"
    >
      <span
        aria-hidden
        className="grid h-10 w-10 shrink-0 place-items-center rounded-[10px] bg-surface-light text-ai-600 ring-1 ring-ai-200"
      >
        <FileText className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1 basis-64">
        <p id="spider-starting-summary-title" className="flex flex-wrap items-baseline gap-2 text-[14.5px] font-extrabold text-text-primary">
          Starting summary
          <small className="text-[12.5px] font-semibold text-text-secondary">{summaryWhen(summary.created_at)}</small>
        </p>
        <p className="text-[13.5px] text-text-secondary">{summaryCardSentence(summary)}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => navigate(SPIDER_COMPANY_SUMMARY_PATH)}>
          View
        </Button>
        <Button variant="outline" size="sm" className="gap-2" onClick={download} disabled={downloading}>
          <Download className="h-4 w-4" aria-hidden />
          Download CSV
        </Button>
      </div>
    </section>
  );
}
