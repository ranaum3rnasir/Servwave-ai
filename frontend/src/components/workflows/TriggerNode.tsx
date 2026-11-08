/**
 * TriggerNode — the fixed origin bubble at the top of the spine (never
 * sortable). Solid ocean, inverted (white on ocean) so it visibly reads as the
 * source; a "Starts here" cap, the plain-English "When …" sentence, and a
 * single bottom port docking it to the rail. Clicking opens the drawer in
 * trigger mode (Task 14 fills the trigger picker).
 */

import { Zap, Pencil } from 'lucide-react';
import { describeWorkflow } from '@/lib/workflows/describeWorkflow';
import type { AutomationTriggerType, WorkflowCatalog } from '@/lib/api/workflows';
import type { TriggerConfig } from '@/lib/workflows/triggerModel';

export interface TriggerNodeProps {
  triggerType: AutomationTriggerType;
  triggerConfig: TriggerConfig | null;
  /** False only for a brand-new draft whose trigger_type is still an unseen
   *  placeholder — show a neutral prompt instead of describing it as a real
   *  pick. Defaults true so every other caller (a loaded workflow) is unaffected. */
  triggerConfigured?: boolean;
  catalog?: WorkflowCatalog;
  selected: boolean;
  onSelect: () => void;
}

export default function TriggerNode({
  triggerType,
  triggerConfig,
  triggerConfigured = true,
  catalog,
  selected,
  onSelect,
}: TriggerNodeProps) {
  const title = triggerConfigured ? describeWorkflow(triggerType, triggerConfig, [], catalog) : 'Choose what starts this automation';
  const description = triggerConfigured ? catalog?.triggers[triggerType]?.description : undefined;

  return (
    <div className="relative w-full max-w-[468px]">
      <span className="absolute -top-2.5 left-4 z-10 inline-flex items-center gap-1.5 rounded-pill border border-border bg-surface-light px-2.5 py-0.5 text-[10.5px] font-bold uppercase tracking-wide text-primary shadow-card">
        <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-hidden />
        Starts here
      </span>
      {/* Deferred: a card-shaped click target wrapping rich multi-line
          content (icon tile, eyebrow, title, description) with a gradient
          background and a custom on-dark focus-ring offset colour - a
          list-row/node click target, not a CTA any Button cell is shaped for. */}
      <button
        type="button"
        onClick={onSelect}
        aria-label={`Edit trigger: ${title}`}
        className={`flex w-full items-start gap-3 rounded-card border border-primary-dark bg-gradient-to-b from-primary to-primary-dark p-4 text-left shadow-hover transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-on-fill focus-visible:ring-offset-2 focus-visible:ring-offset-primary-dark ${
          selected ? 'ring-2 ring-on-fill ring-offset-2 ring-offset-primary-dark' : ''
        }`}
      >
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-ic bg-on-fill/15">
          <Zap className="h-5 w-5 text-on-fill" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[10.5px] font-bold uppercase tracking-[0.09em] text-on-fill/60">Trigger</span>
          <span className="mt-0.5 block truncate text-[15px] font-bold tracking-tight text-on-fill">{title}</span>
          {description && <span className="mt-1 block text-xs leading-snug text-on-fill/70">{description}</span>}
        </span>
        <span className="flex items-center gap-1 text-xs font-semibold text-on-fill/70">
          <Pencil className="h-3.5 w-3.5" aria-hidden />
        </span>
      </button>
      {/* bottom port — docks the trigger to the rail */}
      <span
        className="absolute -bottom-[5px] left-1/2 z-10 h-[9px] w-[9px] -translate-x-1/2 rounded-full border-2 border-primary-light bg-primary-dark"
        aria-hidden
      />
    </div>
  );
}
