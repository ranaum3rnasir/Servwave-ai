import type { Insight } from '@/lib/api/dashboard';

const TONE_BG: Record<string, string> = { danger: 'bg-danger/10', info: 'bg-info/10', success: 'bg-sage-50' };

/** Smart Insights are built on the server (a Company figures tile); the browser only draws what it is sent. */
export default function SmartInsights({
  insights,
  navigate,
}: {
  insights: Insight[] | undefined;
  navigate: (to: string) => void;
}) {
  if (!insights || insights.length === 0) return null;
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
      {insights.map((i) => (
        // Composed clickable card (icon chip + insight text + CTA label), not a text/icon
        // Button control - the grid-tile equivalent of the excluded list-row click target
        // shape, left raw per the program's non-Button-shape carve-out.
        <button
          key={i.id}
          type="button"
          onClick={() => i.link && navigate(i.link)}
          className="flex items-start gap-2.5 text-left rounded-xl border border-ai-200 bg-ai-50 p-3 hover:shadow-hover transition-all"
        >
          <span className={`h-7 w-7 shrink-0 rounded-lg flex items-center justify-center text-sm ${TONE_BG[i.tone]}`}>{i.icon}</span>
          <span className="text-[11.5px] leading-snug text-text-primary">
            {i.text}
            <span className="block text-[10.5px] font-bold text-ai-text mt-0.5">{i.cta_label} →</span>
          </span>
        </button>
      ))}
    </div>
  );
}
