/* =============================================================================
   ServWave CRM — barrel.
   Cross-feature composites that know about ServWave's domain (customers,
   service locations, line items, attachments, activity). They are shared by
   Leads / Estimates / Jobs / Invoices, but unlike `components/ui` they are NOT
   domain-agnostic - that is the line between the two folders.

   Feature-specific components stay in their own folder (components/jobs,
   components/estimates, ...); only things used by more than one feature belong here.
   ============================================================================= */

// --- customer / location pickers -------------------------------------------
export { PickOrCreateCustomer, splitFullName, getDuplicateCustomer, computeMatchedCustomerFields } from './PickOrCreateCustomer';
export type { PickCustomer, CustomerContactFields, CustomerContactField, PickOrCreateCustomerProps } from './PickOrCreateCustomer';

export { CustomerPickerWithCreate, customerLabel, customerRow } from './CustomerPickerWithCreate';
export type { CustomerLite, CustomerPickerWithCreateProps } from './CustomerPickerWithCreate';

export { PickOrAccreteLocation, formatLocationLabel, ADD_NEW_LOCATION } from './PickOrAccreteLocation';
export type {
  ServiceLocationOption,
  NewAddressFields,
  NewAddressField,
  PickOrAccreteLocationValue,
  PickOrAccreteLocationProps,
} from './PickOrAccreteLocation';

export { AddressAutocomplete } from './address-autocomplete';
export type { ParsedAddress } from './address-autocomplete';

export { ServiceLocationMap } from './service-location-map';

// --- assignment -------------------------------------------------------------
export { AssigneeSelect } from './AssigneeSelect';
export { MultiAssigneeSelect } from './MultiAssigneeSelect';
export { AssignTeamPopover } from './AssignTeamPopover';
export type { NotifyChannel } from './AssignTeamPopover';

// --- money / line items -----------------------------------------------------
export { LineItemsEditor, blankLineItem } from './LineItemsEditor';
export type { LineItem, LineItemsEditorProps } from './LineItemsEditor';

export { InternalCostsCard } from './InternalCostsCard';
export type { InternalCostsCardProps } from './InternalCostsCard';

export { PaymentFeeBreakdown } from './PaymentFeeBreakdown';
export type { PaymentFeeBreakdownProps } from './PaymentFeeBreakdown';

// --- record side panels -----------------------------------------------------
export { IconRail } from './IconRail';
export { ActivityPanel } from './ActivityPanel';
export { AttachmentsPanel } from './AttachmentsPanel';
export { AttachmentSection } from './AttachmentSection';
