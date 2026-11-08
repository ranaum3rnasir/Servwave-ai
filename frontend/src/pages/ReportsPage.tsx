import { useState } from 'react';
import { Plus, Sparkles, LineChart } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Heading } from '@/components/ui/heading';
import { useAppAbility } from '@/contexts/AbilityContext';
import { useIsDemoOrg } from '@/lib/useIsDemoOrg';
import { useHasFeature } from '@/lib/entitlements';
import { reportCatalog, reportGroupOrder, mainReports, findReport, isReportVisible, type ReportGroup, type ReportVisibilityCtx } from '@/lib/reports/report-catalog';
import { ReportCard } from '@/pages/reports/ReportCard';

// "Main" landing tab first, then one tab per category, then "Custom reports".
type ReportTab = 'main' | ReportGroup | 'custom';

export default function ReportsPage() {
  const ability = useAppAbility();
  const isDemoOrg = useIsDemoOrg();
  const hasFeature = useHasFeature();
  const [tab, setTab] = useState<ReportTab>('main');

  // ONE hook call for the whole catalog - never a hook inside a filter/map or
  // inside ReportCard. Both call sites below share this ctx.
  const visibility: ReportVisibilityCtx = { canRead: (s) => ability.can('read', s), isDemoOrg, hasFeature };

  // A card shows only if (a) the role can read its subject AND (b) it's allowed
  // for this org - demo orgs see every report; real orgs see only DB-backed,
  // entitled ones.
  const visibleReports = reportCatalog.filter((r) => isReportVisible(r, visibility));

  // Main tab: the curated Workiz-order set, with Workiz card labels overridden.
  // `code` is dropped so Main-tab cards don't show strategic badges (e.g. F4).
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
    <div className="space-y-6">
      {/* Page heading + actions */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Heading level={1} scale="2xl" className="flex items-center gap-2"><LineChart className="h-6 w-6 shrink-0 text-primary" />Reports</Heading>
        <div className="flex items-center gap-3">
          {/* Placeholder actions — wired up in a later phase. */}
          {/* AI-tinted text trigger (text-ai-text hover:text-ai-strong) - only solid/ai is minted,
              no ghost/link ai-tone cell exists - left raw */}
          <button
            type="button"
            title="Coming soon"
            className="flex items-center gap-1.5 text-sm font-semibold text-ai-text hover:text-ai-strong"
          >
            <Sparkles className="h-4 w-4" />
            Create report with AI
          </button>
          <Button title="Coming soon" className="gap-1.5">
            <Plus className="h-4 w-4" />
            Create report
          </Button>
        </div>
      </div>

      {/* Main landing tab, then one tab per group, then Custom reports */}
      <div className="flex flex-wrap items-center gap-6 border-b border-border">
        <TabButton active={tab === 'main'} onClick={() => setTab('main')}>
          Main
        </TabButton>
        {reportGroupOrder.map((group) => (
          <TabButton key={group} active={tab === group} onClick={() => setTab(group)}>
            {group}
          </TabButton>
        ))}
        <TabButton active={tab === 'custom'} onClick={() => setTab('custom')}>
          Custom reports
        </TabButton>
      </div>

      {/* Content — only the active tab's cards render */}
      {tab === 'main' ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {mainCards.map((report) => (
            <ReportCard key={report.slug} report={report} />
          ))}
        </div>
      ) : tab === 'custom' ? (
        <EmptyState
          variant="card"
          title="No custom reports yet"
          description="Build your own report with the “Create report” button. Coming soon."
        />
      ) : activeReports.length === 0 ? (
        <EmptyState variant="card" title={`No ${tab} reports available.`} />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {activeReports.map((report) => (
            <ReportCard key={report.slug} report={report} />
          ))}
        </div>
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    // underline tab trigger, not a Button shape - left raw
    <button
      type="button"
      onClick={onClick}
      className={`-mb-px border-b-2 pb-2.5 pt-1 text-sm font-semibold transition-colors ${
        active
          ? 'border-text-primary text-text-primary'
          : 'border-transparent text-text-secondary hover:text-text-primary'
      }`}
    >
      {children}
    </button>
  );
}
