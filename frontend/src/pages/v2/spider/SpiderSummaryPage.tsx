import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Download, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Heading } from '@/ui-kit/components/ui/heading';
import { Skeleton } from '@/ui-kit/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui-kit/components/ui/table';
import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { Card, CardContent } from '@/ui-kit/components/ui/card';
import { cn } from '@/lib/utils';
import { useSpiderSummary, type SpiderStage, type SpiderSummary, type SpiderSummaryLead } from '@/lib/api/spider';
import { useIsSpiderAdmin } from '@/lib/spider/gate';
import { downloadSummaryCsv, summaryMadeWhen, summaryNow, summaryWhen } from '@/lib/spider/summary';
import { useRecordVisit } from '../pageBreadcrumbs';

/*
 * Spider's starting summary (#2794): the leads that were already past their limit when Spider started
 * watching something new, as Ran approved it in the demo (starting-summary-demo-v3, 17 Oct). The bell,
 * the email's button and the text's link all open it.
 *
 * Any role in a Spider company may open it; each person reads only their own leads (the server
 * decides). An Admin coming from the Spider page's card reads the whole company (`?scope=company`).
 * Behind the Spider gate (spider.routes.tsx). Read once when it opens; "Download CSV" reads it again,
 * so "Now" in the file is as of the download.
 */

const STAGE_ORDER: SpiderStage[] = ['NEW', 'CONTACTED', 'WALKTHROUGH_COMPLETED'];

export default function SpiderSummaryPage() {
  useRecordVisit('spider-summary', "Spider's starting summary");
  const [params] = useSearchParams();
  const isAdmin = useIsSpiderAdmin();
  const scope = isAdmin && params.get('scope') === 'company' ? 'company' : 'mine';
  const query = useSpiderSummary(scope);
  const summary = query.data ?? null;

  const [downloading, setDownloading] = useState(false);
  const download = async () => {
    setDownloading(true);
    try {
      const fresh = await query.refetch();
      const latest = fresh.data ?? summary;
      if (latest) downloadSummaryCsv(latest);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="w-full space-y-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1 basis-60">
          <Heading level={1} scale="2xl" className="text-text-primary">
            Spider&apos;s starting summary
          </Heading>
          {summary && (
            <p className="mt-1 text-sm text-text-secondary">
              {summary.scope === 'company' ? 'Whole company' : 'Your leads'} · made {summaryWhen(summary.created_at)},{' '}
              {summaryMadeWhen(summary.trigger_kind)}
            </p>
          )}
        </div>
        {summary && (
          <Button variant="outline" size="sm" className="gap-2" onClick={download} disabled={downloading}>
            <Download className="h-4 w-4" aria-hidden />
            Download CSV
          </Button>
        )}
      </div>

      {query.isPending ? (
        <Skeleton data-spider-summary-placeholder aria-hidden className="h-64 w-full rounded-card" />
      ) : query.isError ? (
        <Card>
          <CardContent className="flex flex-col items-start gap-3 py-6">
            <p role="alert" className="text-sm text-danger-text">
              Could not load the starting summary.
            </p>
            <Button variant="outline" onClick={() => query.refetch()}>
              Try again
            </Button>
          </CardContent>
        </Card>
      ) : summary ? (
        <SummaryBody summary={summary} />
      ) : (
        <Card data-spider-summary-empty>
          <EmptyState
            icon={<FileText aria-hidden />}
            title="There's no starting summary"
            description="Nothing was past its limit when Spider was turned on."
          />
        </Card>
      )}
    </div>
  );
}

function SummaryBody({ summary }: { summary: SpiderSummary }) {
  const counts = useMemo(() => {
    const c = new Map<SpiderStage, { name: string; n: number }>();
    for (const l of summary.leads) {
      const e = c.get(l.stage) ?? { name: l.stage_name, n: 0 };
      e.n += 1;
      c.set(l.stage, e);
    }
    return STAGE_ORDER.flatMap((s) => (c.has(s) ? [{ stage: s, ...c.get(s)! }] : []));
  }, [summary.leads]);
  const [filter, setFilter] = useState<SpiderStage | 'ALL'>('ALL');
  const active = filter !== 'ALL' && counts.some((c) => c.stage === filter) ? filter : 'ALL';
  const rows = active === 'ALL' ? summary.leads : summary.leads.filter((l) => l.stage === active);

  return (
    <>
      <p className="flex flex-wrap gap-x-4 gap-y-1.5 text-sm text-text-secondary">
        <span>
          <b className="text-text-primary">{summary.total}</b> past their limit
        </span>
        <span>
          <b className="text-text-primary">{summary.still_waiting}</b> still waiting
        </span>
        <span>
          <b className="text-text-primary">{summary.moved_on}</b> moved on since
        </span>
      </p>

      <div role="group" aria-label="Filter by status" className="flex flex-wrap gap-1.5">
        <FilterChip label="All" count={summary.total} pressed={active === 'ALL'} onClick={() => setFilter('ALL')} />
        {counts.map((c) => (
          <FilterChip key={c.stage} label={c.name} count={c.n} pressed={active === c.stage} onClick={() => setFilter(c.stage)} />
        ))}
      </div>

      <div className="overflow-hidden rounded-2xl border border-border/80 bg-surface-light shadow-sm">
        {/* Phones: each lead is a block (the same fields as the table). */}
        <ul className="divide-y divide-border/60 md:hidden" aria-label="Leads in the starting summary">
          {rows.map((l) => (
            <li key={l.lead_id} className={cn('space-y-1 px-4 py-3 text-sm', l.moved_on && 'text-text-secondary')}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <LeadLink lead={l} />
                <NowTag lead={l} />
              </div>
              <p className={cn(!l.moved_on && 'text-text-primary')}>
                {l.customer_name}
                <span className="block text-xs text-text-secondary">{l.address}</span>
              </p>
              <p className="text-xs text-text-secondary">
                Status then: <span className={cn(!l.moved_on && 'text-text-primary')}>{l.stage_name}</span>
              </p>
              <OverBy lead={l} />
              {summary.show_owner && (
                <p className="text-xs text-text-secondary">
                  Owner: <span className={cn(!l.moved_on && 'text-text-primary')}>{l.owner_name ?? 'No owner'}</span>
                </p>
              )}
            </li>
          ))}
        </ul>

        <Table className="hidden md:table" containerClassName="hidden md:block">
          <TableHeader>
            <TableRow className="hover:bg-kit-card">
              <TableHead>Lead</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Status then</TableHead>
              <TableHead>Over the limit by</TableHead>
              {summary.show_owner && <TableHead>Owner</TableHead>}
              <TableHead>Now</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((l) => (
              <TableRow key={l.lead_id} data-moved-on={l.moved_on || undefined} className={cn(l.moved_on && 'text-text-secondary')}>
                <TableCell className="whitespace-nowrap align-top">
                  <LeadLink lead={l} />
                </TableCell>
                <TableCell className="align-top">
                  {l.customer_name}
                  <span className="block text-xs text-text-secondary">{l.address}</span>
                </TableCell>
                <TableCell className="whitespace-nowrap align-top">{l.stage_name}</TableCell>
                <TableCell className="whitespace-nowrap align-top">
                  <OverBy lead={l} />
                </TableCell>
                {summary.show_owner && (
                  <TableCell className="whitespace-nowrap align-top">
                    {l.owner_name ?? <span className="text-text-secondary">No owner</span>}
                  </TableCell>
                )}
                <TableCell className="whitespace-nowrap align-top">
                  <NowTag lead={l} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}

function FilterChip({ label, count, pressed, onClick }: { label: string; count: number; pressed: boolean; onClick: () => void }) {
  return (
    <Button
      variant={pressed ? 'solid' : 'outline'}
      tone={pressed ? 'brand' : 'neutral'}
      size="sm"
      aria-pressed={pressed}
      onClick={onClick}
      className="gap-1"
    >
      {label}
      <span className={cn('font-semibold', pressed ? 'opacity-75' : 'text-text-secondary')}>{count}</span>
    </Button>
  );
}

function LeadLink({ lead }: { lead: SpiderSummaryLead }) {
  return (
    <Link
      to={`/leads/${lead.lead_id}`}
      className="font-bold text-ai-600 underline decoration-ai-200 underline-offset-[3px] hover:decoration-ai-600"
      aria-label={`Open lead ${lead.lead_number}`}
    >
      {lead.lead_number}
    </Link>
  );
}

function OverBy({ lead }: { lead: SpiderSummaryLead }) {
  return (
    <span className="block">
      <span className={cn('font-bold', lead.moved_on ? 'text-text-secondary' : 'text-warning-text')}>{lead.over_by} over</span>
      <span className="block text-xs text-text-secondary">
        In status {lead.in_stage} · limit {lead.limit}
      </span>
    </span>
  );
}

function NowTag({ lead }: { lead: SpiderSummaryLead }) {
  return lead.moved_on ? (
    <span className="inline-flex h-6 items-center whitespace-nowrap rounded-full border border-border bg-background-light px-2.5 text-xs font-bold text-text-secondary">
      {summaryNow(lead)}
    </span>
  ) : (
    <span className="inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full border border-warning-border bg-warning-surface px-2.5 text-xs font-bold text-warning-text">
      <span aria-hidden className="h-[7px] w-[7px] rounded-full bg-current" />
      {summaryNow(lead)}
    </span>
  );
}
