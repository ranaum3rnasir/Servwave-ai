import { useMemo } from 'react';

import { SelectField } from '@/components/form/SelectField';
import type { UserRow } from '@/lib/api/users';

import { Field } from './field';

/**
 * "Who should get <name>'s email?" - the one picker for handing a leaver's mailbox on (PRD 10): the deactivate dialog uses it
 * for the first handover and the move dialog for every later one. It offers "Main mailbox" and every active person but the
 * leaver. The company can have hundreds of people, so it is the shared select field: a plain list for a handful, a
 * searchable one with its own scroll once it grows. The value is "main" or a person's id, which is what the server takes.
 */

export const MAIN_MAILBOX_VALUE = 'main';
const MAIN_MAILBOX_LABEL = 'Main mailbox';

export function MailboxHandoverPicker({
  person, people, value, onValueChange,
}: {
  /** The person whose mailbox it is. */
  person: UserRow;
  /** Everyone on the Users page: the picker offers the active ones other than `person`. */
  people: UserRow[];
  value: string;
  onValueChange: (value: string) => void;
}) {
  const options = useMemo(
    () => [
      { value: MAIN_MAILBOX_VALUE, label: MAIN_MAILBOX_LABEL },
      ...people
        .filter((p) => p.is_active && p.id !== person.id)
        .map((p) => ({ value: p.id, label: `${p.first_name} ${p.last_name}`.trim() }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    ],
    [people, person.id],
  );
  return (
    <Field label={`Who should get ${person.first_name}'s email?`}>
      <SelectField value={value} onValueChange={onValueChange} options={options} />
    </Field>
  );
}
