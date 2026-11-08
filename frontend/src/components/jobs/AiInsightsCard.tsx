import { useState } from 'react';
import {
  Camera,
  CheckCircle2,
  Sparkles,
  FileCheck,
  FileText,
  Users,
  TrendingUp,
  ChevronUp,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { deriveJobInsights, type JobInsight } from '@/lib/jobs/insights';
import { SectionCard } from '@/components/jobs/overview/SectionCard';
import { Collapse } from '@/components/ui/collapse';

interface AiInsightsCardProps {
  job: {
    status: string;
    job_type?: string | null;
    signature_at?: string | null;
    scheduled_start?: string | null;
    assignees?: Array<unknown> | null;
    estimate?: { estimate_number?: string; status?: string; total_amount?: number | string } | null;
  };
  attachments: Array<{ file_type?: string | null }> | null | undefined;
  financials?: unknown;
}

const INSIGHT_ICONS: Record<JobInsight['key'], typeof Camera> = {
  photos_uploaded: Camera,
  documents_on_file: FileText,
  estimate_approved: FileCheck,
  crew_assigned: Users,
  upsell_opportunity: TrendingUp,
};

function InsightIcon({ insightKey }: { insightKey: JobInsight['key'] }) {
  const Icon = INSIGHT_ICONS[insightKey] ?? CheckCircle2;
  return <Icon className="h-4 w-4 shrink-0" />;
}

export function AiInsightsCard({ job, attachments, financials }: AiInsightsCardProps) {
  const insights = deriveJobInsights(job, attachments, financials);
  const [collapsed, setCollapsed] = useState(false);

  return (
    <SectionCard
      tone="ai"
      icon={
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-ai-600/10">
          <Sparkles className="h-4 w-4 text-ai-600" />
        </span>
      }
      title={
        <span className="inline-flex items-center gap-2">
          AI Operations Insights
          <span className="rounded-full bg-ai-600/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-ai-600">
            BETA
          </span>
        </span>
      }
      meta={
        insights.length > 0 ? (
          // Left raw: idle text-ai-600/70, hover text-ai-600 - no ghost/ai (or any
          // ai-toned) cell is minted on Button, so this AI-surface accent colour has
          // no matching cell to convert onto.
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            aria-label={collapsed ? 'Expand insights' : 'Collapse insights'}
            aria-expanded={!collapsed}
            className="text-ai-600/70 hover:text-ai-600 transition-colors"
          >
            <ChevronUp className={cn('h-4 w-4 transition-transform', collapsed && 'rotate-180')} />
          </button>
        ) : undefined
      }
    >
      {insights.length === 0 ? (
        <div className="flex items-center gap-2 rounded-lg bg-ai-600/5 px-3 py-2.5 text-sm text-ai-600">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <p className="font-medium">All caught up — no action items.</p>
        </div>
      ) : (
        <Collapse open={!collapsed}>
          <ul className="divide-y divide-ai-600/10">
            {insights.map((insight) => (
              <li key={insight.key} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                <div
                  className={cn(
                    'flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
                    insight.severity === 'warning'
                      ? 'bg-warning/10 text-warning'
                      : 'bg-ai-600/10 text-ai-600',
                  )}
                >
                  <InsightIcon insightKey={insight.key} />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-text-primary leading-snug">{insight.title}</p>
                  {insight.detail && (
                    <p className="mt-0.5 text-xs text-text-secondary leading-relaxed">{insight.detail}</p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Collapse>
      )}
    </SectionCard>
  );
}
