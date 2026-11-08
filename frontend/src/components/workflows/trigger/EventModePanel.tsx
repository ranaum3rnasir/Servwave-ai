/**
 * EventModePanel — Step 3 of the two-mode trigger builder's event branch
 * ("When this happens…"), shown once a subject (SubjectPicker) and event
 * mode (ModeFork) are chosen. Renders the subject's plain event triggers
 * (catalog `category === 'events'`) as a single-select radio list — label +
 * description sourced verbatim from the catalog (never hardcoded copy), so
 * it always matches whatever the backend TRIGGERS registry (backend/src/
 * services/automations/catalog.ts) currently defines for that subject.
 *
 * Mirrors md_files/specs/automations/2026-07-17-timing-builder/index.html's
 * "STAGE 3a: event pick" screen — the heading, subheading, and the `.opts`/
 * `.opt`/`.dot`/`.ol`/`.oc` radio-row layout are copied verbatim from that
 * approved mockup (the same visual language SubjectPicker's search-hit list
 * already translated to Tailwind; this component adds the persistent
 * checked state that list never needed, plus a filled dot center for it).
 * The mockup's stage also has a "…then wait" delay sub-section below the
 * list — intentionally NOT built here: `TriggerSelection` (triggerModel.ts)
 * has no wait-related field and this component's props carry no wait
 * callback, so that piece is outside this component's contract.
 *
 * Deliberate deviation from the task brief's Step 1 illustration, flagged
 * here rather than silently guessed: the brief's example lists three invoice
 * options including "Invoice is overdue". The real catalog (confirmed in
 * backend/src/services/automations/catalog.ts, and already encoded the same
 * way in SubjectPicker.test.tsx's fixture) marks `INVOICE_OVERDUE` as
 * `category: 'timed'`, not `'events'` — it's the legacy bare-offset trigger
 * superseded by `INVOICE_DATE_ANCHORED` (date mode), which is exactly the
 * case this component's own contract says to exclude ("Timed triggers...
 * are excluded — they are legacy and superseded by date mode"). This
 * component follows that rule and the real catalog, so the invoice list
 * renders two options (Invoice is sent, Invoice is paid), not three — see
 * the task report for the full discrepancy note. The brief's illustration
 * appears to have been transcribed from this same standalone HTML mockup's
 * static `SUBJECTS.invoices.events` array, which predates the backend's
 * events/timed/date category split.
 */

import type { AutomationTriggerType, TriggerDef, WorkflowCatalog } from '@/lib/api/workflows';
import type { BuilderSubject } from '@/lib/workflows/triggerModel';

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
  const options: EventOption[] = (Object.entries(catalog.triggers) as [AutomationTriggerType, TriggerDef][])
    .filter(([, def]) => def.entity === subject && def.category === 'events')
    .map(([key, def]) => ({ key, def }));

  return (
    <div>
      {/* Raw h3, deferred: text-[15px] has no matching Heading scale key, and
          font-extrabold has no matching Heading weight (semibold/bold only). */}
      <h3 className="text-[15px] font-extrabold tracking-tight text-text-primary">When this happens…</h3>
      <p className="mb-3.5 mt-0.5 text-[12.5px] text-text-secondary">
        The automation fires the moment this occurs.
      </p>

      <div className="flex flex-col gap-0.5" role="radiogroup" aria-label="When this happens…">
        {options.map(({ key, def }) => {
          const selected = value === key;
          return (
            // Deferred: a radiogroup row (role="radio", custom dot indicator
            // + two-line label) - a list-row/radio-option control, not a
            // CTA any Button cell is shaped for.
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onPick(key)}
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
                <span className="block text-[13.5px] font-bold text-text-primary">{def.label}</span>
                <span className="block text-[11.5px] text-text-soft">{def.description}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
