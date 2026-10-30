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
import { RequiredToggleGroup } from '@/components/ui/required-toggle-group';
import { ToggleGroupItem } from '@/components/ui/toggle-group';
import { FormField } from '@/components/patterns/FormField';
import { PhoneInput, phoneFieldValue } from '@/ui-kit/components/form/phoneInput';
import {
  contactEntryErrorMessage,
  recordOnlyNote,
  useAddContactEntry,
  useChangeContactEntry,
  useCorrectContactEntry,
  useRemoveContactEntry,
  type ContactRecordRef,
  type RecordContactEntry,
} from '@/lib/api/recordContactEntries';

/** A customer phone or email on the block, as the pencil next to it hands it to the form. */
export interface ContactEntryTarget {
  value: string;
  extension?: string | null;
  label?: string | null;
}

type Mode = 'replace' | 'add' | 'edit';

interface ContactEntryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The job or lead whose entries these are. */
  record: ContactRecordRef;
  kind: 'PHONE' | 'EMAIL';
  target: ContactEntryTarget | null;
  /** An entry already made on the record: the form corrects it in place (Edit) or sets it aside (Remove), whoever made it. */
  entry?: RecordContactEntry | null;
}

/**
 * The pencil's form (Roles & Permissions, PRD 5): add a phone or an email that belongs to this job (or lead) only, or
 * replace one of the customer's on it. The customer record is never written; the office decides at review whether it
 * changes too.
 *
 * `target` is the customer value the person tapped the pencil of; on an empty line there is none and the form can
 * only add. With one, the form opens on "Replace on this job" with that value filled in, beside the choice "Add as
 * another number (or email) for this job". On a lead the same words name the lead.
 */
export function ContactEntryDialog({ open, onOpenChange, record, kind, target, entry = null }: ContactEntryDialogProps) {
  const word = record.kind;
  const isPhone = kind === 'PHONE';
  const noun = isPhone ? 'number' : 'email';
  const [mode, setMode] = useState<Mode>('add');
  const [value, setValue] = useState('');
  const [extension, setExtension] = useState('');
  const [label, setLabel] = useState('');
  const add = useAddContactEntry(record);
  const change = useChangeContactEntry(record);
  const correct = useCorrectContactEntry(record);
  const remove = useRemoveContactEntry(record);
  const save = mode === 'edit' ? correct : mode === 'replace' ? change : add;

  /** The form for a mode: the customer's value to change in place, or empty for a new one. */
  const fill = (next: Mode) => {
    const filled: ContactEntryTarget | null = next === 'edit' ? entry : next === 'replace' ? target : null;
    setMode(next);
    setValue(filled ? (isPhone ? phoneFieldValue(filled.value) : filled.value) : '');
    setExtension(filled ? (filled.extension ?? '') : '');
    setLabel(filled ? (filled.label ?? '') : '');
  };

  // A fresh form on each opening, not on every render while open.
  const wasOpen = useRef(false);
  const resetAdd = add.reset;
  const resetChange = change.reset;
  const resetCorrect = correct.reset;
  const resetRemove = remove.reset;
  useEffect(() => {
    if (open && !wasOpen.current) {
      fill(entry ? 'edit' : target ? 'replace' : 'add');
      resetAdd();
      resetChange();
      resetCorrect();
      resetRemove();
    }
    wasOpen.current = open;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `fill` only reads the target and entry the form opened with
  }, [open, resetAdd, resetChange, resetCorrect, resetRemove]);

  const submit = () => {
    const optionalLabel = label.trim() || undefined;
    const done = { onSuccess: () => onOpenChange(false) };
    const fields = isPhone
      ? { kind, value: value.trim(), extension: extension.trim() || undefined, label: optionalLabel }
      : { kind, value: value.trim(), label: optionalLabel };
    if (mode === 'edit' && entry) {
      // An emptied extension or label is sent as empty so the entry loses it.
      correct.mutate(
        isPhone
          ? { id: entry.id, value: value.trim(), extension: extension.trim(), label: label.trim() }
          : { id: entry.id, value: value.trim(), label: label.trim() },
        done,
      );
    } else if (mode === 'replace' && target) {
      change.mutate({ ...fields, replaces: target.value } as Parameters<typeof change.mutate>[0], done);
    } else {
      add.mutate(fields, done);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent intent="form" className="max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {entry
              ? `Edit this ${isPhone ? 'phone' : 'email'} for this ${word}`
              : target
                ? `Change this ${isPhone ? 'phone' : 'email'} for this ${word}`
                : `Add ${isPhone ? 'a phone' : 'an email'} for this ${word}`}
          </DialogTitle>
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
          {target && !entry && (
            <RequiredToggleGroup
              variant="pill"
              value={mode}
              onValueChange={(next) => fill(next as Mode)}
              aria-label="How to save this"
              className="flex-wrap"
            >
              <ToggleGroupItem value="replace" variant="pill">
                {`Replace on this ${word}`}
              </ToggleGroupItem>
              <ToggleGroupItem value="add" variant="pill">
                {`Add as another ${noun} for this ${word}`}
              </ToggleGroupItem>
            </RequiredToggleGroup>
          )}

          {isPhone ? (
            <div className="grid grid-cols-[minmax(0,1fr)_5.5rem] gap-3">
              <FormField label="Phone number">
                <PhoneInput value={value} onValueChange={setValue} personalAutofill={false} />
              </FormField>
              <FormField label="Ext." optional>
                <Input kind="phone-extension" value={extension} onChange={(e) => setExtension(e.target.value)} maxLength={10} />
              </FormField>
            </div>
          ) : (
            <FormField label="Email address">
              <Input kind="email" personalAutofill={false} value={value} onChange={(e) => setValue(e.target.value)} />
            </FormField>
          )}

          <FormField label="Label" optional hint={isPhone ? "For example Wife's cell" : 'For example Billing'}>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={50} />
          </FormField>

          {entry?.intent === 'CHANGED' && (
            <p className="text-text-secondary text-sm">{`Removing this puts the customer's ${noun} back on this ${word}.`}</p>
          )}

          {(save.error ?? remove.error) && (
            <p role="alert" className="text-danger text-sm">
              {contactEntryErrorMessage(save.error ?? remove.error)}
            </p>
          )}

          <DialogFooter className="gap-3">
            {entry && (
              <Button
                type="button"
                variant="outline"
                className="sm:mr-auto"
                disabled={remove.isPending || save.isPending}
                onClick={() => remove.mutate(entry.id, { onSuccess: () => onOpenChange(false) })}
              >
                {remove.isPending ? 'Removing...' : 'Remove'}
              </Button>
            )}
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending || remove.isPending || value.trim() === ''}>
              {save.isPending ? 'Saving...' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
