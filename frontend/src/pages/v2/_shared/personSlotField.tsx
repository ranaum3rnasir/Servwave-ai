import { Label } from '@/ui-kit/components/ui/label';
import { SelectField } from '@/ui-kit/components/form/selectField';
import { RosterError, RosterLoading } from '@/components/crm/RosterStatus';

const NO_PERSON = '__none__';

/**
 * One of a create form's people fields (a lead's Owner and Dispatcher, a job's Sold By and Dispatcher). A person
 * with the matching Assign people switch gets a picker that can keep, change or clear it; anyone else gets the
 * pre-filled person as fixed text. An empty field reads as
 * its "No ..." phrase either way. The pre-fill is always the signed-in person, so they are offered even when the
 * roster does not list them (the creator rule can land someone on a slot their own switch would not let them pick).
 * While the roster loads the picker is a loading placeholder, and when it fails an error with Retry: never an empty list.
 */
export function PersonSlotField({
  label, empty, picker, value, ready, onChange, roster, me, loading = false, failed = false, onRetry,
}: {
  label: string;
  empty: string;
  picker: boolean;
  value: string;
  /** The pre-fill has arrived. A picker mounts only then, so it starts with its value in hand. */
  ready: boolean;
  onChange: (value: string) => void;
  roster: Array<{ id: string; first_name: string; last_name: string }>;
  me: { id: string; first_name: string; last_name: string } | null;
  /** The roster is still on its way. */
  loading?: boolean;
  /** The roster could not be loaded; `onRetry` asks again. */
  failed?: boolean;
  onRetry?: () => void;
}) {
  const people = roster.some((u) => u.id === value) || !me || me.id !== value ? roster : [...roster, me];
  const nameOf = (id: string) => {
    const person = people.find((u) => u.id === id) ?? (me?.id === id ? me : null);
    return person ? `${person.first_name} ${person.last_name}` : null;
  };
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      {picker && loading ? (
        <RosterLoading />
      ) : picker && failed ? (
        <RosterError onRetry={() => onRetry?.()} />
      ) : picker ? (
        <SelectField
          key={ready ? 'ready' : 'waiting'}
          aria-label={label}
          value={value}
          onValueChange={(v) => onChange(v === NO_PERSON ? '' : v)}
          placeholder={empty}
          options={[
            { value: NO_PERSON, label: empty },
            ...people.map((u) => ({ value: u.id, label: `${u.first_name} ${u.last_name}` })),
          ]}
        />
      ) : (
        <p className="text-sm">{(value && nameOf(value)) || empty}</p>
      )}
    </div>
  );
}
