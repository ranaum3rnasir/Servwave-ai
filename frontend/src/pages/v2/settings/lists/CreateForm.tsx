import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';

import { PaletteSwatchPicker } from '@/components/form/PaletteSwatchPicker';
import { TAG_COLORS, TAG_COLOR_NAMES, tagColorName } from '@/lib/tag-colors';
import { Button } from '@/ui-kit/components/ui/button';
import { Input } from '@/ui-kit/components/ui/input';
import { Label } from '@/ui-kit/components/ui/label';

import { NAME_MAX, type ListDef } from './listDefs';

/**
 * The create form that takes the pinned row's place (spec 6.5). `onSubmit` answers with the problem text to show under
 * the input, or null when the row was created (the card then closes the form). Enter submits, Escape cancels. Lists
 * with a colour also show the ten swatches, starting on `defaultColour`.
 */
export function CreateForm({
  def,
  initial,
  defaultColour,
  onSubmit,
  onCancel,
}: {
  def: ListDef;
  initial: string;
  defaultColour: string;
  onSubmit: (name: string, colour: string) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [colour, setColour] = useState(defaultColour);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = `lc-new-${def.key}`;
  const errorId = `${inputId}-error`;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    const problem = await onSubmit(value, colour);
    setBusy(false);
    if (problem) {
      setError(problem);
      inputRef.current?.focus();
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <form className="lc-form" noValidate onSubmit={submit} onKeyDown={onKeyDown}>
      <div className="lc-form-field">
        <Label htmlFor={inputId}>Name of the new {def.singular}</Label>
        <Input
          ref={inputRef}
          id={inputId}
          value={value}
          maxLength={NAME_MAX}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(e) => setValue(e.target.value)}
        />
        {error && (
          <p id={errorId} role="alert" className="text-danger-text text-xs">
            {error}
          </p>
        )}
      </div>
      {def.colour && (
        <div className="lc-form-colour">
          <span className="text-sm font-medium">
            Colour <span className="lc-swn-new" data-slot="lc-new-colour-name">{tagColorName(colour)}</span>
          </span>
          <PaletteSwatchPicker size="large" colors={TAG_COLORS} names={TAG_COLOR_NAMES} value={colour} onChange={setColour} aria-label="Colour" />
        </div>
      )}
      <div className="lc-form-acts">
        <Button type="submit" disabled={busy}>
          Create {def.singular}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
