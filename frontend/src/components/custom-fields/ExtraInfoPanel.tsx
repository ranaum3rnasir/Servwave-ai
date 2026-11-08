import { useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/jobs/overview/SectionCard';
import { useCustomFieldDefinitions, type CustomFieldEntityType } from '@/lib/api/customFieldDefinitions';

// ─── Types ─────────────────────────────────────────────────────────────────────

interface ExtraInfoPanelProps {
  entityType: CustomFieldEntityType;
  /** Identifies the row being edited. Drives the remount key, so switching rows
   *  drops any in-progress edit instead of carrying it onto the next entity. */
  entityId: string;
  values: Record<string, unknown>;
  onSave: (patch: Record<string, unknown>) => Promise<unknown>;
  /**
   * How much chrome the panel draws around itself. The three detail pages do NOT
   * share a card system:
   *  - 'card'  - a SectionCard, matching the Job Command Center's column of cards.
   *  - 'plain' - a bare bordered section, matching the single-unified-card layout
   *              the Lead and Customer pages use, where a nested card would read as
   *              a card inside a card.
   * Slice 5's dialog host (price-book items have no detail page) is the third
   * consumer of 'plain'.
   */
  variant?: 'card' | 'plain';
  className?: string;
}

// ─── Component ─────────────────────────────────────────────────────────────────

/**
 * Generic "Extra Info" panel for an entity's custom-field values. Only TEXT is
 * rendered so far - every definition gets a plain Input regardless of its `type`,
 * since TEXT is the only type any org can define until slice 2.
 * Absent (renders null), not an empty container, when the org has defined no fields
 * for this entity type - most orgs, most of the time.
 */
export function ExtraInfoPanel(props: ExtraInfoPanelProps) {
  // Keyed on the entity so pointing the panel at a different row remounts it, dropping
  // any in-progress edits. That reset costs no effect, which the
  // `react-hooks/set-state-in-effect` lint rule forbids anyway.
  return <ExtraInfoPanelBody key={`${props.entityType}:${props.entityId}`} {...props} />;
}

function ExtraInfoPanelBody({ entityType, values, onSave, variant = 'card', className }: ExtraInfoPanelProps) {
  const { data: definitions, isLoading } = useCustomFieldDefinitions(entityType);
  // SPARSE - holds only the fields the user has actually touched. Everything else falls
  // through to the `values` prop at render time, so there is no seeding step to run, and
  // an unrelated mutation elsewhere on the page that invalidates and refetches the parent
  // entity refreshes the untouched fields without clobbering an in-progress edit.
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [justSaved, setJustSaved] = useState(false);

  const valueFor = (definitionId: string): string => {
    const edited = edits[definitionId];
    if (edited !== undefined) return edited;
    const stored = values[definitionId];
    return stored == null ? '' : String(stored);
  };

  // No onError here - `onSave` is the caller's OWN useMutation-backed callback (see
  // JobDetailPage's customFieldsMutation), which already owns the failure toast. Adding one
  // here too would double it: React Query fires a useMutation's onError whenever ITS OWN
  // execution fails, whether invoked via mutate() or mutateAsync() - awaiting/wrapping the
  // inner mutation does not suppress the inner mutation's own callback.
  const saveMutation = useMutation({
    mutationFn: (patch: Record<string, unknown>) => onSave(patch),
    onSuccess: () => {
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 2000);
    },
  });

  // Absent while loading (avoids a layout flash for what is usually an empty,
  // no-fields org) and absent once loaded with zero definitions - not broken, absent.
  if (isLoading || !definitions || definitions.length === 0) return null;

  // Rebind to a fresh const so the narrowing above survives inside handleSave's
  // closure (TS discards it for the original destructured `definitions` binding).
  const fieldDefinitions = definitions;

  function handleSave() {
    const patch: Record<string, unknown> = {};
    for (const definition of fieldDefinitions) {
      patch[definition.id] = valueFor(definition.id);
    }
    saveMutation.mutate(patch);
  }

  const body: ReactNode = (
    <>
      {fieldDefinitions.map((definition) => (
        <div key={definition.id} className="space-y-1">
          <Label htmlFor={`extra-info-${definition.id}`}>{definition.label}</Label>
          <Input
            id={`extra-info-${definition.id}`}
            value={valueFor(definition.id)}
            onChange={(e) =>
              setEdits((prev) => ({ ...prev, [definition.id]: e.target.value }))
            }
          />
        </div>
      ))}
      <div className="flex items-center justify-end gap-2">
        {justSaved && <span className="text-xs text-success">Saved</span>}
        <Button
          type="button"
          variant="solid"
          tone="business"
          size="sm"
          disabled={saveMutation.isPending}
          onClick={handleSave}
        >
          {saveMutation.isPending ? 'Saving...' : 'Save'}
        </Button>
      </div>
    </>
  );

  if (variant === 'plain') {
    return (
      <div className={cn('border-t border-border p-5 space-y-4', className)}>
        {/* Eyebrow style matched to the sibling sections on the Lead and Customer pages;
            no Heading variant covers it, same as those call sites. */}
        <h2 className="text-xs font-semibold text-text-secondary uppercase tracking-wide">Extra Info</h2>
        {body}
      </div>
    );
  }

  return (
    <SectionCard title="Extra Info" bodyClassName="space-y-4" className={className}>
      {body}
    </SectionCard>
  );
}
