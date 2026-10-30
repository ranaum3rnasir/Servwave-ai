import { PAYMENT_METHOD_LABELS } from '@/lib/payment-methods';
import type { PaymentMethod } from '@/lib/api/organization';
import { ALL_ACCEPTED, type CatalogSwitch, type SwitchValue } from '@/lib/api/permissionSwitches';

/**
 * A switch's value in the words the switch-set editor reads it in, shared by the editor and the change logs so a value
 * is never worded two ways: On / Off for a toggle, the choice's label for a choice, the chosen members for a list.
 */

/** A choice's stored value as the words a person reads: "team" is "Team". */
export function choiceLabel(value: string): string {
  const spaced = value.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export const optionLabel = (option: string) => PAYMENT_METHOD_LABELS[option as PaymentMethod] ?? choiceLabel(option);

export function valueText(sw: CatalogSwitch, value: SwitchValue | undefined): string {
  if (sw.kind === 'toggle') return value === true ? 'On' : 'Off';
  if (sw.kind === 'choice') {
    if (typeof value !== 'string') return 'Off';
    return sw.keptValueHelp?.[value]?.label ?? choiceLabel(value);
  }
  if (value === ALL_ACCEPTED) return 'All accepted methods';
  return Array.isArray(value) && value.length > 0 ? value.map(optionLabel).join(', ') : 'None';
}
