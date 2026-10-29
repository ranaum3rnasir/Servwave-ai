/**
 * MergeFieldChips — the tap-to-insert merge-field row. One chip per field the
 * trigger exposes (`TRIGGERS[trigger].mergeFields`), labelled from the catalog.
 * Clicking writes `{{field}}` into the focused text field for the office — the
 * raw token is never something they have to type. A chip already referenced in
 * the copy reads as "in use" (checked + filled) so the highlight state tracks
 * the body; identity is icon + fill + `aria-pressed`, never colour alone.
 *
 * Chips are grouped into collapsible per-entity sections (Ran's "Option A",
 * 2026-07-16) so the wall of chips doesn't grow unbounded as more trigger
 * fields ship. Groups collapse by default except the trigger's primary entity
 * group, which starts expanded — see `defaultOpenGroup` for the derivation.
 */

import { useState } from 'react';
import { Check, ChevronDown, ChevronRight, Plus } from 'lucide-react';
import type { WorkflowCatalog } from '@/lib/api/workflows';

export interface MergeFieldChipsProps {
  fields: string[];
  used: Set<string>;
  catalog?: WorkflowCatalog;
  onInsert: (field: string) => void;
}

export interface FieldGroup {
  label: string;
  fields: string[];
}

/** Field-name prefix → section label. New merge fields need an entry here. */
const FIELD_GROUPS: Record<string, string> = {
  'org.': 'Company',
  'customer.': 'Customer',
  'job.': 'Job',
  'technician.': 'Job',
  'estimate.': 'Estimate',
  'invoice.': 'Invoice',
  'lead.': 'Lead & walkthrough',
  'task.': 'Task',
};

/** Company + Customer ship on every trigger's BASE fields — never a trigger's "primary" entity. */
const BASE_GROUP_LABELS = new Set(['Company', 'Customer']);

/**
 * Buckets `fields` by FIELD_GROUPS prefix, preserving canonical group order
 * (Company → Customer → Job → Estimate → Invoice → Lead & walkthrough → Task) with
 * empty groups skipped. A field matching no known prefix lands in a trailing
 * "Other" group instead of silently vanishing from the picker.
 */
export function groupFields(fields: string[]): FieldGroup[] {
  const order = [...new Set(Object.values(FIELD_GROUPS)), 'Other'];
  const buckets = new Map<string, string[]>();
  for (const field of fields) {
    const entry = Object.entries(FIELD_GROUPS).find(([prefix]) => field.startsWith(prefix));
    const label = entry?.[1] ?? 'Other';
    if (!buckets.has(label)) buckets.set(label, []);
    buckets.get(label)!.push(field);
  }
  return order.filter((label) => buckets.has(label)).map((label) => ({ label, fields: buckets.get(label)! }));
}

/**
 * Which group starts expanded. Ideally the trigger's primary entity — but the
 * trigger type isn't threaded into this component, so it's approximated: the
 * first non-base group with an already-used field, else the first non-base
 * group outright (every real trigger contributes exactly one). Base groups
 * (Company/Customer) never start expanded — they're on every trigger, so
 * they're never the "primary" one.
 */
function defaultOpenGroup(groups: FieldGroup[], used: Set<string>): string | undefined {
  const withUsedField = groups.find((g) => !BASE_GROUP_LABELS.has(g.label) && g.fields.some((f) => used.has(f)));
  if (withUsedField) return withUsedField.label;
  return groups.find((g) => !BASE_GROUP_LABELS.has(g.label))?.label ?? groups[0]?.label;
}

export default function MergeFieldChips({ fields, used, catalog, onInsert }: MergeFieldChipsProps) {
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
      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">Insert a field</p>
      <div className="space-y-0.5">
        {groups.map((group) => {
          const isOpen = open.has(group.label);
          return (
            <div key={group.label}>
              {/* Deferred: a disclosure/accordion row toggle (chevron + label
                  + count, full-width, no CTA-shaped bg/border), not a Button
                  cell - and its 6px `rounded` corner can't be safely swapped
                  for Button's baked-in `rounded-button` (14px) via className,
                  since tailwind-merge has no conflict group for that custom
                  radius key (see button.tsx's own SIZE RUNGS note). */}
              <button
                type="button"
                onClick={() => toggleGroup(group.label)}
                aria-expanded={isOpen}
                aria-label={`${group.label} (${group.fields.length})`}
                className="flex w-full items-center gap-1.5 rounded px-0.5 py-1 text-left hover:bg-background-light"
              >
                {isOpen ? (
                  <ChevronDown className="h-3 w-3 shrink-0 text-text-secondary" aria-hidden />
                ) : (
                  <ChevronRight className="h-3 w-3 shrink-0 text-text-secondary" aria-hidden />
                )}
                <span className="text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
                  {group.label}
                </span>
                <span className="ml-auto text-[11px] font-medium text-text-soft">{group.fields.length}</span>
              </button>
              {isOpen && (
                <div className="flex flex-wrap gap-1.5 py-1 pl-4">
                  {group.fields.map((field) => {
                    const label = catalog?.merge_field_labels[field] ?? field;
                    const isUsed = used.has(field);
                    return (
                      // Deferred: a rounded-pill toggle chip with two full
                      // visual states (used/unused), not Button vocabulary -
                      // no chip/toggle cell exists in the variant grid.
                      <button
                        key={field}
                        type="button"
                        onClick={() => onInsert(field)}
                        aria-pressed={isUsed}
                        title={`{{${field}}}`}
                        className={`inline-flex min-h-11 items-center gap-1 rounded-pill border px-3 py-1.5 text-[12px] font-semibold transition-colors ${
                          isUsed
                            ? 'border-primary bg-primary-subtle text-primary'
                            : 'border-border bg-surface-light text-text-secondary hover:border-primary/40 hover:text-text-primary'
                        }`}
                      >
                        {isUsed ? <Check className="h-3 w-3" aria-hidden /> : <Plus className="h-3 w-3" aria-hidden />}
                        {label}
                      </button>
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
