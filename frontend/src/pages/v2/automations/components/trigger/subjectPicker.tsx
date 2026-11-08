import { useState } from 'react';
import { Briefcase, FileText, Receipt, UserPlus, Search, ChevronRight, ClipboardList } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { Input } from '@/ui-kit/components/ui/input';
import { ENTITY_ORDER } from '@/lib/workflows/entities';
import type { AutomationTriggerType, TriggerDef, WorkflowCatalog } from '@/lib/api/workflows';
import type { BuilderSubject } from '@/lib/workflows/triggerModel';

import { ELLIPSIS, EM_DASH, LDQUO, MIDDOT, RDQUO, RSQUO } from '../glyphs';
import { Pressable } from '../pressable';

/**
 * Step 1 of the two-mode trigger builder. Four subject tiles, each showing a
 * catalog-derived count of that subject's plain-event triggers, plus a search
 * box that matches by name across EVERY subject's triggers and jumps straight
 * to a specific trigger when a result is clicked.
 *
 * The tile label "Leads & Walkthroughs" deliberately differs from the
 * breadcrumb's shorter "Leads" in triggerForm. Both legacy docblocks record
 * that divergence as intentional; it is preserved.
 *
 * The search has NO category filter, so a `timed` or `date` trigger can
 * surface. That is why `triggerForm.pickSubject` re-checks the category before
 * treating a hit as a complete event pick.
 */

const SUBJECT_META: Record<BuilderSubject, { label: string; icon: LucideIcon }> = {
  job: { label: 'Jobs', icon: Briefcase },
  estimate: { label: 'Estimates', icon: FileText },
  invoice: { label: 'Invoices', icon: Receipt },
  lead: { label: 'Leads & Walkthroughs', icon: UserPlus },
  task: { label: 'Tasks', icon: ClipboardList },
};

/** Mirrors the approved mockup's `hits.slice(0,7)` cap on the results list. */
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

  // The tile hint counts plain events only. A `timed` or `date` trigger is not
  // something that "happens"; separating those two is exactly what step 2 is.
  function eventCount(subject: BuilderSubject): number {
    return entries.filter(([, def]) => def.entity === subject && def.category === 'events').length;
  }

  // Grouped by ENTITY_ORDER so results are stable regardless of catalog key order.
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
      <p className="text-[15px] font-extrabold tracking-tight">What is this automation about?</p>
      <p className="text-muted-foreground mb-3.5 mt-0.5 text-[12.5px]">
        {`Pick a subject ${EM_DASH} then you${RSQUO}ll never scroll through a giant list.`}
      </p>

      <div className="mb-3.5">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search all triggers${ELLIPSIS} try ${LDQUO}paid${RDQUO}, ${LDQUO}reminder${RDQUO}, ${LDQUO}completed${RDQUO}`}
          aria-label="Search all triggers"
          startIcon={<Search aria-hidden />}
          className="h-11 text-[13.5px]"
        />
      </div>

      {q ? (
        <div className="flex flex-col gap-1" role="listbox" aria-label="Matching triggers">
          {visibleHits.length === 0 ? (
            /* No className: the kit EmptyState has no density prop, and the
               appearance ratchet on that component sits at its floor, so the
               legacy `density="compact"` becomes the kit's default padding. */
            <EmptyState
              title={`No matches. Try ${LDQUO}completed${RDQUO}, ${LDQUO}paid${RDQUO}, ${LDQUO}reminder${RDQUO}, ${LDQUO}before${RDQUO}.`}
            />
          ) : (
            visibleHits.map((hit) => (
              <Pressable
                key={hit.key}
                role="option"
                aria-selected={false}
                onPress={() => pickHit(hit)}
                className="hover:bg-muted flex items-start gap-2.5 rounded-lg border border-transparent px-2.5 py-2.5 text-left transition-colors"
              >
                <span className="border-subtle-foreground mt-1.5 size-[9px] shrink-0 rounded-full border-2" aria-hidden />
                <span className="min-w-0">
                  <span className="block text-[13.5px] font-bold">{hit.def.label}</span>
                  <span className="text-subtle-foreground block text-[11.5px]">
                    {`${SUBJECT_META[hit.def.entity].label} ${MIDDOT} ${hit.def.description}`}
                  </span>
                </span>
              </Pressable>
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
              <Pressable
                key={subject}
                onPress={() => onPick(subject)}
                className="border-border bg-kit-card hover:border-brand hover:shadow-xs flex items-center gap-2.5 rounded-lg border p-3.5 text-left transition-shadow"
              >
                <span className="bg-brand-subtle text-brand-emphasis flex size-[34px] shrink-0 items-center justify-center rounded-md">
                  <Icon className="size-[18px]" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-extrabold tracking-tight">{meta.label}</span>
                  <span className="text-subtle-foreground block text-[11.5px] font-semibold">
                    {count} event{count === 1 ? '' : 's'}
                  </span>
                </span>
                <ChevronRight className="text-subtle-foreground size-4 shrink-0" aria-hidden />
              </Pressable>
            );
          })}
        </div>
      )}
    </div>
  );
}
