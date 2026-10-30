import { useEffect, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FormField } from '@/components/patterns/FormField';
import {
  contactEntryErrorMessage,
  recordOnlyNote,
  useSaveNameChanges,
  type ContactRecordRef,
  type NameChange,
  type RecordContactEntry,
} from '@/lib/api/recordContactEntries';

/**
 * The pencil's form for the customer's name or company (Roles & Permissions, PRD 5, Edit jobs / Edit leads): the first
 * and last name together, or the company name, changed for this job (or lead) only. The customer record is never written.
 *
 * Each field starts on what the record shows now: its own change when it has one, else the customer's value. Only a field
 * the person moved is sent. A field with a change of the record's own is corrected in place; typing the customer's own
 * value back sets the change aside instead. Remove sets every change in this form aside and the customer's name
 * stands again.
 */

export type NameKind = 'FIRST_NAME' | 'LAST_NAME' | 'COMPANY_NAME';

/** One field of the form: what the customer holds, and the record's change of it if it has one. */
export interface NameField {
  kind: NameKind;
  label: string;
  customerValue: string;
  entry: RecordContactEntry | undefined;
}

interface NameEntryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The job or lead whose entries these are. */
  record: ContactRecordRef;
  /** What the form changes: the person's name, or the company name. */
  subject: 'name' | 'company name';
  fields: NameField[];
}

const shown = (field: NameField) => field.entry?.value ?? field.customerValue;

/** The requests a form needs, one per field the person moved. */
function namePlan(fields: NameField[], typed: Record<string, string>): NameChange[] {
  const plan: NameChange[] = [];
  for (const field of fields) {
    const value = (typed[field.kind] ?? '').trim();
    if (value === shown(field)) continue;
    if (!field.entry) plan.push({ op: 'change', kind: field.kind, value });
    else if (value === field.customerValue) plan.push({ op: 'remove', id: field.entry.id });
    else plan.push({ op: 'correct', id: field.entry.id, value });
  }
  return plan;
}

export function NameEntryDialog({ open, onOpenChange, record, subject, fields }: NameEntryDialogProps) {
  const word = record.kind;
  const [typed, setTyped] = useState<Record<string, string>>({});
  const save = useSaveNameChanges(record);
  const hasChange = fields.some((f) => f.entry);
  const adding = !hasChange && subject === 'company name' && !fields[0]!.customerValue;
  const title = adding ? `Add a company name for this ${word}` : `${hasChange ? 'Edit' : 'Change'} the ${subject} for this ${word}`;

  // A fresh form on each opening, not on every render while open.
  const wasOpen = useRef(false);
  const reset = save.reset;
  useEffect(() => {
    if (open && !wasOpen.current) {
      setTyped(Object.fromEntries(fields.map((f) => [f.kind, shown(f)])));
      reset();
    }
    wasOpen.current = open;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the fields only seed the form as it opens
  }, [open, reset]);

  const done = { onSuccess: () => onOpenChange(false) };
  const submit = () => {
    const plan = namePlan(fields, typed);
    if (plan.length === 0) onOpenChange(false);
    else save.mutate(plan, done);
  };
  const removeAll = () => save.mutate(fields.flatMap((f): NameChange[] => (f.entry ? [{ op: 'remove', id: f.entry.id }] : [])), done);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent intent="form" className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{recordOnlyNote(word)}</DialogDescription>
        </DialogHeader>

        <form
          noValidate
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {fields.map((field) => (
            <FormField key={field.kind} label={field.label}>
              <Input
                value={typed[field.kind] ?? ''}
                onChange={(e) => setTyped((now) => ({ ...now, [field.kind]: e.target.value }))}
                maxLength={field.kind === 'COMPANY_NAME' ? 200 : 100}
              />
            </FormField>
          ))}

          {hasChange && <p className="text-text-secondary text-sm">{`Removing this puts the customer's ${subject} back on this ${word}.`}</p>}

          {save.error && (
            <p role="alert" className="text-danger text-sm">
              {contactEntryErrorMessage(save.error)}
            </p>
          )}

          <DialogFooter className="gap-3">
            {hasChange && (
              <Button type="button" variant="outline" className="sm:mr-auto" disabled={save.isPending} onClick={removeAll}>
                Remove
              </Button>
            )}
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? 'Saving...' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
