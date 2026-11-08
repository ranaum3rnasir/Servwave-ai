/**
 * SubStatusPicker — the one extra control JOB_SUB_STATUS_ENTERED needs beyond
 * EventModePanel's plain radio pick (SRVW-113): WHICH sub-status the workflow
 * watches. Rendered by TriggerForm directly under EventModePanel whenever
 * `local.eventTrigger === 'JOB_SUB_STATUS_ENTERED'`, mirroring how DateModePanel
 * is the one extra control date mode needs.
 *
 * Radio-row layout copied from EventModePanel.tsx (role="radio", dot indicator,
 * two-line label) rather than a shadcn `<Select>` — no other step in this wizard
 * uses a combobox, and sub-statuses across every JobStatus parent are shown
 * flat in one list (a job can enter ANY org-defined label regardless of its
 * current status), so each row's second line names the parent to disambiguate
 * two parents that happen to reuse the same word.
 *
 * Empty-org state mirrors StopIfForm.tsx's "nothing to check against" box
 * (same warning-tinted card, same tone) rather than rendering an empty radio
 * list — plus a real navigable link to Settings, since nothing in this wizard
 * self-serves a new sub-status from inside the drawer.
 */

import { Link } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import { useJobSubStatuses } from '@/lib/api/jobSubStatuses';
import { STATUS_REGISTRY } from '@/design-system/status-registry';

export interface SubStatusPickerProps {
  value?: string;
  onPick: (subStatusId: string) => void;
}

export default function SubStatusPicker({ value, onPick }: SubStatusPickerProps) {
  const { data: subStatuses } = useJobSubStatuses();
  const options = subStatuses ?? [];

  if (options.length === 0) {
    return (
      <div className="flex items-start gap-2.5 rounded bg-warning/10 px-3 py-2.5">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
        <div>
          <p className="text-sm font-semibold text-text-primary">No job sub-statuses yet</p>
          <p className="mt-0.5 text-xs leading-relaxed text-text-secondary">
            This trigger has no label to watch until your org adds one.
          </p>
          <Link
            to="/settings/job-sub-statuses"
            className="mt-1.5 inline-block text-xs font-semibold text-primary hover:underline"
          >
            Go to Settings → Job Sub-Statuses
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-3.5">
      {/* Raw h3/p, matching EventModePanel's own un-Heading-able sizing (text-[15px]/text-[12.5px]
          have no matching Heading scale key). */}
      <h3 className="text-[15px] font-extrabold tracking-tight text-text-primary">Which sub-status?</h3>
      <p className="mb-3.5 mt-0.5 text-[12.5px] text-text-secondary">
        Fires only when a job is deliberately given this label — never when it's cleared by a status change.
      </p>

      <div className="flex flex-col gap-0.5" role="radiogroup" aria-label="Which sub-status?">
        {options.map((option) => {
          const selected = value === option.id;
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onPick(option.id)}
              className={`flex items-start gap-2.5 rounded-card border px-2.5 py-2.5 text-left transition-colors ${
                selected ? 'border-primary/15 bg-primary-subtle' : 'border-transparent hover:bg-background-light'
              }`}
            >
              <span
                className={`mt-0.5 flex h-[17px] w-[17px] shrink-0 items-center justify-center rounded-full border-2 ${
                  selected ? 'border-primary' : 'border-text-soft'
                }`}
                aria-hidden
              >
                {selected && <span className="h-2 w-2 rounded-full bg-primary" />}
              </span>
              <span className="min-w-0">
                <span className="block text-[13.5px] font-bold text-text-primary">{option.label}</span>
                <span className="block text-[11.5px] text-text-soft">
                  Under {STATUS_REGISTRY.job[option.parent]?.label ?? option.parent}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
