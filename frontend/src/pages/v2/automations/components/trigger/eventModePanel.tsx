import { cn } from '@/ui-kit/lib/utils';
import type { AutomationTriggerType, TriggerDef, WorkflowCatalog } from '@/lib/api/workflows';
import type { BuilderSubject } from '@/lib/workflows/triggerModel';

import { ELLIPSIS } from '../glyphs';
import { Pressable } from '../pressable';

/**
 * Step 3, event branch. The subject's plain event triggers, rendered as a
 * single-select radio list.
 *
 * Label and description come verbatim from the catalog and are never
 * hardcoded, so the list always matches whatever the backend TRIGGERS registry
 * currently defines. `timed` and `date` triggers are excluded by contract.
 *
 * There is no empty state: a subject with zero event triggers would render
 * nothing. Not observed in the real catalog, and reproduced as-is.
 */
export interface EventModePanelProps {
  subject: BuilderSubject;
  catalog: WorkflowCatalog;
  value?: AutomationTriggerType;
  onPick: (t: AutomationTriggerType) => void;
}

interface EventOption {
  key: AutomationTriggerType;
  def: TriggerDef;
}

export default function EventModePanel({ subject, catalog, value, onPick }: EventModePanelProps) {
  const heading = `When this happens${ELLIPSIS}`;
  const options: EventOption[] = (Object.entries(catalog.triggers) as [AutomationTriggerType, TriggerDef][])
    .filter(([, def]) => def.entity === subject && def.category === 'events')
    .map(([key, def]) => ({ key, def }));

  return (
    <div>
      <p className="text-[15px] font-extrabold tracking-tight">{heading}</p>
      <p className="text-muted-foreground mb-3.5 mt-0.5 text-[12.5px]">
        The automation fires the moment this occurs.
      </p>

      <div className="flex flex-col gap-0.5" role="radiogroup" aria-label={heading}>
        {options.map(({ key, def }) => {
          const selected = value === key;
          return (
            <Pressable
              key={key}
              role="radio"
              aria-checked={selected}
              onPress={() => onPick(key)}
              className={cn(
                'flex items-start gap-2.5 rounded-lg border px-2.5 py-2.5 text-left transition-colors',
                selected ? 'border-brand-subtle bg-brand-subtle' : 'hover:bg-muted border-transparent',
              )}
            >
              <span
                className={cn(
                  'mt-0.5 flex size-[17px] shrink-0 items-center justify-center rounded-full border-2',
                  selected ? 'border-brand' : 'border-subtle-foreground',
                )}
                aria-hidden
              >
                {selected && <span className="bg-brand size-2 rounded-full" />}
              </span>
              <span className="min-w-0">
                <span className="block text-[13.5px] font-bold">{def.label}</span>
                <span className="text-subtle-foreground block text-[11.5px]">{def.description}</span>
              </span>
            </Pressable>
          );
        })}
      </div>
    </div>
  );
}
