import { useMemo } from 'react';
import { X } from 'lucide-react';

import { Combobox, type ComboboxOption } from '@/ui-kit/components/form/combobox';
import { useAssignableUsers } from '@/lib/api/users';
import { CustomerPickerWithCreate } from '@/components/crm/CustomerPickerWithCreate';

/**
 * ONE participant field's worth of state (calendar-entries spec §7): users and customers
 * mixed together, 0..N of each. `id` is the user_id or customer_id depending on `kind` -
 * never a synthetic composite - so the dialog can hand this straight to the API's
 * `{kind, user_id?, customer_id?}` shape with a one-line map.
 *
 * The customer side is pick-only: the picker's inline "create new customer" affordance is
 * turned off here (`allowCreate={false}`) per product-owner direction after manual QA, which
 * overrides spec §7's original "create a pre-lead prospect inline" requirement - see this
 * field's own doc comment below and the commit that introduced this note.
 */
export interface ParticipantDraft {
  kind: 'USER' | 'CUSTOMER';
  id: string;
  label: string;
}

export interface ParticipantsFieldProps {
  value: ParticipantDraft[];
  onChange: (next: ParticipantDraft[]) => void;
  disabled?: boolean;
}

/**
 * The participants field (spec §7): one chip list holding both kinds, with two ADD
 * affordances beneath it rather than a single control - a user and a customer come from
 * two different systems (the assignable-users roster vs. the customer table) and searching
 * them is two different queries, so pretending they are one dropdown would mean re-deriving
 * cross-kind search itself. What stays singular is the FIELD's stored value: one flat array,
 * one chip list, one thing this component hands back to the dialog.
 *
 * No free-text participants (spec §7) - both add paths resolve to a real id (an existing
 * user or an existing customer) before a chip can exist at all. The customer picker offers
 * no inline "create new customer" affordance from this field (product-owner override, see
 * above) - a prospect who isn't a customer yet must be created elsewhere first.
 */
export function ParticipantsField({ value, onChange, disabled = false }: ParticipantsFieldProps) {
  // `directory`, not `jobCrew`: a calendar entry's participants are explicitly NOT crew -
  // `eventPeople.ts` says so, and the calendar-entries API stores them as
  // `{kind, user_id?, customer_id?}` rows with no crew validator behind them. No assign grant
  // governs this list, so it is gated on `read User` the way it always was.
  const { data: users = [] } = useAssignableUsers({ purpose: 'directory', enabled: !disabled });

  const selectedUserIds = useMemo(
    () => new Set(value.filter((p) => p.kind === 'USER').map((p) => p.id)),
    [value],
  );
  const selectedCustomerIds = useMemo(
    () => new Set(value.filter((p) => p.kind === 'CUSTOMER').map((p) => p.id)),
    [value],
  );

  const userOptions: ComboboxOption[] = useMemo(
    () =>
      users
        .filter((u) => !selectedUserIds.has(u.id))
        .map((u) => ({
          value: u.id,
          label: `${u.first_name} ${u.last_name}`.trim(),
          hint: u.department?.name,
        })),
    [users, selectedUserIds],
  );

  const addUser = (id: string) => {
    const u = users.find((candidate) => candidate.id === id);
    if (!u || selectedUserIds.has(id)) return;
    onChange([...value, { kind: 'USER', id, label: `${u.first_name} ${u.last_name}`.trim() }]);
  };

  /**
   * `CustomerPickerWithCreate`'s own `value`/`valueLabel` are left at '' on purpose: this
   * field doesn't hold a single "the selected customer" - a pick just appends a chip and the
   * control's own `close()` resets it, ready to add another. Its trigger always shows its own
   * empty-state label rather than the last thing picked, which is the one visible cost of
   * reusing it as a repeatable "add" control instead of a single-value field.
   *
   * `allowCreate={false}` below turns off its inline "create new customer" row for this field
   * only - every other caller of `CustomerPickerWithCreate` is unaffected (the prop defaults
   * to `true`).
   */
  const addCustomer = (id: string, label: string) => {
    if (selectedCustomerIds.has(id)) return;
    onChange([...value, { kind: 'CUSTOMER', id, label }]);
  };

  const remove = (kind: ParticipantDraft['kind'], id: string) =>
    onChange(value.filter((p) => !(p.kind === kind && p.id === id)));

  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((p) => (
            <span
              key={`${p.kind}-${p.id}`}
              className="bg-muted text-foreground inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11.5px] font-medium"
            >
              {p.label}
              {!disabled && (
                <button
                  type="button"
                  onClick={() => remove(p.kind, p.id)}
                  className="text-muted-foreground hover:text-foreground"
                  aria-label={`Remove ${p.label}`}
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      {!disabled && (
        <div className="grid grid-cols-2 gap-2">
          <Combobox
            options={userOptions}
            value=""
            onValueChange={addUser}
            aria-label="Add team member"
            placeholder="Add team member…"
            searchPlaceholder="Search team…"
            emptyMessage={users.length === 0 ? 'No members' : 'Everyone is already added'}
          />
          <CustomerPickerWithCreate value="" valueLabel="" onChange={addCustomer} allowCreate={false} />
        </div>
      )}
    </div>
  );
}
