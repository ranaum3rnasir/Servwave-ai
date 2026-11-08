import { computeInsights } from '@/lib/dashboard/insightRules';
import type { DashboardResponse } from '@/lib/api/dashboard';

const TONE_BG: Record<string, string> = { danger: 'bg-danger/10', info: 'bg-info/10', success: 'bg-sage-50' };

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
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
      {insights.map((i) => (
        // Composed clickable card (icon chip + insight text + CTA label), not a text/icon
        // Button control - the grid-tile equivalent of the excluded list-row click target
        // shape, left raw per the program's non-Button-shape carve-out.
        <button
          key={i.id}
          type="button"
          onClick={() => navigate(i.link)}
          className="flex items-start gap-2.5 text-left rounded-xl border border-ai-200 bg-ai-50 p-3 hover:shadow-hover transition-all"
        >
          <span className={`h-7 w-7 shrink-0 rounded-lg flex items-center justify-center text-sm ${TONE_BG[i.tone]}`}>{i.icon}</span>
          <span className="text-[11.5px] leading-snug text-text-primary">
            {i.text}
            <span className="block text-[10.5px] font-bold text-ai-600 mt-0.5">{i.cta_label} →</span>
          </span>
        </button>
      ))}
    </div>
  );
}
