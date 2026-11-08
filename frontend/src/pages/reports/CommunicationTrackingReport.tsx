import { useState } from 'react';
import { FlaskConical, Download } from 'lucide-react';
import { findReport } from '@/lib/reports/report-catalog';
import { ReportShell } from './ReportShell';
import { toCSV, downloadCSV } from '@/lib/csv';
import { useCommunicationTrackingReport } from '@/lib/reports/communication-tracking-data';
import { CadenceTab } from './comm-tracking/CadenceTab';
import { QaTab } from './comm-tracking/QaTab';
import { TrainingImpactTab } from './comm-tracking/TrainingImpactTab';

const TABS = ['Cadence', 'QA', 'Training impact'] as const;
type Tab = (typeof TABS)[number];

export default function CommunicationTrackingReport() {
  const report = findReport('communication-tracking')!;
  const [tab, setTab] = useState<Tab>('Cadence');
  const [isDemo, setIsDemo] = useState(true);
  const { data } = useCommunicationTrackingReport(isDemo);

  function exportCsv() {
    if (!data) return;
    if (tab === 'Cadence') {
      downloadCSV(toCSV(data.cadence.rows as unknown as Record<string, unknown>[]), 'cadence.csv');
    } else if (tab === 'QA') {
      downloadCSV(toCSV(data.qa.byRep as unknown as Record<string, unknown>[]), 'qa-by-rep.csv');
    } else {
      downloadCSV(toCSV(data.training.rows as unknown as Record<string, unknown>[]), 'training-impact.csv');
    }
  }

  return (
    <ReportShell
      report={report}
      subtitle="Per-job contact cadence, script-adherence QA, and training impact — calls + texts."
      actions={
        <>
          {/* Raw by design: active state is warning-tinted (border-warning/40
              bg-warning/10 text-warning) - no `warning` tone is minted on Button
              (only brand/neutral/subtle/danger/ai/business). Not Button-shaped. */}
          <button
            type="button"
            onClick={() => setIsDemo((v) => !v)}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium ${
              isDemo ? 'border-warning/40 bg-warning/10 text-warning' : 'border-border text-text-secondary'
            }`}
          >
            <FlaskConical className="h-4 w-4" />
            {isDemo ? 'Sample data' : 'Live'}
          </button>
          {/* Raw by design: outline/neutral's border matches but it sets no idle text
              colour (button.tsx's own trap note), and this button's ambient wrapper
              (ReportShell's actions slot, a plain flex div) supplies none either - the
              label would silently go near-black instead of text-text-secondary. No
              matching cell - left raw (same trap as TaskFilterBar.tsx). */}
          <button
            type="button"
            onClick={exportCsv}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-text-secondary hover:text-text-primary"
          >
            <Download className="h-4 w-4" />
            Export
          </button>
        </>
      }
    >
      <div className="flex gap-6 overflow-x-auto border-b border-border">
        {TABS.map((t) => (
          // Segmented tab-underline control, not Button-shaped - left raw.
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`whitespace-nowrap border-b-2 px-1 pb-3 text-sm font-medium transition-colors ${
              tab === t ? 'border-text-primary text-text-primary' : 'border-transparent text-text-secondary hover:text-text-primary'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {data && tab === 'Cadence' && <CadenceTab cadence={data.cadence} />}
      {data && tab === 'QA' && <QaTab qa={data.qa} />}
      {data && tab === 'Training impact' && <TrainingImpactTab training={data.training} />}
    </ReportShell>
  );
}
