import { describe, expect, it } from 'vitest';
import {
  contactEntryActionsDisplay,
  contactPencilDisplay,
  contactRulesFrom,
  customerEmailDisplay,
  customerNameDisplay,
  editCustomerDisplay,
  entryMarkers,
  phoneDisplay,
  type ContactPolicyInput,
  type ContactSwitches,
} from '../contactDisplayPolicy';
import { catalogToggle } from '@/__tests__/support/backendSwitchCatalog';

/**
 * The contact display policy: one pure function decides how a customer value renders for this person.
 * It reads switches and the company's phone service, nothing else. Expected switch keys and preset values
 * come from the backend catalog, never from a copy here.
 */

const BOOLS = [true, false] as const;

/** Every combination of the four customer-value switches the policy reads, with the phone service on and off. */
function everyInput(): ContactPolicyInput[] {
  const out: ContactPolicyInput[] = [];
  for (const copyCustomerPhone of BOOLS)
    for (const copyCustomerEmail of BOOLS)
      for (const contactCustomers of BOOLS)
        for (const viewCustomers of BOOLS)
          for (const phoneService of BOOLS)
            out.push({
              switches: { copyCustomerPhone, copyCustomerEmail, contactCustomers, viewCustomers, editCustomers: false, editContactDetails: false, editJobs: false },
              phoneService,
            });
  return out;
}

const describeInput = (i: ContactPolicyInput) =>
  `copyPhone=${i.switches.copyCustomerPhone} copyEmail=${i.switches.copyCustomerEmail} contact=${i.switches.contactCustomers} view=${i.switches.viewCustomers} service=${i.phoneService}`;

const PHONE = '5551234567';

describe('contactRulesFrom', () => {
  it('reads the switches by the keys the catalog gives them', () => {
    const key = (label: string) => catalogToggle(label).key;
    const on = {
      [key('Copy customer phone')]: true,
      [key('Copy customer email')]: true,
      [key('Contact customers')]: true,
      [key('View customers')]: true,
      [key('Edit customers')]: true,
      [key('Edit job and lead contact details')]: true,
      [key('Edit jobs')]: true,
    };
    expect(contactRulesFrom(on)).toEqual({
      copyCustomerPhone: true, copyCustomerEmail: true, contactCustomers: true, viewCustomers: true, editCustomers: true,
      editContactDetails: true, editJobs: true,
    });
    expect(contactRulesFrom({ ...on, [key('Copy customer phone')]: false }).copyCustomerPhone).toBe(false);
    expect(contactRulesFrom({ ...on, [key('Contact customers')]: false }).contactCustomers).toBe(false);
  });

  it('treats a missing or unreadable answer as every switch off', () => {
    const off: ContactSwitches = {
      copyCustomerPhone: false, copyCustomerEmail: false, contactCustomers: false, viewCustomers: false, editCustomers: false,
      editContactDetails: false, editJobs: false,
    };
    expect(contactRulesFrom(undefined)).toEqual(off);
    expect(contactRulesFrom({})).toEqual(off);
  });

  it('reads the Technician preset as copy phone off and copy email on', () => {
    const phone = catalogToggle('Copy customer phone');
    const email = catalogToggle('Copy customer email');
    const technician = contactRulesFrom({ [phone.key]: phone.presets.TECHNICIAN, [email.key]: email.presets.TECHNICIAN });
    expect(technician.copyCustomerPhone).toBe(false);
    expect(technician.copyCustomerEmail).toBe(true);
  });
});

describe('a customer phone', () => {
  it('with Copy customer phone off never yields a native link, a copy button or a selectable number, and keeps its digits', () => {
    for (const input of everyInput().filter((i) => !i.switches.copyCustomerPhone)) {
      const d = phoneDisplay('customer_phone', PHONE, null, input);
      const label = describeInput(input);
      expect(d.selectable, label).toBe(false);
      expect(d.copyButton, label).toBe(false);
      expect([d.tap, d.call, d.text], label).not.toContain('native_link');
      expect(d.text.replace(/\D/g, ''), label).toBe(PHONE);
    }
  });

  it('with the phone service on never yields a native link, for any switch', () => {
    for (const input of everyInput().filter((i) => i.phoneService)) {
      const d = phoneDisplay('customer_phone', PHONE, null, input);
      expect([d.tap, d.call, d.text], describeInput(input)).not.toContain('native_link');
    }
  });

  it('with the phone service and Contact customers on dials and texts in the app', () => {
    for (const input of everyInput().filter((i) => i.phoneService && i.switches.contactCustomers)) {
      const d = phoneDisplay('customer_phone', PHONE, null, input);
      expect(d.tap, describeInput(input)).toBe('in_app_dial');
      expect(d.call, describeInput(input)).toBe('in_app_dial');
      expect(d.textAction, describeInput(input)).toBe('in_app_text');
    }
  });

  it('with the phone service on and Contact customers off offers no call, no text and no tap', () => {
    for (const input of everyInput().filter((i) => i.phoneService && !i.switches.contactCustomers)) {
      const d = phoneDisplay('customer_phone', PHONE, null, input);
      expect([d.tap, d.call, d.textAction], describeInput(input)).toEqual(['none', 'none', 'none']);
    }
  });

  it('without the phone service, Copy customer phone on yields a native link', () => {
    for (const input of everyInput().filter((i) => !i.phoneService && i.switches.copyCustomerPhone)) {
      const d = phoneDisplay('customer_phone', PHONE, null, input);
      expect([d.tap, d.call, d.textAction], describeInput(input)).toEqual(['native_link', 'native_link', 'native_link']);
      expect(d.selectable).toBe(true);
      expect(d.copyButton).toBe(true);
    }
  });

  it('without the phone service, Copy customer phone off shows digits only, with no tap and a disabled call', () => {
    for (const input of everyInput().filter((i) => !i.phoneService && !i.switches.copyCustomerPhone)) {
      const d = phoneDisplay('customer_phone', PHONE, null, input);
      expect([d.tap, d.textAction], describeInput(input)).toEqual(['none', 'none']);
      expect(d.call, describeInput(input)).toBe('disabled');
    }
  });

  it('never masks the digits, for any input, and puts the extension after them', () => {
    for (const input of everyInput()) {
      expect(phoneDisplay('customer_phone', PHONE, null, input).text.replace(/\D/g, '')).toBe(PHONE);
      expect(phoneDisplay('customer_phone', PHONE, '12', input).text).toMatch(/ext\. 12$/);
    }
  });
});

describe('a crew phone', () => {
  it('ignores both copy switches', () => {
    const rest = everyInput();
    for (const a of rest) {
      for (const b of rest) {
        const sameApartFromCopy =
          a.phoneService === b.phoneService &&
          a.switches.contactCustomers === b.switches.contactCustomers &&
          a.switches.viewCustomers === b.switches.viewCustomers;
        if (sameApartFromCopy) {
          expect(phoneDisplay('crew_phone', PHONE, null, a), `${describeInput(a)} vs ${describeInput(b)}`).toEqual(
            phoneDisplay('crew_phone', PHONE, null, b),
          );
        }
      }
    }
  });

  it('with Contact customers off yields no in-app action and, with the phone service on, no native link', () => {
    for (const input of everyInput().filter((i) => !i.switches.contactCustomers && i.phoneService)) {
      const d = phoneDisplay('crew_phone', PHONE, null, input);
      expect([d.tap, d.call, d.textAction], describeInput(input)).toEqual(['none', 'none', 'none']);
      expect(d.selectable).toBe(true);
    }
  });

  it('with the phone service and Contact customers on dials in the app', () => {
    for (const input of everyInput().filter((i) => i.phoneService && i.switches.contactCustomers)) {
      expect(phoneDisplay('crew_phone', PHONE, null, input).tap, describeInput(input)).toBe('in_app_dial');
    }
  });

  it('without the phone service keeps the native call and text links for anyone', () => {
    for (const input of everyInput().filter((i) => !i.phoneService)) {
      const d = phoneDisplay('crew_phone', PHONE, null, input);
      expect([d.tap, d.call, d.textAction], describeInput(input)).toEqual(['native_link', 'native_link', 'native_link']);
    }
  });

  it('never masks the digits', () => {
    for (const input of everyInput()) {
      expect(phoneDisplay('crew_phone', PHONE, null, input).text.replace(/\D/g, '')).toBe(PHONE);
    }
  });
});

describe('a customer email', () => {
  it('with Copy customer email off is not selectable, has no copy button and no mail link', () => {
    for (const input of everyInput().filter((i) => !i.switches.copyCustomerEmail)) {
      const d = customerEmailDisplay('pat@example.test', input);
      expect([d.selectable, d.copyButton, d.tap], describeInput(input)).toEqual([false, false, 'none']);
      expect(d.text).toBe('pat@example.test');
    }
  });

  it('with Copy customer email on is selectable, copyable and a mail link, whatever the phone service', () => {
    for (const input of everyInput().filter((i) => i.switches.copyCustomerEmail)) {
      const d = customerEmailDisplay('pat@example.test', input);
      expect([d.selectable, d.copyButton, d.tap], describeInput(input)).toEqual([true, true, 'mail_link']);
    }
  });
});

describe('the customer name', () => {
  it('links to the customer page exactly when View customers is on', () => {
    for (const input of everyInput()) {
      expect(customerNameDisplay(input).link, describeInput(input)).toBe(input.switches.viewCustomers);
    }
  });
});

describe('the pencil on a customer phone or email on a job', () => {
  const holding = (editContactDetails: boolean, editJobs: boolean): ContactPolicyInput => ({
    switches: { ...everyInput()[0]!.switches, editContactDetails, editJobs },
    phoneService: true,
  });

  it('shows with Edit job and lead contact details, or with Edit jobs, and not with neither', () => {
    expect(contactPencilDisplay(holding(true, false)).phoneEmail).toBe(true);
    expect(contactPencilDisplay(holding(false, true)).phoneEmail).toBe(true);
    expect(contactPencilDisplay(holding(true, true)).phoneEmail).toBe(true);
    expect(contactPencilDisplay(holding(false, false)).phoneEmail).toBe(false);
  });

  it('does not depend on the copy switches, Contact customers, View customers or the phone service', () => {
    for (const input of everyInput()) {
      const withPencil = { ...input, switches: { ...input.switches, editContactDetails: true } };
      expect(contactPencilDisplay(withPencil).phoneEmail, describeInput(input)).toBe(true);
      expect(contactPencilDisplay(input).phoneEmail, describeInput(input)).toBe(false);
    }
  });

  it('puts the name and company pencil with Edit jobs only: phones and emails alone do not reach the name', () => {
    // Edit jobs alone: phone, email and name pencils. Edit job and lead contact details alone: phone and email, not the name.
    expect(contactPencilDisplay(holding(false, true))).toEqual({ phoneEmail: true, name: true });
    expect(contactPencilDisplay(holding(true, false))).toEqual({ phoneEmail: true, name: false });
    expect(contactPencilDisplay(holding(true, true))).toEqual({ phoneEmail: true, name: true });
    expect(contactPencilDisplay(holding(false, false))).toEqual({ phoneEmail: false, name: false });
  });

  it('keeps the name pencil independent of the copy switches, Contact customers, View customers and the phone service', () => {
    for (const input of everyInput()) {
      const withJobs = { ...input, switches: { ...input.switches, editJobs: true } };
      const without = { ...input, switches: { ...input.switches, editJobs: false } };
      expect(contactPencilDisplay(withJobs).name, describeInput(input)).toBe(true);
      expect(contactPencilDisplay(without).name, describeInput(input)).toBe(false);
    }
  });
});

describe('Edit and Remove on an entry already made on the record', () => {
  const holding = (editContactDetails: boolean, editJobs: boolean): ContactPolicyInput => ({
    switches: { ...everyInput()[0]!.switches, editContactDetails, editJobs },
    phoneService: true,
  });
  /** An entry made by someone else, and one made by the viewer: the policy cannot tell them apart. */
  const entryBy = (kind: string, author: string) => ({ kind, created_by: { id: author, name: author } });

  it('shows on another person\'s phone or email for anyone who would get the pencil, and on nobody\'s for anyone else', () => {
    for (const kind of ['PHONE', 'EMAIL']) {
      for (const author of ['someone-else', 'me']) {
        expect(contactEntryActionsDisplay(holding(true, false), entryBy(kind, author))).toEqual({ edit: true, remove: true });
        expect(contactEntryActionsDisplay(holding(false, true), entryBy(kind, author))).toEqual({ edit: true, remove: true });
        expect(contactEntryActionsDisplay(holding(false, false), entryBy(kind, author))).toEqual({ edit: false, remove: false });
      }
    }
  });

  it('follows the pencil for the same input, whoever added the entry and whatever the copy switches say', () => {
    for (const input of everyInput()) {
      for (const hold of [true, false]) {
        const withPencil = { ...input, switches: { ...input.switches, editContactDetails: hold } };
        expect(contactEntryActionsDisplay(withPencil, entryBy('PHONE', 'someone-else')).edit, describeInput(input)).toBe(hold);
        expect(contactEntryActionsDisplay(withPencil, entryBy('PHONE', 'someone-else')).edit, describeInput(input)).toBe(contactPencilDisplay(withPencil).phoneEmail);
      }
    }
  });

  it('shows on a name or company entry for Edit jobs only', () => {
    for (const kind of ['FIRST_NAME', 'LAST_NAME', 'COMPANY_NAME']) {
      expect(contactEntryActionsDisplay(holding(true, false), entryBy(kind, 'someone-else'))).toEqual({ edit: false, remove: false });
      expect(contactEntryActionsDisplay(holding(false, true), entryBy(kind, 'someone-else'))).toEqual({ edit: true, remove: true });
    }
  });
});

describe('the pencil on a lead', () => {
  // On a lead, Edit jobs plays no part: the server's answer for THIS lead (Edit leads, or the creator still on it) does.
  const holding = (editContactDetails: boolean, editJobs: boolean): ContactPolicyInput => ({
    switches: { ...everyInput()[0]!.switches, editContactDetails, editJobs },
    phoneService: true,
  });
  const entryBy = (kind: string) => ({ kind, created_by: { id: 'someone-else', name: 'someone-else' } });

  it('gives phones and emails to Edit job and lead contact details or to a lead the person edits, and the name only to the second', () => {
    expect(contactPencilDisplay(holding(true, false), { kind: 'lead', mayEdit: false })).toEqual({ phoneEmail: true, name: false });
    expect(contactPencilDisplay(holding(false, false), { kind: 'lead', mayEdit: true })).toEqual({ phoneEmail: true, name: true });
    expect(contactPencilDisplay(holding(true, false), { kind: 'lead', mayEdit: true })).toEqual({ phoneEmail: true, name: true });
    expect(contactPencilDisplay(holding(false, false), { kind: 'lead', mayEdit: false })).toEqual({ phoneEmail: false, name: false });
  });

  it('is not given by Edit jobs', () => {
    expect(contactPencilDisplay(holding(false, true), { kind: 'lead', mayEdit: false })).toEqual({ phoneEmail: false, name: false });
    expect(contactEntryActionsDisplay(holding(false, true), entryBy('PHONE'), { kind: 'lead', mayEdit: false })).toEqual({ edit: false, remove: false });
  });

  it('puts Edit and Remove on an entry for the same people as the pencil of its kind, whoever added it', () => {
    for (const kind of ['PHONE', 'EMAIL']) {
      expect(contactEntryActionsDisplay(holding(true, false), entryBy(kind), { kind: 'lead', mayEdit: false })).toEqual({ edit: true, remove: true });
      expect(contactEntryActionsDisplay(holding(false, false), entryBy(kind), { kind: 'lead', mayEdit: true })).toEqual({ edit: true, remove: true });
      expect(contactEntryActionsDisplay(holding(false, false), entryBy(kind), { kind: 'lead', mayEdit: false })).toEqual({ edit: false, remove: false });
    }
    for (const kind of ['FIRST_NAME', 'LAST_NAME', 'COMPANY_NAME']) {
      expect(contactEntryActionsDisplay(holding(true, false), entryBy(kind), { kind: 'lead', mayEdit: false })).toEqual({ edit: false, remove: false });
      expect(contactEntryActionsDisplay(holding(false, false), entryBy(kind), { kind: 'lead', mayEdit: true })).toEqual({ edit: true, remove: true });
    }
  });

  it('gives a closed lead no pencil and no Edit or Remove, whatever the person holds and whoever added the entry', () => {
    for (const editContactDetails of BOOLS)
      for (const editJobs of BOOLS)
        for (const mayEdit of BOOLS) {
          const input = holding(editContactDetails, editJobs);
          const closed = { kind: 'lead', mayEdit, closed: true } as const;
          expect(contactPencilDisplay(input, closed)).toEqual({ phoneEmail: false, name: false });
          for (const kind of ['PHONE', 'EMAIL', 'FIRST_NAME', 'LAST_NAME', 'COMPANY_NAME']) {
            expect(contactEntryActionsDisplay(input, entryBy(kind), closed)).toEqual({ edit: false, remove: false });
          }
        }
  });

  it('treats a lead that is not closed as before', () => {
    expect(contactPencilDisplay(holding(true, false), { kind: 'lead', mayEdit: true, closed: false })).toEqual({ phoneEmail: true, name: true });
    expect(contactPencilDisplay(holding(false, false), { kind: 'lead', mayEdit: false, closed: false })).toEqual({ phoneEmail: false, name: false });
  });

  it('names the lead in its markers and the job in the job\'s', () => {
    expect(entryMarkers('lead')).toEqual({ only: 'This lead only', changed: 'Changed on this lead' });
    expect(entryMarkers('job')).toEqual({ only: 'This job only', changed: 'Changed on this job' });
  });
});

describe('the pencil on a locked job', () => {
  const holding = (editContactDetails: boolean, editJobs: boolean): ContactPolicyInput => ({
    switches: { ...everyInput()[0]!.switches, editContactDetails, editJobs },
    phoneService: true,
  });
  const entryBy = (kind: string) => ({ kind, created_by: { id: 'someone-else', name: 'someone-else' } });

  it('gives a locked job no pencil and no Edit or Remove, whatever the person holds and whoever added the entry', () => {
    for (const editContactDetails of BOOLS)
      for (const editJobs of BOOLS) {
        const input = holding(editContactDetails, editJobs);
        const locked = { kind: 'job', locked: true } as const;
        expect(contactPencilDisplay(input, locked)).toEqual({ phoneEmail: false, name: false });
        for (const kind of ['PHONE', 'EMAIL', 'FIRST_NAME', 'LAST_NAME', 'COMPANY_NAME']) {
          expect(contactEntryActionsDisplay(input, entryBy(kind), locked)).toEqual({ edit: false, remove: false });
        }
      }
  });

  it('treats a job that is not locked for the person as before, which is how a Change locked jobs holder sees it', () => {
    expect(contactPencilDisplay(holding(true, false), { kind: 'job', locked: false })).toEqual({ phoneEmail: true, name: false });
    expect(contactPencilDisplay(holding(false, true), { kind: 'job', locked: false })).toEqual({ phoneEmail: true, name: true });
    expect(contactPencilDisplay(holding(false, false), { kind: 'job', locked: false })).toEqual({ phoneEmail: false, name: false });
    expect(contactPencilDisplay(holding(false, true), { kind: 'job' })).toEqual({ phoneEmail: true, name: true });
  });

  it('leaves "Edit customer" alone: the customer record never locks', () => {
    for (const input of everyInput()) {
      expect(editCustomerDisplay(input).show, describeInput(input)).toBe(input.switches.viewCustomers && input.switches.editCustomers);
    }
  });
});

describe('"Edit customer" on a job or lead page', () => {
  const holding = (viewCustomers: boolean, editCustomers: boolean): ContactPolicyInput => ({
    switches: { ...everyInput()[0]!.switches, viewCustomers, editCustomers },
    phoneService: true,
  });

  it('shows exactly when both View customers and Edit customers are on', () => {
    expect(editCustomerDisplay(holding(true, true)).show).toBe(true);
    expect(editCustomerDisplay(holding(true, false)).show).toBe(false);
    expect(editCustomerDisplay(holding(false, true)).show).toBe(false);
    expect(editCustomerDisplay(holding(false, false)).show).toBe(false);
  });

  it('reads Edit customers by the key the catalog gives it', () => {
    const values = { [catalogToggle('View customers').key]: true, [catalogToggle('Edit customers').key]: true };
    const input = { switches: contactRulesFrom(values), phoneService: false };
    expect(editCustomerDisplay(input).show).toBe(true);
    expect(editCustomerDisplay({ switches: contactRulesFrom(undefined), phoneService: false }).show).toBe(false);
  });
});
