import { formatPhone } from '@/lib/utils';
import type { SwitchSet } from '@/lib/api/permissionSwitches';

/**
 * The contact display policy (Roles & Permissions, PRD 5): the one pure function that decides how a
 * customer value renders for this person. Pages never decide this themselves, so the rules are tested once.
 *
 * It reads the person's resolved switches and whether the company has the phone service, nothing else:
 * never a role name, never the record. A phone number is never masked: whoever can see one sees all its
 * digits, because hiding them would stop a person dialling by hand at all. Switch off means the digits stay
 * in the text (a screen reader still reads them) but cannot be selected, copied or handed to the device.
 *
 * The pencil is decided here too: on phones and emails for a person who holds Edit job and lead contact details or Edit
 * jobs (Edit leads on a lead), on the name and company for Edit jobs / Edit leads only. A closed lead has none of them
 * (S05.14), and neither has a locked job for a person without Change locked jobs (S05.11).
 */

export interface ContactSwitches {
  copyCustomerPhone: boolean;
  copyCustomerEmail: boolean;
  contactCustomers: boolean;
  viewCustomers: boolean;
  editCustomers: boolean;
  /** Edit job and lead contact details. */
  editContactDetails: boolean;
  editJobs: boolean;
}

export interface ContactPolicyInput {
  switches: ContactSwitches;
  /** Whether the company has the phone service. */
  phoneService: boolean;
}

/**
 * The switches the policy reads, out of the person's resolved set. A missing answer (still loading, or
 * the read failed) is every switch off: the page then shows the strictest version rather than the loosest.
 */
export function contactRulesFrom(values: SwitchSet | undefined): ContactSwitches {
  return {
    copyCustomerPhone: values?.copy_customer_phone === true,
    copyCustomerEmail: values?.copy_customer_email === true,
    contactCustomers: values?.contact_customers === true,
    viewCustomers: values?.view_customers === true,
    editCustomers: values?.edit_customers === true,
    editContactDetails: values?.edit_job_and_lead_contact_details === true,
    editJobs: values?.edit_jobs === true,
  };
}

export type PhoneKind = 'customer_phone' | 'crew_phone';

/** `in_app_*`: the ServWave dialer or composer. `native_link`: the device's own phone or text app. */
export type PhoneAction = 'in_app_dial' | 'native_link' | 'none';
export type TextAction = 'in_app_text' | 'native_link' | 'none';
/** `disabled`: a call button shown disabled, with the plain "not set up" message beside it. */
export type CallAction = PhoneAction | 'disabled';

export interface PhoneDisplay {
  /** The number as shown, digits and extension, always complete. */
  text: string;
  selectable: boolean;
  copyButton: boolean;
  /** What tapping the number does. */
  tap: PhoneAction;
  /** The Call button. */
  call: CallAction;
  /** The Text button. */
  textAction: TextAction;
}

export const CALL_NOT_SET_UP_MESSAGE = "Calling from the app isn't set up for your company. Contact ServWave support.";

function phoneText(phone: string, extension: string | null | undefined): string {
  return `${formatPhone(phone)}${extension ? ` ext. ${extension}` : ''}`;
}

export function phoneDisplay(
  kind: PhoneKind,
  phone: string,
  extension: string | null | undefined,
  { switches, phoneService }: ContactPolicyInput,
): PhoneDisplay {
  const text = phoneText(phone, extension);
  const isCustomer = kind === 'customer_phone';
  // Crew phones are not customer data: the copy switches do not apply to them.
  const mayCopy = isCustomer ? switches.copyCustomerPhone : true;
  const base = { text, selectable: mayCopy, copyButton: isCustomer && switches.copyCustomerPhone };

  if (phoneService) {
    // With the phone service no native phone or text link is left for anyone. Calls and texts are the
    // in-app ones, for a person who may contact customers; for anyone else there is nothing to tap.
    return switches.contactCustomers
      ? { ...base, tap: 'in_app_dial', call: 'in_app_dial', textAction: 'in_app_text' }
      : { ...base, tap: 'none', call: 'none', textAction: 'none' };
  }
  // Without the phone service a native link follows the copy switch (a crew phone always has one).
  if (mayCopy) return { ...base, tap: 'native_link', call: 'native_link', textAction: 'native_link' };
  return { ...base, tap: 'none', call: 'disabled', textAction: 'none' };
}

export type EmailAction = 'mail_link' | 'none';

export interface EmailDisplay {
  text: string;
  selectable: boolean;
  copyButton: boolean;
  tap: EmailAction;
}

export function customerEmailDisplay(email: string, { switches }: ContactPolicyInput): EmailDisplay {
  const mayCopy = switches.copyCustomerEmail;
  return { text: email, selectable: mayCopy, copyButton: mayCopy, tap: mayCopy ? 'mail_link' : 'none' };
}

/** Whether the customer's name opens the customer's page: only for a person who may open it. */
export function customerNameDisplay({ switches }: ContactPolicyInput): { link: boolean } {
  return { link: switches.viewCustomers };
}

/** What a job-only value is called wherever it shows, beside its label, author and date. */
export const JOB_ONLY_MARKER = 'This job only';

/** What a customer's phone or email replaced on this job is called, where the job's value stands in its place. */
export const CHANGED_ON_JOB_MARKER = 'Changed on this job';

/** The same two markers on a lead. */
export const LEAD_ONLY_MARKER = 'This lead only';
export const CHANGED_ON_LEAD_MARKER = 'Changed on this lead';

/**
 * The record a customer block sits on, as the pencil's rules see it. On a job, Edit jobs is the switch that covers every
 * customer detail, and `locked` is the server's answer for this person (S05.11): true on a Completed, Office review,
 * Ready to close, Done or Cancelled job for someone without Change locked jobs, who then gets no pencil, Edit or Remove
 * (hidden, not disabled, as the job page says why once). On a lead it is the server's answer for THIS lead, which lists
 * the edit for Edit leads and for the lead's creator while they are still on it (PRD 4), so the block never offers what
 * the server would refuse.
 */
export type PencilRecord = { kind: 'job'; locked?: boolean } | { kind: 'lead'; mayEdit: boolean; closed?: boolean };

/**
 * A Won or Lost lead takes no write to its own entries from anyone (S05.14), so it has no pencil, Edit or Remove, and
 * the block says why in one line. Nothing a person holds changes that.
 */
export const CLOSED_LEAD_LINE = 'This lead is closed. Reopen it to change its details.';

const isClosedLead = (record: PencilRecord) => record.kind === 'lead' && record.closed === true;

/** A locked job takes no write to its own entries from a person without Change locked jobs (S05.11). */
const isLockedJob = (record: PencilRecord) => record.kind === 'job' && record.locked === true;

/** Does this person hold the switch that covers every customer detail on this record (names and company included)? */
const coversEveryDetail = ({ switches }: ContactPolicyInput, record: PencilRecord) => (record.kind === 'lead' ? record.mayEdit : switches.editJobs);

/** What a record's own value is called, and what a customer value replaced on the record is called. */
export function entryMarkers(kind: PencilRecord['kind']): { only: string; changed: string } {
  return kind === 'lead' ? { only: LEAD_ONLY_MARKER, changed: CHANGED_ON_LEAD_MARKER } : { only: JOB_ONLY_MARKER, changed: CHANGED_ON_JOB_MARKER };
}

/**
 * Whether the pencil shows on a record's customer block. Phones and emails: Edit job and lead contact details, or the
 * switch that covers every customer detail on the record (Edit jobs on a job, Edit leads on a lead). The name and the
 * company name: that second switch only, since the contact details switch covers phones and emails, not names. The
 * server asks the same switches on every write.
 */
export function contactPencilDisplay(policy: ContactPolicyInput, record: PencilRecord = { kind: 'job' }): { phoneEmail: boolean; name: boolean } {
  if (isClosedLead(record) || isLockedJob(record)) return { phoneEmail: false, name: false };
  const covers = coversEveryDetail(policy, record);
  return { phoneEmail: policy.switches.editContactDetails || covers, name: covers };
}

/**
 * Whether Edit and Remove show on an entry already made on the record: to anyone who would get the pencil for that kind
 * of value, whoever added it. Being the author gives nothing extra, so the entry's author is not an input. A phone or
 * email follows the pencil on phones and emails; a name or company entry follows the switch that covers every detail.
 */
export function contactEntryActionsDisplay(policy: ContactPolicyInput, entry: { kind: string }, record: PencilRecord = { kind: 'job' }): { edit: boolean; remove: boolean } {
  const pencils = contactPencilDisplay(policy, record);
  const allowed = entry.kind === 'PHONE' || entry.kind === 'EMAIL' ? pencils.phoneEmail : pencils.name;
  return { edit: allowed, remove: allowed };
}

/**
 * Whether "Edit customer" (the customer record, as the customer page edits it) shows on a job or lead page: only for a
 * person who may open the customer's page and edit the customer. The job lock and a closed lead play no part: the
 * customer's own details never lock.
 */
export function editCustomerDisplay({ switches }: ContactPolicyInput): { show: boolean } {
  return { show: switches.viewCustomers && switches.editCustomers };
}
