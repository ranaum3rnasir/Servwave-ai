import { Sparkles } from 'lucide-react';

import type { Insight } from '@/lib/api/dashboard';
import { cn } from '@/lib/utils';
import { EmptyState } from '@/ui-kit/components/data/emptyState';

import { WidgetCard } from '../components/widgetCard';
import { ClickRow } from '../components/clickRow';
import { opener } from '@/lib/dashboard/opener';

/**
 * Tone chip fill. The legacy band painted these with the ServWave semantic
 * ramp (`bg-danger/10`, `bg-info/10`, `bg-sage-50`); the kit expresses the same
 * three meanings as status subtles, so the mapping is one namespace to another
 * and not a change of meaning - danger stays red, info stays blue, success
 * stays green.
 */
const TONE_BG: Record<string, string> = {
  danger: 'bg-status-red-subtle',
  info: 'bg-status-blue-subtle',
  success: 'bg-status-green-subtle',
};

/**
 * The full-width insight band.
 *
 * Deliberately NOT inside a WidgetCard when it has insights - it has no title
 * bar and never had one, and the tiles are the surface. Before the first answer
 * it returns `null`, which removes the grid cell (`DashboardPage` drops a widget
 * whose render returns null). With an answer and nothing to say it is a card
 * with one plain line, so a person who put it on their page sees why it is
 * empty rather than a tile that is simply missing.
 *
 * The insights are built on the server (a Company figures tile, so only a person
 * who holds See company figures is sent any): which insight fires, its weight, its
 * tone, its copy and its link are all decided there, and this only draws them. A card the person may not open the
 * list page of arrives without a link: it is drawn without a click and without the call to action that would promise one.
 */
export default function SmartInsights({
  insights,
  navigate,
}: {
  insights: Insight[] | undefined;
  navigate: (to: string) => void;
}) {
  if (!insights) return null;
  if (insights.length === 0) {
    return (
      <WidgetCard title="Smart Insights" icon={<Sparkles className="h-4 w-4 text-muted-foreground" />}>
        <EmptyState className="py-6" title="No insights right now" />
      </WidgetCard>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-3">
      {insights.map((i) => (
        // A card-shaped click target, not a text/icon control: the kit Button
        // supplies the element, the focus ring and the press affordance, and
        // `variant={null}` keeps its own fill out of the way of the AI tint
        // this band has always carried.
        <ClickRow
          key={i.id}
          variant={null}
          onClick={opener(i.link, navigate)}
          className={cn('h-auto items-start justify-start gap-2.5 whitespace-normal rounded-xl border border-ai-200 bg-ai-50 p-3 text-left font-normal', i.link && 'hover:shadow-md')}
        >
          <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-sm ${TONE_BG[i.tone]}`}>
            {i.icon}
          </span>
          <span className="text-[11.5px] leading-snug text-foreground">
            {i.text}
            {i.link && <span className="mt-0.5 block text-[10.5px] font-bold text-ai-text">{i.cta_label} →</span>}
          </span>
        </ClickRow>
      ))}
    </div>
  );
}
