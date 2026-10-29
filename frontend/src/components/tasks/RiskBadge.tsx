import type { RiskResult } from '@/lib/tasks/tasks-logic';

export function RiskBadge({ result }: { result: RiskResult }) {
  if (!result.atRisk) return null;
  return (
    <span
      title={result.reason ?? ''}
      className="inline-flex items-center rounded-full border border-warning-border bg-warning-surface px-2.5 py-0.5 text-xs font-semibold text-warning-text"
    >
      ⚠ At risk
    </span>
  );
}
