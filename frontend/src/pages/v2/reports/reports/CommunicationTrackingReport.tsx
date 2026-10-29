import { useState } from 'react';
import { Download, FlaskConical } from 'lucide-react';

import { toCSV, downloadCSV } from '@/lib/csv';
import { findReport } from '@/lib/reports/report-catalog';
import { useCommunicationTrackingReport } from '@/lib/reports/communication-tracking-data';

import { Button } from '@/ui-kit/components/ui/button';

import { ReportShell } from '../components/reportShell';
import { TabPanel, TabStrip } from '../../_shared/tabs';
import { CadenceTab } from './comm-tracking/CadenceTab';
import { QaTab } from './comm-tracking/QaTab';
import { TrainingImpactTab } from './comm-tracking/TrainingImpactTab';

/**
 * Communication Tracking & QA - contact cadence, script adherence, training.
 *
 * `useCommunicationTrackingReport(isDemo)` is imported and is the whole data
 * path. Note the demo flag here is a page-local TOGGLE, not `useIsDemoOrg` -
 * this report lets you flip between the sample set and live while it is being
 * built, and that is reproduced as-is rather than being quietly wired to the
 * org flag, which would change what the button does.
 *
 * The export is per-tab and exports the tab's own row set, unchanged.
 *
 * Shape differences: the sample/live toggle and the export are kit Buttons
 * (both were raw - there is no warning-toned Button in either component
 * family), and the underline tab strip is the shared `TabStrip`.
 */

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
      subtitle="Per-job contact cadence, script-adherence QA, and training impact - calls + texts."
      actions={
        <>
          <Button
            type="button"
            aria-pressed={isDemo}
            variant={isDemo ? 'secondary' : 'outline'}
            size="sm"
            onClick={() => setIsDemo((v) => !v)}
          >
            <FlaskConical />
            {isDemo ? 'Sample data' : 'Live'}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={exportCsv}>
            <Download />
            Export
          </Button>
        </>
      }
    >
      <TabStrip
        value={tab}
        onValueChange={(v) => setTab(v as Tab)}
        tabs={TABS.map((t) => ({ value: t, label: t }))}
      />

      {data && (
        <>
          <TabPanel value="Cadence" activeValue={tab}><CadenceTab cadence={data.cadence} /></TabPanel>
          <TabPanel value="QA" activeValue={tab}><QaTab qa={data.qa} /></TabPanel>
          <TabPanel value="Training impact" activeValue={tab}><TrainingImpactTab training={data.training} /></TabPanel>
        </>
      )}
    </ReportShell>
  );
}
