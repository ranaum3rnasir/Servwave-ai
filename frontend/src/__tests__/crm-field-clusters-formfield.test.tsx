/**
 * Phase 11b/11d - the CRM field clusters after FormField adoption.
 *
 * These four components are the shared address + customer-identity blocks:
 * they render inside the lead form, the job form, the standalone invoice form,
 * the service-plan builder and the customer detail page, so a one-pixel drift
 * here shows up on five surfaces at once. This file is the pin that says the
 * conversion was STRUCTURAL, not visual.
 *
 * Every class string below was captured by rendering the pre-conversion
 * component (origin/staging) and the converted one side by side, not typed
 * from the source. The three that are byte-identical between the two renders
 * are asserted as such on purpose - if a later edit reaches past FormField and
 * restyles a label or a control, that is what goes red first.
 *
 * The four deltas the conversion DOES introduce, all asserted here rather than
 * described in a PR body nobody re-reads:
 *
 *   1. The wrapper `<div>` becomes `flex flex-col gap-1.5` - 6px between the
 *      label and the control where there was none, and the error message's own
 *      `mt-1` (4px) is replaced by that same 6px gap.
 *   2. `Address *` (one text node) becomes `Address` + a `text-danger-text`
 *      span, so the asterisk is terracotta instead of inheriting the label's
 *      `text-text-secondary`.
 *   3. The error paragraph moves from `text-danger` (--danger, #BF5A4C, 3.79:1
 *      on a light surface) to `text-danger-text` (#AC5144, 4.52:1). tokens.css
 *      documents that exact split; this is the AA-tuned one.
 *   4. NEW: `aria-describedby` / `aria-invalid` on the control, and a real
 *      `htmlFor` on labels that had none. This is the defect FormField exists
 *      to close and none of these four files had it everywhere before.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import { renderWithProviders } from './helpers';
import {
  PickOrAccreteLocation,
  ADD_NEW_LOCATION,
  type PickOrAccreteLocationValue,
} from '@/components/crm/PickOrAccreteLocation';
import {
  PickOrCreateCustomer,
  type CustomerContactFields,
} from '@/components/crm/PickOrCreateCustomer';
import { LocationFormDialog } from '@/components/customers/LocationFormDialog';

vi.mock('@/lib/axios', () => ({
  default: { get: vi.fn().mockResolvedValue({ data: { customers: [] } }), post: vi.fn(), patch: vi.fn() },
}));

// ─── Byte-exact rendered class strings ────────────────────────────────────
//
// FIELD_ROOT is FormField's own Stack (gap defaults to 1.5). LABEL and INPUT
// are the primitives' propless renders and are IDENTICAL to what these files
// emitted before the conversion - the call sites never passed a className to
// either, so wrapping them cannot move them.

const FIELD_ROOT_CLASS = 'flex flex-col gap-1.5';

const LABEL_CLASS =
  'text-sm leading-none transition-colors duration-300 hover:text-text-primary ' +
  'has-[+input:is(:hover,:focus)]:text-text-primary has-[+textarea:is(:hover,:focus)]:text-text-primary ' +
  'peer-disabled:cursor-not-allowed peer-disabled:opacity-70 text-text-secondary font-bold';

const INPUT_CLASS =
  'flex h-11 w-full rounded border-2 border-transparent bg-text-primary/5 px-4 py-2 text-base ' +
  'transition-colors duration-300 file:border-0 file:bg-transparent file:text-sm file:font-medium ' +
  'file:text-text-primary placeholder:text-text-soft hover:border-primary focus-visible:outline-none ' +
  'focus-visible:border-primary disabled:cursor-not-allowed disabled:opacity-50 md:text-sm';

const ERROR_CLASS = 'text-xs text-danger-text';

const EMPTY_ADDRESS = { address_line1: '', address_line2: '', city: '', state: '', zip: '' };

function renderAddressCluster(
  overrides?: Partial<React.ComponentProps<typeof PickOrAccreteLocation>>,
) {
  const value: PickOrAccreteLocationValue = {
    locationId: ADD_NEW_LOCATION,
    address: EMPTY_ADDRESS,
  };
  return render(
    <PickOrAccreteLocation
      locations={[]}
      showPicker={false}
      required
      value={value}
      onChange={() => {}}
      {...overrides}
    />,
  );
}

describe('PickOrAccreteLocation address cluster - rendered contract', () => {
  it('wraps every field in FormField\'s own Stack, byte-exact, and nothing else', () => {
    const { container } = renderAddressCluster();
    const roots = [...container.querySelectorAll('label')].map((l) => l.parentElement!);
    expect(roots).toHaveLength(5); // Address, Unit, City, State, ZIP
    for (const root of roots) expect(root.getAttribute('class')).toBe(FIELD_ROOT_CLASS);
  });

  it('leaves the Label and Input class strings byte-identical to the pre-conversion render', () => {
    renderAddressCluster();
    const city = screen.getByLabelText(/^city/i);
    expect(city.getAttribute('class')).toBe(INPUT_CLASS);
    expect(document.querySelector('label[for="pal-city"]')!.getAttribute('class')).toBe(LABEL_CLASS);
  });

  it('keeps every idPrefix-derived id exactly as the call sites and tests target it', () => {
    renderAddressCluster();
    for (const id of ['pal-address-line1', 'pal-address-line2', 'pal-city', 'pal-state', 'pal-zip']) {
      const control = document.getElementById(id);
      expect(control, id).not.toBeNull();
      expect(document.querySelector(`label[for="${id}"]`), id).not.toBeNull();
    }
  });

  it('honours a custom idPrefix on both ends of the pair, so two mounted instances cannot cross-wire', () => {
    renderAddressCluster({ idPrefix: 'second' });
    const zip = document.getElementById('second-zip')!;
    expect(zip).not.toBeNull();
    expect(document.querySelector('label[for="second-zip"]')!.textContent).toBe('ZIP *');
  });

  it('renders the required asterisk through Text, in the danger tone (delta 2)', () => {
    renderAddressCluster();
    const label = document.querySelector('label[for="pal-city"]')!;
    expect(label.textContent).toBe('City *');
    expect(label.querySelector('span')!.getAttribute('class')).toBe('text-danger-text');
  });

  it('renders no asterisk at all when required is false', () => {
    renderAddressCluster({ required: false });
    expect(document.querySelector('label[for="pal-city"]')!.textContent).toBe('City');
    expect(document.querySelector('label[for="pal-city"]')!.querySelector('span')).toBeNull();
  });

  it('wires an error to the control via aria-describedby + aria-invalid, and pins the error class (deltas 3 and 4)', () => {
    renderAddressCluster({ errors: { city: 'City is required' } });
    const city = screen.getByLabelText(/^city/i);
    expect(city).toHaveAttribute('aria-describedby', 'pal-city-error');
    expect(city).toHaveAttribute('aria-invalid', 'true');
    const message = document.getElementById('pal-city-error')!;
    expect(message.tagName).toBe('P');
    expect(message.textContent).toBe('City is required');
    expect(message.getAttribute('class')).toBe(ERROR_CLASS);
  });

  it('sets neither aria attribute when the field has no error', () => {
    renderAddressCluster();
    const city = screen.getByLabelText(/^city/i);
    expect(city).not.toHaveAttribute('aria-describedby');
    expect(city).not.toHaveAttribute('aria-invalid');
  });

  it('KNOWN GAP: AddressAutocomplete takes id but drops aria-*, so the address error is not announced', () => {
    // AddressAutocomplete destructures a fixed prop list and has no rest spread,
    // so FormField's cloneElement can hand it an id (which it forwards to its
    // Input) but not aria-describedby/aria-invalid. Not a regression - that
    // field had no aria wiring before either - and NOT worked around by adding
    // anything to FormField. Pinned so the day someone gives that component a
    // rest spread, this test tells them the gap closed.
    renderAddressCluster({ errors: { address_line1: 'Address is required' } });
    const address = document.getElementById('pal-address-line1')!;
    expect(address).not.toBeNull();
    expect(address).not.toHaveAttribute('aria-describedby');
    expect(document.getElementById('pal-address-line1-error')!.textContent).toBe('Address is required');
  });

  it('puts the generated id on the Select TRIGGER, since Radix Select root renders no DOM', () => {
    render(
      <PickOrAccreteLocation
        locations={[]}
        showPicker
        label="Location"
        required
        value={{ locationId: '', address: EMPTY_ADDRESS }}
        onChange={() => {}}
      />,
    );
    const trigger = screen.getByLabelText(/^location/i);
    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger.id).toBeTruthy();
  });

  it('keeps pickerNote outside the FormField, so a caller-supplied <p> is never nested in one', () => {
    const { container } = render(
      <PickOrAccreteLocation
        locations={[]}
        showPicker
        label="Location"
        value={{ locationId: '', address: EMPTY_ADDRESS }}
        onChange={() => {}}
        pickerNote={<p className="mt-1 text-xs text-text-secondary">Tax note.</p>}
      />,
    );
    const note = screen.getByText('Tax note.');
    expect(note.tagName).toBe('P');
    // Its parent is the picker's own plain wrapper div, NOT FormField's Stack -
    // which is what proves the note did not become `hint` (a <p> inside a <p>,
    // which jsdom and every browser silently reparent).
    expect(note.parentElement).toBe(container.firstElementChild);
    expect(note.parentElement!.tagName).toBe('DIV');
    expect(note.parentElement!.getAttribute('class')).toBeNull();
    expect(note.parentElement!.firstElementChild!.getAttribute('class')).toBe(FIELD_ROOT_CLASS);
  });
});

// ─── PickOrCreateCustomer ───────────────────────────────────────────────────

const EMPTY_FIELDS: CustomerContactFields = {
  first_name: '',
  last_name: '',
  company_name: '',
  phone: '',
  email: '',
};

function renderContactCluster(
  overrides?: Partial<React.ComponentProps<typeof PickOrCreateCustomer>>,
) {
  return renderWithProviders(
    <PickOrCreateCustomer
      fields={EMPTY_FIELDS}
      onFieldChange={() => {}}
      selectedCustomer={null}
      onSelectCustomer={() => {}}
      {...overrides}
    />,
  );
}

describe('PickOrCreateCustomer contact cluster - rendered contract', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps the literal id="phone" and id="email" three host pages refocus by getElementById', () => {
    // JobFormPage/LeadFormPage/StandaloneInvoiceFormPage all run
    // `document.getElementById(field)?.focus()` with field 'phone' | 'email'
    // after a duplicate-customer collision. A generated id would break it
    // silently - no type error, no test, just a focus that never lands.
    renderContactCluster();
    expect(document.getElementById('phone')!.tagName).toBe('INPUT');
    expect(document.getElementById('email')!.tagName).toBe('INPUT');
    expect(document.querySelector('label[for="phone"]')!.textContent).toBe('Phone');
    expect(document.querySelector('label[for="email"]')!.textContent).toBe('Email');
  });

  it('newly wires the four labels that pointed at nothing before, via generated ids', () => {
    renderContactCluster();
    for (const name of [/^first name/i, /^last name/i, /^company name/i]) {
      const control = screen.getByLabelText(name);
      expect(control.tagName).toBe('INPUT');
      expect(control.id).toBeTruthy();
    }
  });

  // "placeholder index" stays two words on purpose. check-unresolved-classes.mjs
  // tokenises raw SOURCE TEXT on a word-plus-hyphen shape with no idea it is
  // reading prose, so the hyphenated form reads as a real Tailwind placeholder
  // utility that resolves to no CSS. It reddened that guard on the first full-suite
  // run of this branch.
  it('preserves the field order by placeholder index that the blur/split tests depend on', () => {
    // pick-or-create-customer-blur.test.tsx and standalone-invoice-form.test.tsx
    // both index getAllByPlaceholderText('Search...')[0] as first_name.
    renderContactCluster();
    const searchable = screen.getAllByPlaceholderText('Search...');
    expect(searchable).toHaveLength(5);
    expect(searchable.map((el) => el.labels![0]!.textContent)).toEqual([
      'First Name',
      'Last Name',
      'Phone',
      'Email',
      'Company Name',
    ]);
    expect(searchable[2]!.id).toBe('phone');
    expect(searchable[3]!.id).toBe('email');
  });

  it('marks only First Name required, never Phone or Email (SERV10X-35)', () => {
    renderContactCluster({ required: true });
    expect(screen.getByLabelText(/^first name/i).labels![0]!.textContent).toBe('First Name *');
    expect(document.querySelector('label[for="phone"]')!.textContent).toBe('Phone');
    expect(document.querySelector('label[for="email"]')!.textContent).toBe('Email');
  });

  it('keeps the Ext input inside the same row as Phone, with the id on Phone (render-prop child)', () => {
    renderContactCluster({ showPhoneExt: true });
    const phone = document.getElementById('phone')!;
    const ext = document.getElementById('phone_ext')!;
    expect(phone.parentElement).toBe(ext.parentElement);
    expect(phone.parentElement!.getAttribute('class')).toBe('flex items-center gap-2');
    expect(phone.getAttribute('class')).toBe(`${INPUT_CLASS} flex-1`);
  });

  it('DEFERRAL: phone_ext keeps its own paragraph - FormField has ONE error slot, taken by phone', () => {
    renderContactCluster({
      showPhoneExt: true,
      errors: { phone: 'Phone is invalid', phone_ext: 'Ext must be digits' },
    });
    const phoneError = screen.getByText('Phone is invalid');
    expect(phoneError.getAttribute('class')).toBe(ERROR_CLASS);
    expect(document.getElementById('phone')).toHaveAttribute('aria-describedby', 'phone-error');

    const extError = screen.getByText('Ext must be digits');
    expect(extError.getAttribute('class')).toBe('mt-1 text-xs text-danger');
    expect(extError.id).toBe('');
  });

  it('keeps the search dropdown a sibling of the FormField inside the relative wrapper', () => {
    // The dropdown is absolutely positioned against `.relative`; if the
    // conversion had swallowed it into FormField's Stack it would still paint,
    // but the Stack's gap would shift its static position.
    renderContactCluster();
    const relative = screen.getByLabelText(/^first name/i).closest('.relative')!;
    expect(relative.firstElementChild!.getAttribute('class')).toBe(FIELD_ROOT_CLASS);
  });
});

// ─── LocationFormDialog ─────────────────────────────────────────────────────

describe('LocationFormDialog - rendered contract', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps every htmlFor equal to its react-hook-form register() field name', () => {
    renderWithProviders(
      <LocationFormDialog open onOpenChange={() => {}} customerId="c1" />,
    );
    for (const name of ['address_line1', 'address_line2', 'city', 'state', 'zip']) {
      expect(document.getElementById(name), name).not.toBeNull();
      expect(document.querySelector(`label[for="${name}"]`), name).not.toBeNull();
    }
  });

  it('renders each converted field through FormField\'s Stack, byte-exact', () => {
    renderWithProviders(
      <LocationFormDialog open onOpenChange={() => {}} customerId="c1" />,
    );
    for (const name of ['address_line1', 'address_line2', 'city', 'state', 'zip']) {
      const root = document.querySelector(`label[for="${name}"]`)!.parentElement!;
      expect(root.getAttribute('class'), name).toBe(FIELD_ROOT_CLASS);
    }
  });

  it('DEFERRAL: the Primary Location switch row is NOT a FormField - label beside control, not above', () => {
    // FormField's Stack is a label-above-control column. This row is a
    // justified flex line. Fitting it would mean an orientation prop on the
    // shared pattern, which this batch is explicitly not allowed to add.
    renderWithProviders(
      <LocationFormDialog open onOpenChange={() => {}} customerId="c1" />,
    );
    const row = document.querySelector('label[for="is_primary"]')!.parentElement!;
    expect(row.getAttribute('class')).toBe('flex items-center justify-between');
    expect(row.getAttribute('class')).not.toBe(FIELD_ROOT_CLASS);
  });

  it('marks Address, City, State and ZIP required and leaves Unit / Suite unmarked', () => {
    renderWithProviders(
      <LocationFormDialog open onOpenChange={() => {}} customerId="c1" />,
    );
    expect(document.querySelector('label[for="address_line1"]')!.textContent).toBe('Address *');
    expect(document.querySelector('label[for="city"]')!.textContent).toBe('City *');
    expect(document.querySelector('label[for="state"]')!.textContent).toBe('State *');
    expect(document.querySelector('label[for="zip"]')!.textContent).toBe('ZIP Code *');
    expect(document.querySelector('label[for="address_line2"]')!.textContent).toBe('Unit / Suite');
  });
});
