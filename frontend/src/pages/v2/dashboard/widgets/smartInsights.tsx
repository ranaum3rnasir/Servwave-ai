import { computeInsights } from '@/lib/dashboard/insightRules';
import type { DashboardResponse } from '@/lib/api/dashboard';
import { Button } from '@/ui-kit/components/ui/button';

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
 * Deliberately NOT inside a WidgetCard - it has no title bar and never had one,
 * and the tiles are the surface. Two self-veto paths are preserved exactly: no
 * data and no insights both return `null`, which removes the grid cell rather
 * than leaving an empty box (`DashboardPage` drops a widget whose render
 * returns null).
 *
 * `computeInsights` is imported, not reimplemented. It is the whole rule set -
 * which insight fires, its weight, its tone, its copy and its link - and it is
 * shared with the legacy band.
 */
export default function SmartInsights({
  data,
  navigate,
}: {
  data: DashboardResponse | undefined;
  navigate: (to: string) => void;
}) {
  if (!data) return null;
  const insights = computeInsights(data);
  if (insights.length === 0) return null;
  return (
    <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-3">
      {insights.map((i) => (
        // A card-shaped click target, not a text/icon control: the kit Button
        // supplies the element, the focus ring and the press affordance, and
        // `variant={null}` keeps its own fill out of the way of the AI tint
        // this band has always carried.
        <Button
          key={i.id}
          type="button"
          variant={null}
          size={null}
          onClick={() => navigate(i.link)}
          className="h-auto items-start justify-start gap-2.5 whitespace-normal rounded-xl border border-ai-200 bg-ai-50 p-3 text-left font-normal hover:shadow-md"
        >
          <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-sm ${TONE_BG[i.tone]}`}>
            {i.icon}
          </span>
          <span className="text-[11.5px] leading-snug text-foreground">
            {i.text}
            <span className="mt-0.5 block text-[10.5px] font-bold text-ai-600">{i.cta_label} →</span>
          </span>
        </Button>
      ))}
    </div>
  );
}
