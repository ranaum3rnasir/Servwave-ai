/**
 * SubjectPicker — Step 1 of the two-mode trigger builder ("What is this
 * automation about?"). Four tiles (Jobs / Estimates / Invoices / Leads &
 * Walkthroughs), each showing a catalog-derived count of that subject's
 * plain-event triggers, plus a search box that matches by name across
 * EVERY subject's triggers (not just whichever tile you'd focus next) and
 * jumps straight to a specific trigger when a result is clicked.
 *
 * Mirrors md_files/specs/automations/2026-07-17-timing-builder/index.html's
 * "STAGE 1: subject" screen — heading/subheading, placeholder, tile layout,
 * and the tiles↔results swap while a query is active are copied verbatim
 * from that approved mockup. The mockup's search also surfaces synthetic
 * "before/after {anchor}" date-mode hits; that's dropped here because this
 * component's contract (`onPick(subject, presetTrigger?)`) has no way to
 * hand back "jump to date mode" — only a subject + an optional concrete
 * trigger — so the search here is scoped to real trigger matches only.
 */

import { useState } from 'react';
import { Briefcase, FileText, Receipt, UserPlus, Search, ChevronRight, ClipboardList } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { EmptyState } from '@/components/ui/empty-state';
import { ENTITY_ORDER } from '@/lib/workflows/entities';
import type { AutomationTriggerType, TriggerDef, WorkflowCatalog } from '@/lib/api/workflows';
import type { BuilderSubject } from '@/lib/workflows/triggerModel';

/**
 * Tile label + icon per subject. Not sourced from the catalog: `TriggerDef`
 * only carries a lowercase `entity` key ('job' | 'estimate' | 'invoice' |
 * 'lead'), not a display label, and the brief pins these four display names
 * verbatim (including "Leads & Walkthroughs", which differs from the
 * existing single-mode TriggerForm's shorter "Leads" — that component isn't
 * touched here). Icons reuse TriggerForm.tsx's ENTITY_META choices for
 * visual consistency with the rest of the workflows surface.
 */
const SUBJECT_META: Record<BuilderSubject, { label: string; icon: LucideIcon }> = {
  job: { label: 'Jobs', icon: Briefcase },
  estimate: { label: 'Estimates', icon: FileText },
  invoice: { label: 'Invoices', icon: Receipt },
  lead: { label: 'Leads & Walkthroughs', icon: UserPlus },
  task: { label: 'Tasks', icon: ClipboardList },
};

/** Mirrors the mockup's `hits.slice(0,7)` cap on the results list. */
const MAX_RESULTS = 7;

export interface SubjectPickerProps {
  catalog: WorkflowCatalog;
  onPick: (subject: BuilderSubject, presetTrigger?: AutomationTriggerType) => void;
}

interface TriggerHit {
  key: AutomationTriggerType;
  def: TriggerDef;
}

export default function SubjectPicker({ catalog, onPick }: SubjectPickerProps) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();

  const entries = Object.entries(catalog.triggers) as [AutomationTriggerType, TriggerDef][];

  // The tile hint counts plain events only — a "timed" (BEFORE_JOB_START-style)
  // or "date" (the new *_DATE_ANCHORED) trigger isn't something that "happens";
  // it's exactly what step 2 (ModeFork) separates event mode from date mode for.
  function eventCount(subject: BuilderSubject): number {
    return entries.filter(([, def]) => def.entity === subject && def.category === 'events').length;
  }

  // Search scans every trigger regardless of category — "matches across all
  // triggers" per the brief — grouped by ENTITY_ORDER so results are stable
  // regardless of catalog key order (mirrors the mockup's subject-then-event
  // nested loop).
  const hits: TriggerHit[] = [];
  if (q) {
    ENTITY_ORDER.forEach((subject) => {
      entries
        .filter(([, def]) => def.entity === subject)
        .forEach(([key, def]) => {
          const haystack = `${def.label} ${def.description} ${SUBJECT_META[subject].label}`.toLowerCase();
          if (haystack.includes(q)) hits.push({ key, def });
        });
    });
  }
  const visibleHits = hits.slice(0, MAX_RESULTS);

  function pickHit(hit: TriggerHit) {
    setQuery('');
    onPick(hit.def.entity, hit.key);
  }

  return (
    <div>
      {/* Raw h3, deferred: text-[15px] has no matching Heading scale key, and
          font-extrabold has no matching Heading weight (semibold/bold only). */}
      <h3 className="text-[15px] font-extrabold tracking-tight text-text-primary">What is this automation about?</h3>
      <p className="mb-3.5 mt-0.5 text-[12.5px] text-text-secondary">
        Pick a subject — then you’ll never scroll through a giant list.
      </p>

      <div className="relative mb-3.5">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-soft" aria-hidden />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search all triggers… try “paid”, “reminder”, “completed”"
          aria-label="Search all triggers"
          className="h-11 pl-9 text-[13.5px]"
        />
      </div>

      {q ? (
        <div className="flex flex-col gap-1" role="listbox" aria-label="Matching triggers">
          {visibleHits.length === 0 ? (
            <EmptyState density="compact" title="No matches. Try “completed”, “paid”, “reminder”, “before”." />
          ) : (
            visibleHits.map((hit) => (
              // Deferred: a listbox option row (role="option", full-width,
              // dot indicator + two-line label) - a list-row click target,
              // not a CTA button.
              <button
                key={hit.key}
                type="button"
                role="option"
                aria-selected={false}
                onClick={() => pickHit(hit)}
                className="flex items-start gap-2.5 rounded-card border border-transparent px-2.5 py-2.5 text-left transition-colors hover:bg-background-light"
              >
                <span className="mt-1.5 h-[9px] w-[9px] shrink-0 rounded-full border-2 border-text-soft" aria-hidden />
                <span className="min-w-0">
                  <span className="block text-[13.5px] font-bold text-text-primary">{hit.def.label}</span>
                  <span className="block text-[11.5px] text-text-soft">
                    {SUBJECT_META[hit.def.entity].label} · {hit.def.description}
                  </span>
                </span>
              </button>
            ))
          )}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2.5">
          {ENTITY_ORDER.map((subject) => {
            const meta = SUBJECT_META[subject];
            const Icon = meta.icon;
            const count = eventCount(subject);
            return (
              // Deferred: a subject tile card (icon tile + title + count +
              // trailing chevron) - a card/tile click target, not a CTA any
              // Button cell is shaped for.
              <button
                key={subject}
                type="button"
                onClick={() => onPick(subject)}
                className="flex items-center gap-2.5 rounded-card border border-border bg-surface-light p-3.5 text-left transition-shadow hover:-translate-y-px hover:border-primary-light hover:shadow-card"
              >
                <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-ic bg-primary-subtle text-primary">
                  <Icon className="h-[18px] w-[18px]" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-extrabold tracking-tight text-text-primary">{meta.label}</span>
                  <span className="block text-[11.5px] font-semibold text-text-soft">
                    {count} event{count === 1 ? '' : 's'}
                  </span>
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-text-soft" aria-hidden />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
