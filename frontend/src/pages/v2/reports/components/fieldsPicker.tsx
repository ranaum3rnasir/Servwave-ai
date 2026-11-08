import { useState } from 'react';
import { Search } from 'lucide-react';

import { Button } from '@/ui-kit/components/ui/button';
import { Checkbox } from '@/ui-kit/components/ui/checkbox';
import {
  Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/ui-kit/components/ui/dialog';
import { Input } from '@/ui-kit/components/ui/input';
import { Label } from '@/ui-kit/components/ui/label';
import { cn } from '@/ui-kit/lib/utils';

import { ReportSelectTrigger } from './shared';

/**
 * The two pickers Jobs, Leads and Sales each had their own copy of.
 *
 * All three declared a byte-identical `FilterPanel` (a six-column checklist
 * inside `ReportSelectTrigger`) and a byte-identical `FieldsModal` (search box,
 * selected/unselected groups, a save that always re-includes the always-on
 * columns). Only the vocabularies differ, so they are parameters here.
 *
 * Both are rebuilt on kit primitives: the checklist rows were raw `<button>`s
 * and the field rows drew their own tick box out of a span; they are kit
 * `Button`s with `aria-pressed` and a real kit `Checkbox` with a `Label`.
 */

export interface FieldSpec {
  key: string;
  label: string;
  /** Cannot be turned off; the save always re-includes it. */
  alwaysOn?: boolean;
}

export function FieldsPicker({
  columns, visible, onSave, onClose,
}: {
  columns: FieldSpec[];
  visible: string[];
  onSave: (keys: string[]) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<string[]>(visible);
  const [q, setQ] = useState('');
  const shown = columns.filter((c) => c.label.toLowerCase().includes(q.toLowerCase()));
  const toggle = (key: string, alwaysOn?: boolean) => {
    if (alwaysOn) return;
    setDraft((d) => (d.includes(key) ? d.filter((k) => k !== key) : [...d, key]));
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Visible fields</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search fields"
            placeholder="Type field name here"
            startIcon={<Search className="size-4" />}
          />
          <div className="max-h-[50vh] space-y-4 overflow-auto">
            {[
              { title: 'Selected fields', items: shown.filter((c) => c.alwaysOn || draft.includes(c.key)) },
              { title: 'Unselected fields', items: shown.filter((c) => !(c.alwaysOn || draft.includes(c.key))) },
            ].map((group) =>
              group.items.length === 0 ? null : (
                <div key={group.title} className="space-y-2">
                  <div className="text-muted-foreground text-[11px] font-semibold tracking-wide uppercase">{group.title}</div>
                  {group.items.map((c) => {
                    const on = c.alwaysOn || draft.includes(c.key);
                    return (
                      <div
                        key={c.key}
                        className={cn('flex items-center gap-3 rounded-lg border px-4 py-3', c.alwaysOn && 'bg-muted')}
                      >
                        <Checkbox
                          id={`report-field-${c.key}`}
                          checked={on}
                          disabled={c.alwaysOn}
                          onCheckedChange={() => toggle(c.key, c.alwaysOn)}
                        />
                        <Label htmlFor={`report-field-${c.key}`} className="text-sm font-medium">{c.label}</Label>
                      </div>
                    );
                  })}
                </div>
              ),
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            type="button"
            onClick={() => onSave(columns.filter((c) => c.alwaysOn || draft.includes(c.key)).map((c) => c.key))}
          >
            Save fields
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface FilterColumnSpec<K extends string> {
  key: K;
  label: string;
  options: readonly string[];
}

export function FilterChecklistPanel<K extends string>({
  columns, filters, onChange, empty,
}: {
  columns: FilterColumnSpec<K>[];
  filters: Record<K, string[]>;
  onChange: (next: Record<K, string[]>) => void;
  /** The all-cleared value, used by "Clear all". */
  empty: Record<K, string[]>;
}) {
  const [open, setOpen] = useState(false);

  const toggle = (k: K, v: string) => {
    const cur = filters[k];
    onChange({ ...filters, [k]: cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v] });
  };
  const total = Object.values<string[]>(filters).reduce((s, a) => s + a.length, 0);

  return (
    <ReportSelectTrigger
      label="Filter results"
      activeCount={total}
      open={open}
      onToggle={() => setOpen((o) => !o)}
      onClose={() => setOpen(false)}
      onClear={() => onChange({ ...empty })}
    >
      <div className="grid max-h-[420px] grid-cols-2 gap-x-4 gap-y-3 overflow-auto p-4 sm:grid-cols-3 lg:grid-cols-6">
        {columns.map((col) => (
          <div key={col.key} className="min-w-0">
            <div className="text-muted-foreground mb-1.5 text-[11px] font-semibold tracking-wide uppercase">{col.label}</div>
            <div className="space-y-0.5">
              {col.options.map((opt) => {
                const on = filters[col.key].includes(opt);
                return (
                  <Button
                    key={opt}
                    type="button"
                    size="sm"
                    variant={on ? 'secondary' : 'ghost'}
                    aria-pressed={on}
                    onClick={() => toggle(col.key, opt)}
                    className="w-full justify-start"
                  >
                    <span className="truncate">{opt}</span>
                  </Button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </ReportSelectTrigger>
  );
}
