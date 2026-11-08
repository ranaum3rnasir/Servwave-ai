import { useState } from 'react';
import { LineChart, Plus, Sparkles } from 'lucide-react';

import { useAppAbility } from '@/contexts/AbilityContext';
import { useIsDemoOrg } from '@/lib/useIsDemoOrg';
import { useHasFeature } from '@/lib/entitlements';
import {
  findReport, isReportVisible, mainReports, reportCatalog, reportGroupOrder,
  type ReportGroup, type ReportVisibilityCtx,
} from '@/lib/reports/report-catalog';

import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { PageHeader } from '@/ui-kit/components/layout/pageHeader';
import { Button } from '@/ui-kit/components/ui/button';

import { useRecordVisit } from '../pageBreadcrumbs';
import { TabPanel, TabStrip } from '../_shared/tabs';
import { ReportCard } from './components/reportCard';

// "Main" landing tab first, then one tab per category, then "Custom reports".
type ReportTab = 'main' | ReportGroup | 'custom';

/**
 * /v2/reports - the reports landing grid on the CRM UI kit.
 *
 * EVERY VISIBILITY DECISION IS IMPORTED, none is restated. `isReportVisible`
 * ANDs the CASL `read` on the report's subject with `canShowReport`'s three
 * org-level axes (demo org short-circuit, declared entitlement, `live`), and it
 * is called with ONE `ctx` built from one `useAppAbility`, one `useIsDemoOrg`
 * and one `useHasFeature` - never a hook inside a filter or a map, which is the
 * shape the legacy page went out of its way to keep and the reason the ctx
 * object exists at all.
 *
 * The Main tab's curated list keeps its two overrides too: the Workiz card
 * label replaces the catalog label, and `code` is dropped so a Main-tab card
 * shows no strategic badge.
 *
 * WHAT CHANGED is the chrome. The heading row is the kit's `PageHeader`, the
 * category strip is the shared `TabStrip` (the kit ships no tabs primitive -
 * the ninth module to hit that), and the two "coming soon" actions are kit
 * Buttons. The AI action loses its ai-tinted text: the kit has no ai tone, and
 * the legacy site was explicitly a raw un-minted button for that reason.
 */
export default function ReportsPage() {
  useRecordVisit('reports');
  const ability = useAppAbility();
  const isDemoOrg = useIsDemoOrg();
  const hasFeature = useHasFeature();
  const [tab, setTab] = useState<ReportTab>('main');

  const visibility: ReportVisibilityCtx = { canRead: (s) => ability.can('read', s), isDemoOrg, hasFeature };

  const visibleReports = reportCatalog.filter((r) => isReportVisible(r, visibility));

  const mainCards = mainReports
    .map((m) => {
      const report = findReport(m.slug);
      return isReportVisible(report, visibility) ? { ...report, label: m.label, code: undefined } : null;
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  const activeReports =
    tab === 'main' || tab === 'custom'
      ? []
      : visibleReports.filter((r) => r.group === tab && !r.mainOnly);

  return (
    <div>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <LineChart className="text-brand size-6 shrink-0" />
            Reports
          </span>
        }
        actions={
          <>
            {/* Both are placeholders in the legacy page too - the title
                attribute is the whole affordance and it is carried over. */}
            <Button type="button" variant="ghost" title="Coming soon">
              <Sparkles />
              Create report with AI
            </Button>
            <Button type="button" title="Coming soon">
              <Plus />
              Create report
            </Button>
          </>
        }
      />

      <TabStrip
        className="mb-4"
        value={tab}
        onValueChange={(v) => setTab(v as ReportTab)}
        tabs={[
          { value: 'main', label: 'Main' },
          ...reportGroupOrder.map((group) => ({ value: group, label: group })),
          { value: 'custom', label: 'Custom reports' },
        ]}
      />

      <TabPanel value="main" activeValue={tab}>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {mainCards.map((report) => (
            <ReportCard key={report.slug} report={report} />
          ))}
        </div>
      </TabPanel>

      <TabPanel value="custom" activeValue={tab}>
        <EmptyState
          title="No custom reports yet"
          description="Build your own report with the Create report button. Coming soon."
        />
      </TabPanel>

      {reportGroupOrder.map((group) => (
        <TabPanel key={group} value={group} activeValue={tab}>
          {activeReports.length === 0 ? (
            <EmptyState title={`No ${group} reports available.`} />
          ) : (
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {activeReports.map((report) => (
                <ReportCard key={report.slug} report={report} />
              ))}
            </div>
          )}
        </TabPanel>
      ))}
    </div>
  );
}
