import { useRef, useState } from 'react';

import { useScheduleTimezone } from '@/lib/schedule-tz';

import { DateField } from '@/ui-kit/components/form/dateField';
import { SelectField } from '@/ui-kit/components/form/selectField';
import { Button } from '@/ui-kit/components/ui/button';
import { Label } from '@/ui-kit/components/ui/label';
import { Popover, PopoverAnchor, PopoverContent } from '@/ui-kit/components/ui/popover';
import { Sheet, SheetBody, SheetContent, SheetFooter, SheetHeader, SheetTitle } from '@/ui-kit/components/ui/sheet';
import { useOverlayPresentation } from '@/ui-kit/hooks/useOverlayPresentation';

import { PHONE_TAP_AREA } from '../phoneTap';
import {
  PRESETS, periodLabel, resolvePreset, validateRange, type Period, type PresetKey, type RangeProblem,
} from '../periods';

const PICK = 'pick';
const FROM_ID = 'payments-period-from';
const TO_ID = 'payments-period-to';
/** How long after opening an outside focus or pointer event is still the select closing, not the person leaving. */
const HANDOVER_MS = 300;

/**
 * The page's period: presets in the kit select, plus a "Custom range" row that opens two date fields. The
 * current choice stays selected while the range is being picked, so Escape, Cancel or a click outside simply
 * closes it and the previous period is still there. A failed Apply focuses the first bad field, marks it
 * invalid and puts the message beside it. Presets are computed in the org timezone, not the browser's.
 */
export function PeriodPicker({ period, onChange }: { period: Period; onChange: (next: Period) => void }) {
  const tz = useScheduleTimezone();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ from: period.from, to: period.to });
  const [problem, setProblem] = useState<RangeProblem | null>(null);
  // Once a failed Apply has drawn a message, its line stays reserved until the panel closes (see ErrorLine).
  const [lastProblem, setLastProblem] = useState<RangeProblem | null>(null);
  const sheet = useOverlayPresentation('form') !== 'card';
  const anchorRef = useRef<HTMLDivElement>(null);
  const openedAt = useRef(0);

  const options = [
    ...PRESETS.map((p) => ({ value: p.key as string, label: p.label })),
    ...(period.key === 'custom' ? [{ value: 'custom', label: periodLabel(period) }] : []),
    { value: PICK, label: 'Custom range' },
  ];

  const close = () => {
    setOpen(false);
    setProblem(null);
    setLastProblem(null);
  };

  const choose = (value: string) => {
    if (value === PICK) {
      setDraft({ from: period.from, to: period.to });
      setProblem(null);
      setLastProblem(null);
      openedAt.current = performance.now();
      setOpen(true);
      return;
    }
    if (value === 'custom') return;
    onChange({ key: value as PresetKey, ...resolvePreset(value as PresetKey, tz) });
  };

  const apply = () => {
    const found = validateRange(draft.from, draft.to);
    if (found) {
      setProblem(found);
      setLastProblem(found);
      // After the message is drawn, so the field is already marked when focus lands on it.
      requestAnimationFrame(() => document.getElementById(found.field === 'from' ? FROM_ID : TO_ID)?.focus());
      return;
    }
    onChange({ key: 'custom', from: draft.from, to: draft.to });
    close();
  };

  const fields = (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={FROM_ID}>Start date</Label>
        <DateField
          id={FROM_ID}
          value={draft.from}
          onChange={(from) => { if (from === draft.from) return; setDraft((d) => ({ ...d, from })); setProblem(null); }}
          aria-invalid={problem?.field === 'from' || undefined}
          clearable={false}
        />
        <ErrorLine text={lastProblem?.field === 'from' ? lastProblem.message : ''} shown={problem?.field === 'from'} reserve={lastProblem !== null} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={TO_ID}>End date</Label>
        <DateField
          id={TO_ID}
          value={draft.to}
          onChange={(to) => { if (to === draft.to) return; setDraft((d) => ({ ...d, to })); setProblem(null); }}
          aria-invalid={problem?.field === 'to' || undefined}
          clearable={false}
        />
        <ErrorLine text={lastProblem?.field === 'to' ? lastProblem.message : ''} shown={problem?.field === 'to'} reserve={lastProblem !== null} />
      </div>
    </div>
  );

  const actions = (
    <>
      <Button type="button" variant="outline" onClick={close}>Cancel</Button>
      <Button type="button" onClick={apply}>Apply</Button>
    </>
  );

  return (
    <>
      <Popover open={open && !sheet} onOpenChange={(next) => { if (!next) close(); }}>
        <PopoverAnchor asChild>
          <div ref={anchorRef} className="w-full sm:w-52">
            <SelectField
              aria-label="Period"
              value={period.key}
              options={options}
              onValueChange={choose}
              size="sm"
              contentClassName={PHONE_TAP_AREA}
            />
          </div>
        </PopoverAnchor>
        <PopoverContent
          align="end"
          className="w-80"
          aria-label="Custom range"
          // The select that opened this is still closing: it hands focus (and a pointer event) back to the page or
          // to its own trigger, which Radix would read as an outside interaction and dismiss the popover within
          // a few frames. Ignore outside interactions on the trigger and during that hand-over.
          onInteractOutside={(event) => {
            if (anchorRef.current?.contains(event.target as Node) || performance.now() - openedAt.current < HANDOVER_MS) {
              event.preventDefault();
            }
          }}
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <div className="flex flex-col gap-4">
            {fields}
            <div className="flex justify-end gap-2">{actions}</div>
          </div>
        </PopoverContent>
      </Popover>

      <Sheet open={open && sheet} onOpenChange={(next) => { if (!next) close(); }}>
        <SheetContent side="bottom" aria-describedby={undefined} className={`max-h-[92dvh] gap-0 rounded-t-xl ${PHONE_TAP_AREA}`}>
          <SheetHeader>
            <SheetTitle>Custom range</SheetTitle>
          </SheetHeader>
          <SheetBody>{fields}</SheetBody>
          <SheetFooter className="justify-end gap-2">{actions}</SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  );
}

/**
 * The message under a date field. After the first failed Apply the line stays in the DOM, same height and same
 * text nodes, and only turns invisible when the message clears (blurring a bad field commits it and clears the
 * message). Two reasons, both about a tap on the other field: the phone sheet is anchored to the bottom edge, so
 * a shorter sheet would slide that field away between pointerdown and click; and the sheet's focus trap hands
 * focus to the dialog itself when a node is removed while focus is on the body, which is exactly where focus is
 * for a moment after a touch blurs the bad field. Nothing may be added to or removed from the sheet then.
 */
function ErrorLine({ text, shown, reserve }: { text: string; shown: boolean; reserve: boolean }) {
  if (!reserve) return null;
  return (
    <div data-testid="range-error-slot" className="min-h-[1.25rem]">
      <p
        role="alert"
        aria-hidden={shown ? undefined : true}
        className={`text-destructive text-[13px] leading-5 ${shown ? '' : 'invisible'}`}
      >
        {text}
      </p>
    </div>
  );
}
