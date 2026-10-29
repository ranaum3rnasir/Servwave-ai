import { Zap, Pencil } from 'lucide-react';

import { cn } from '@/ui-kit/lib/utils';
import { describeWorkflow } from '@/lib/workflows/describeWorkflow';
import type { AutomationTriggerType, WorkflowCatalog } from '@/lib/api/workflows';
import type { TriggerConfig } from '@/lib/workflows/triggerModel';

import { Pressable } from './pressable';

/**
 * The fixed origin bubble at the top of the spine, never sortable. Solid brand
 * fill, inverted content so it reads as the source, a "Starts here" cap, the
 * plain-English trigger sentence, and a bottom port docking it to the rail.
 * Clicking opens the drawer in trigger mode.
 *
 * The `Edit trigger: {title}` accessible name is a live selector surface: the
 * existing builder spec queries `/Edit trigger/`,
 * `/Edit trigger: Choose what starts this automation/` and
 * `/Edit trigger: When a job is scheduled/`. It must survive verbatim.
 */
export interface TriggerNodeProps {
  triggerType: AutomationTriggerType;
  triggerConfig: TriggerConfig | null;
  /**
   * False only for a brand-new draft whose `triggerType` is still an unseen
   * placeholder: show a neutral prompt instead of describing it as a real pick.
   * Defaults true so every other caller, a loaded workflow, is unaffected.
   */
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
  const title = triggerConfigured
    ? describeWorkflow(triggerType, triggerConfig, [], catalog)
    : 'Choose what starts this automation';
  const description = triggerConfigured ? catalog?.triggers[triggerType]?.description : undefined;

  return (
    <div className="relative w-full max-w-[468px]">
      <span className="border-border bg-kit-card text-brand-emphasis shadow-xs absolute -top-2.5 left-4 z-10 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[10.5px] font-bold uppercase tracking-wide">
        <span className="bg-brand size-1.5 rounded-full" aria-hidden />
        Starts here
      </span>
      <Pressable
        onPress={onSelect}
        aria-label={`Edit trigger: ${title}`}
        className={cn(
          'bg-primary text-primary-foreground border-primary shadow-md flex w-full items-start gap-3 rounded-lg border p-4 text-left transition-shadow',
          selected && 'ring-primary-foreground/70 ring-2 ring-offset-2',
        )}
      >
        <span className="bg-primary-foreground/15 flex size-11 shrink-0 items-center justify-center rounded-md">
          <Zap className="size-5" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="text-primary-foreground/60 block text-[10.5px] font-bold uppercase tracking-[0.09em]">
            Trigger
          </span>
          <span className="mt-0.5 block truncate text-[15px] font-bold tracking-tight">{title}</span>
          {description && (
            <span className="text-primary-foreground/70 mt-1 block text-xs leading-snug">{description}</span>
          )}
        </span>
        <span className="text-primary-foreground/70 flex items-center gap-1 text-xs font-semibold">
          <Pencil className="size-3.5" aria-hidden />
        </span>
      </Pressable>
      {/* bottom port, docks the trigger to the rail */}
      <span
        className="border-primary-foreground/40 bg-primary absolute -bottom-[5px] left-1/2 z-10 size-[9px] -translate-x-1/2 rounded-full border-2"
        aria-hidden
      />
    </div>
  );
}
