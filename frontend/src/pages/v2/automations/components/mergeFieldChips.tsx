import { useId, useState } from 'react';
import { Check, ChevronDown, ChevronRight, PenLine, Plus } from 'lucide-react';

import { Button } from '@/ui-kit/components/ui/button';
import { Input } from '@/ui-kit/components/ui/input';
import { Label } from '@/ui-kit/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui-kit/components/ui/popover';
import { cn } from '@/ui-kit/lib/utils';
import { groupFields, type FieldGroup } from '@/components/workflows/MergeFieldChips';
import type { WorkflowCatalog } from '@/lib/api/workflows';

/**
 * The tap-to-insert merge-field row, grouped into collapsible per-entity
 * sections so the wall of chips does not grow unbounded as more trigger fields
 * ship.
 *
 * `groupFields` is imported from the legacy component rather than copied. It is
 * the prefix-to-section map plus the canonical group order, it is exported and
 * unit-tested there, and a second copy would silently drift the day a new merge
 * field lands.
 *
 * Each section toggle is named `{label} ({count})`; the existing spec queries
 * those by accessible name.
 *
 * "If empty, fill with" (2026-09-13 scheduling-notifications spec): each chip
 * carries a small trailing icon. It opens a compact popover holding exactly the
 * header and one single-line text field, the words that field renders when it
 * has no value. The chip's own click still inserts; the icon is its own button
 * so the two never share a click.
 */

/** Company and Customer ship on every trigger, so they are never a trigger's primary entity. */
const BASE_GROUP_LABELS = new Set(['Company', 'Customer']);

export interface MergeFieldChipsProps {
  fields: string[];
  used: Set<string>;
  catalog?: WorkflowCatalog;
  onInsert: (field: string) => void;
  /** Current "If empty, fill with" text per field; the form owns it. */
  fallbacks?: Record<string, string>;
  /** Fires on every keystroke in a chip's popover with the field key and the new text. */
  onFallbackChange?: (field: string, value: string) => void;
}

/** Exactly the popover the spec describes: the header and one text field, nothing else. */
function FallbackPopover({
  field,
  label,
  value,
  onChange,
}: {
  field: string;
  label: string;
  value: string;
  onChange: (field: string, value: string) => void;
}) {
  const inputId = useId();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={`${label}: if empty, fill with`}
          className="text-muted-foreground hover:text-foreground h-auto min-h-11 w-8 rounded-none rounded-r-full border-l border-input"
        >
          <PenLine aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-3 duration-150">
        <Label htmlFor={inputId} className="mb-1.5 block text-xs font-semibold">
          If empty, fill with
        </Label>
        <Input
          id={inputId}
          value={value}
          maxLength={120}
          onChange={(e) => onChange(field, e.target.value)}
          className="h-9"
        />
      </PopoverContent>
    </Popover>
  );
}

/**
 * Which group starts expanded. Ideally the trigger's primary entity, but the
 * trigger type is not threaded in, so it is approximated: the first non-base
 * group with an already-used field, else the first non-base group outright.
 */
function defaultOpenGroup(groups: FieldGroup[], used: Set<string>): string | undefined {
  const withUsedField = groups.find((g) => !BASE_GROUP_LABELS.has(g.label) && g.fields.some((f) => used.has(f)));
  if (withUsedField) return withUsedField.label;
  return groups.find((g) => !BASE_GROUP_LABELS.has(g.label))?.label ?? groups[0]?.label;
}

export default function MergeFieldChips({
  fields,
  used,
  catalog,
  onInsert,
  fallbacks,
  onFallbackChange,
}: MergeFieldChipsProps) {
  const groups = groupFields(fields);
  const [open, setOpen] = useState<Set<string>>(() => {
    const primary = defaultOpenGroup(groups, used);
    return new Set(primary ? [primary] : []);
  });

  if (fields.length === 0) return null;

  const toggleGroup = (label: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  };

  return (
    <div>
      <p className="text-muted-foreground mb-1.5 text-[11px] font-semibold uppercase tracking-wide">Insert a field</p>
      <div className="space-y-0.5">
        {groups.map((group) => {
          const isOpen = open.has(group.label);
          return (
            <div key={group.label}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => toggleGroup(group.label)}
                aria-expanded={isOpen}
                aria-label={`${group.label} (${group.fields.length})`}
                className="w-full justify-start gap-1.5 rounded-md px-0.5 text-left"
              >
                {isOpen ? (
                  <ChevronDown className="shrink-0" aria-hidden />
                ) : (
                  <ChevronRight className="shrink-0" aria-hidden />
                )}
                <span className="text-[11px] font-semibold uppercase tracking-wide">{group.label}</span>
                <span className="text-subtle-foreground ml-auto text-[11px] font-medium">{group.fields.length}</span>
              </Button>
              {isOpen && (
                <div className="flex flex-wrap gap-1.5 py-1 pl-4">
                  {group.fields.map((field) => {
                    const label = catalog?.merge_field_labels[field] ?? field;
                    const isUsed = used.has(field);
                    return (
                      <span
                        key={field}
                        className={cn(
                          'inline-flex items-stretch overflow-hidden rounded-full border',
                          isUsed ? 'border-brand bg-brand-subtle' : 'border-input hover:border-brand',
                        )}
                      >
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={() => onInsert(field)}
                          aria-pressed={isUsed}
                          title={`{{${field}}}`}
                          className={cn(
                            'h-auto min-h-11 gap-1 rounded-none px-3 text-[12px] font-semibold',
                            isUsed ? 'text-brand-emphasis' : 'text-muted-foreground hover:text-foreground',
                          )}
                        >
                          {isUsed ? <Check aria-hidden /> : <Plus aria-hidden />}
                          {label}
                        </Button>
                        {onFallbackChange && (
                          <FallbackPopover
                            field={field}
                            label={label}
                            value={fallbacks?.[field] ?? ''}
                            onChange={onFallbackChange}
                          />
                        )}
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
