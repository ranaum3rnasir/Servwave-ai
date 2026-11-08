/**
 * BuilderSpine — the vertical "movable bubbles on rails". A fixed TriggerNode
 * caps the top; a dnd-kit SortableContext of StepNodes hangs below, connected by
 * a single 2px rail with a circular `+` between every pair (and a "Add a step"
 * at the tail). Position = array index, always — dragging only reorders. Every
 * drag has a kebab / keyboard equivalent (dnd-kit KeyboardSensor + the StepNode
 * menu). Empty flow shows one friendly "Add your first step" bubble, never a
 * blank canvas.
 */

import { Fragment, useState } from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable';
import TriggerNode from './TriggerNode';
import StepNode from './StepNode';
import AddStepButton from './AddStepButton';
import { lockedStepTypesFor } from '@/lib/workflows/featureFlags';
import type { WorkflowDraftState } from './useWorkflowDraft';
import type { ValidationIssue, WorkflowCatalog, WorkflowStepType } from '@/lib/api/workflows';

export interface BuilderSpineProps {
  draft: WorkflowDraftState;
  catalog?: WorkflowCatalog;
  issuesByStepIndex: Map<number, ValidationIssue[]>;
  onSelectTrigger: () => void;
  onSelectStep: (uid: string) => void;
  onAddStep: (type: WorkflowStepType, atIndex?: number) => void;
  onMoveStep: (from: number, to: number) => void;
  onRemoveStep: (uid: string) => void;
}

/** A rail segment with a centred `+` insert button. */
function Rail({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex h-11 w-full items-center justify-center">
      <span className="absolute left-1/2 top-0 h-full w-0.5 -translate-x-1/2 bg-border" aria-hidden />
      <div className="relative z-10">{children}</div>
    </div>
  );
}

/** A plain rail segment (no insert) — leads into the tail / empty state. */
function RailLine() {
  return (
    <div className="relative h-6 w-full">
      <span className="absolute left-1/2 top-0 h-full w-0.5 -translate-x-1/2 bg-border" aria-hidden />
    </div>
  );
}

export default function BuilderSpine({
  draft,
  catalog,
  issuesByStepIndex,
  onSelectTrigger,
  onSelectStep,
  onAddStep,
  onMoveStep,
  onRemoveStep,
}: BuilderSpineProps) {
  const { steps, selectedUid } = draft;
  const [activeUid, setActiveUid] = useState<string | null>(null);
  const [overUid, setOverUid] = useState<string | null>(null);
  // Per-org and nothing else: a text step reaches every audience an email does, so the
  // workflow's subject no longer narrows what can be authored (see featureFlags.ts).
  const lockedTypes = lockedStepTypesFor(catalog);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragStart(e: DragStartEvent) {
    setActiveUid(String(e.active.id));
  }
  function handleDragOver(e: DragOverEvent) {
    setOverUid(e.over ? String(e.over.id) : null);
  }
  function handleDragEnd(e: DragEndEvent) {
    setActiveUid(null);
    setOverUid(null);
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = steps.findIndex((s) => s.uid === active.id);
    const to = steps.findIndex((s) => s.uid === over.id);
    if (from >= 0 && to >= 0) onMoveStep(from, to);
  }
  function handleDragCancel() {
    setActiveUid(null);
    setOverUid(null);
  }

  return (
    <div className="flex flex-col items-center pt-2">
      <TriggerNode
        triggerType={draft.trigger_type}
        triggerConfig={draft.trigger_config}
        triggerConfigured={draft.triggerConfigured}
        catalog={catalog}
        selected={selectedUid === 'trigger'}
        onSelect={onSelectTrigger}
      />

      {steps.length === 0 ? (
        <>
          <RailLine />
          <AddStepButton variant="first" onPick={(t) => onAddStep(t, 0)} lockedTypes={lockedTypes} />
        </>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
          onDragCancel={handleDragCancel}
        >
          <Rail>
            <AddStepButton onPick={(t) => onAddStep(t, 0)} label="Insert a step at the top" lockedTypes={lockedTypes} />
          </Rail>

          <SortableContext items={steps.map((s) => s.uid)} strategy={verticalListSortingStrategy}>
            {steps.map((step, i) => (
              <Fragment key={step.uid}>
                <StepNode
                  step={step}
                  index={i}
                  total={steps.length}
                  catalog={catalog}
                  selected={selectedUid === step.uid}
                  issues={(issuesByStepIndex.get(i) ?? []).map((issue) => issue.message)}
                  dropTarget={Boolean(activeUid) && overUid === step.uid && activeUid !== step.uid}
                  onSelect={() => onSelectStep(step.uid)}
                  onMoveUp={() => onMoveStep(i, i - 1)}
                  onMoveDown={() => onMoveStep(i, i + 1)}
                  onDelete={() => onRemoveStep(step.uid)}
                />
                {i < steps.length - 1 ? (
                  <Rail>
                    <AddStepButton
                      onPick={(t) => onAddStep(t, i + 1)}
                      label={`Insert a step after step ${i + 1}`}
                      lockedTypes={lockedTypes}
                    />
                  </Rail>
                ) : (
                  <RailLine />
                )}
              </Fragment>
            ))}
          </SortableContext>

          <AddStepButton variant="block" onPick={(t) => onAddStep(t)} label="Add a step" lockedTypes={lockedTypes} />
        </DndContext>
      )}

      <p className="mt-3.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-text-secondary/70">
        <span className="h-px w-6 bg-border" aria-hidden />
        End of automation
        <span className="h-px w-6 bg-border" aria-hidden />
      </p>
    </div>
  );
}
