/* =============================================================================
   ServWave Form — barrel.
   Generic, domain-agnostic form controls. These compose `components/ui`
   primitives (Select, Popover, Calendar) into the field-shaped controls that
   forms across the app actually use.

   Domain-bound pickers (customer, assignee, location) live in
   `components/crm` - not here.
   ============================================================================= */

export { SelectField } from './SelectField';
export type { SelectFieldProps, SelectFieldOption } from './SelectField';

export { TextLengthCounter } from './TextLengthCounter';
