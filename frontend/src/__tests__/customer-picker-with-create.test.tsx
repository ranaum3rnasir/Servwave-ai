import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { CustomerPickerWithCreate, customerRow } from '@/components/crm/CustomerPickerWithCreate';
import api from '@/lib/axios';

vi.mock('@/lib/axios', () => ({ default: { get: vi.fn(), post: vi.fn() } }));
// Ability + toast are only needed by create-mode (Task 2) but must not blow up on mount.
vi.mock('@/contexts/AbilityContext', () => ({ useAppAbility: () => ({ can: () => true }) }));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

const wrap = (ui: React.ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
};

describe('customerRow — display order', () => {
  // Order: customer ID, first name, last name, company, email. The ID always leads — it's
  // the one field every customer has. The rest follow in that order, and a missing field is
  // skipped rather than leaving a hole. None of them is required.
  //
  // These assert POSITION (which field leads vs. trails), which a render test can't do:
  // getByText('solo@x.test') passes whether the email leads or is buried on the detail
  // line, so it would go green against a broken ordering.
  const base = { id: 'c1', first_name: null, last_name: null, company_name: null, email: null, customer_number: 'C0001' };

  it('leads with the ID then the full name, trailing company then email', () => {
    expect(customerRow({ ...base, first_name: 'Ada', last_name: 'Byron', company_name: 'Acme Co', email: 'a@acme.test' }))
      .toEqual({ primary: '#C0001 Ada Byron', details: 'Acme Co · a@acme.test' });
  });

  it('skips a missing last name rather than padding it', () => {
    expect(customerRow({ ...base, first_name: 'Nicolas', company_name: 'Byte Ltd', email: 'nic@byte.test' }))
      .toEqual({ primary: '#C0001 Nicolas', details: 'Byte Ltd · nic@byte.test' });
  });

  it('keeps the ID leading when there is no person at all', () => {
    expect(customerRow({ ...base, company_name: 'Acme Co', email: 'hi@acme.test' }))
      .toEqual({ primary: '#C0001', details: 'Acme Co · hi@acme.test' });
  });

  it('shows an email-only customer as ID then email', () => {
    expect(customerRow({ ...base, email: 'solo@x.test' }))
      .toEqual({ primary: '#C0001', details: 'solo@x.test' });
  });

  it('renders the ID alone when every other field is missing', () => {
    expect(customerRow(base)).toEqual({ primary: '#C0001', details: '' });
  });

  it('never repeats a field across both lines', () => {
    const { primary, details } = customerRow({ ...base, first_name: 'Ada', company_name: 'Acme Co', email: 'hi@acme.test' });
    expect(details).not.toContain(primary);
    expect(details).not.toContain('Ada');
  });
});

describe('CustomerPickerWithCreate — search', () => {
  beforeEach(() => vi.clearAllMocks());

  it('searches server-side and emits the picked customer', async () => {
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { customers: [
        { id: 'c1', first_name: 'Ada', last_name: 'Byron', company_name: null, customer_number: 'C0001' },
      ] },
    });
    const onChange = vi.fn();
    wrap(<CustomerPickerWithCreate value="" valueLabel="" onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: /select customer/i }));
    fireEvent.change(await screen.findByPlaceholderText(/search/i), { target: { value: 'ada' } });

    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/api/customers', { params: { search: 'ada', limit: 15 } }),
    );
    fireEvent.click(await screen.findByText(/Ada Byron/));
    expect(onChange).toHaveBeenCalledWith('c1', 'Ada Byron');
  });

  it('shows name, company and email on each row so near-duplicates are distinguishable', async () => {
    // Two people at the same company: name alone can't tell them apart, and company alone
    // can't either — the row has to carry both plus the email.
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { customers: [
        { id: 'c1', first_name: 'Ada', last_name: 'Byron', company_name: 'Acme Co',
          email: 'ada@acme.test', customer_number: 'C0001' },
        { id: 'c2', first_name: 'Ada', last_name: 'Nelson', company_name: 'Acme Co',
          email: 'ada.n@acme.test', customer_number: 'C0002' },
      ] },
    });
    wrap(<CustomerPickerWithCreate value="" valueLabel="" onChange={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /select customer/i }));
    fireEvent.change(await screen.findByPlaceholderText(/search/i), { target: { value: 'ada' } });

    // Last name distinguishes the two rows, behind the leading customer ID...
    expect(await screen.findByText('#C0001 Ada Byron')).toBeInTheDocument();
    expect(await screen.findByText('#C0002 Ada Nelson')).toBeInTheDocument();
    // ...company is visible even though these customers have one (customerLabel would have
    // shown "Acme Co" for BOTH and hidden the names entirely)...
    expect(screen.getAllByText(/Acme Co/)).toHaveLength(2);
    // ...and the emails are what actually disambiguate them.
    expect(screen.getByText(/ada@acme\.test/)).toBeInTheDocument();
    expect(screen.getByText(/ada\.n@acme\.test/)).toBeInTheDocument();
  });

  it('falls back cleanly when a customer has no company or email', async () => {
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { customers: [
        { id: 'c3', first_name: 'Solo', last_name: null, company_name: null,
          email: null, customer_number: 'C0003' },
      ] },
    });
    wrap(<CustomerPickerWithCreate value="" valueLabel="" onChange={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /select customer/i }));
    fireEvent.change(await screen.findByPlaceholderText(/search/i), { target: { value: 'solo' } });

    expect(await screen.findByText('#C0003 Solo')).toBeInTheDocument();
    // No detail line at all, rather than an empty one or a dangling separator.
    expect(screen.queryByText(/·/)).not.toBeInTheDocument();
  });

  it('shows error message when search request fails', async () => {
    (api.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network error'));
    const onChange = vi.fn();
    wrap(<CustomerPickerWithCreate value="" valueLabel="" onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: /select customer/i }));
    fireEvent.change(await screen.findByPlaceholderText(/search/i), { target: { value: 'test' } });

    await waitFor(() =>
      expect(screen.getByText(/Couldn't load customers/i)).toBeInTheDocument(),
    );
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('CustomerPickerWithCreate — create', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates a new customer with an address and emits it', async () => {
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { customers: [] } });
    (api.post as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { customer: { id: 'new1', first_name: 'Zed', last_name: null, company_name: null, customer_number: 'C0009' } },
    });
    const onChange = vi.fn();
    wrap(<CustomerPickerWithCreate value="" valueLabel="" onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: /select customer/i }));
    fireEvent.change(await screen.findByPlaceholderText(/search/i), { target: { value: 'Zed' } });
    fireEvent.click(await screen.findByRole('button', { name: /create/i }));

    fireEvent.change(screen.getByLabelText(/first name/i), { target: { value: 'Zed' } });
    fireEvent.change(screen.getByLabelText(/phone/i), { target: { value: '5551230000' } });
    fireEvent.change(screen.getByLabelText(/^address/i), { target: { value: '1 Main St' } });
    fireEvent.change(screen.getByLabelText(/city/i), { target: { value: 'Austin' } });
    fireEvent.change(screen.getByLabelText(/state/i), { target: { value: 'TX' } });
    fireEvent.change(screen.getByLabelText(/zip/i), { target: { value: '78701' } });

    fireEvent.click(screen.getByRole('button', { name: /create & select/i }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/api/customers',
      expect.objectContaining({
        first_name: 'Zed',
        locations: [expect.objectContaining({ address_line1: '1 Main St', city: 'Austin', state: 'TX', zip: '78701', is_primary: true })],
      }),
    ));
    expect(onChange).toHaveBeenCalledWith('new1', 'Zed');
  });

  it('seeds the name (not the phone) from a company-ish query that contains digits', async () => {
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { customers: [] } });
    wrap(<CustomerPickerWithCreate value="" valueLabel="" onChange={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /select customer/i }));
    fireEvent.change(await screen.findByLabelText(/search customers/i), { target: { value: 'A1 Garage Doors 24' } });
    fireEvent.click(await screen.findByRole('button', { name: /create/i }));

    // Digit-bearing business names must not be mistaken for phone numbers.
    expect(screen.getByLabelText(/first name/i)).toHaveValue('A1 Garage Doors 24');
    expect(screen.getByLabelText(/phone/i)).toHaveValue('');
  });

  it('seeds the phone from a query that is actually a phone number', async () => {
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { customers: [] } });
    wrap(<CustomerPickerWithCreate value="" valueLabel="" onChange={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /select customer/i }));
    fireEvent.change(await screen.findByLabelText(/search customers/i), { target: { value: '5551230000' } });
    fireEvent.click(await screen.findByRole('button', { name: /create/i }));

    expect(screen.getByLabelText(/phone/i)).toHaveValue('(555) 123-0000');
    expect(screen.getByLabelText(/first name/i)).toHaveValue('');
  });

  it('surfaces the duplicate dialog on 409 and overrides on "create anyway"', async () => {
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { customers: [] } });
    (api.post as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce({ response: { status: 409, data: { error: 'duplicate', existing: { id: 'dupe', customer_number: 'C0001', first_name: 'Dup', last_name: null, company_name: null, email: null, phone: '5551230000' } } } })
      .mockResolvedValueOnce({ data: { customer: { id: 'forced', first_name: 'Dup', last_name: null, company_name: null, customer_number: 'C0010' } } });
    const onChange = vi.fn();
    wrap(<CustomerPickerWithCreate value="" valueLabel="" onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: /select customer/i }));
    fireEvent.click(await screen.findByRole('button', { name: /create/i }));
    fireEvent.change(screen.getByLabelText(/first name/i), { target: { value: 'Dup' } });
    fireEvent.change(screen.getByLabelText(/phone/i), { target: { value: '5551230000' } });
    fireEvent.change(screen.getByLabelText(/^address/i), { target: { value: '1 Main St' } });
    fireEvent.change(screen.getByLabelText(/city/i), { target: { value: 'Austin' } });
    fireEvent.change(screen.getByLabelText(/state/i), { target: { value: 'TX' } });
    fireEvent.change(screen.getByLabelText(/zip/i), { target: { value: '78701' } });
    fireEvent.click(screen.getByRole('button', { name: /create & select/i }));

    fireEvent.click(await screen.findByRole('button', { name: /create anyway/i }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('forced', 'Dup'));
    expect(api.post).toHaveBeenLastCalledWith('/api/customers?override=true', expect.any(Object));
  });

  it('does not dismiss the popover when the duplicate dialog claims focus', async () => {
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { customers: [] } });
    (api.post as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      response: { status: 409, data: { error: 'duplicate', existing: { id: 'dupe', customer_number: 'C0001', first_name: 'Dup', last_name: null, company_name: null, email: null, phone: '5551230000' } } },
    });
    wrap(<CustomerPickerWithCreate value="" valueLabel="" onChange={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /select customer/i }));
    fireEvent.click(await screen.findByRole('button', { name: /create/i }));
    fireEvent.change(screen.getByLabelText(/first name/i), { target: { value: 'Dup' } });
    fireEvent.change(screen.getByLabelText(/phone/i), { target: { value: '5551230000' } });
    fireEvent.change(screen.getByLabelText(/^address/i), { target: { value: '1 Main St' } });
    fireEvent.change(screen.getByLabelText(/city/i), { target: { value: 'Austin' } });
    fireEvent.change(screen.getByLabelText(/state/i), { target: { value: 'TX' } });
    fireEvent.change(screen.getByLabelText(/zip/i), { target: { value: '78701' } });
    fireEvent.click(screen.getByRole('button', { name: /create & select/i }));

    await screen.findByRole('button', { name: /create anyway/i });
    // The only element with role="dialog" here is the DuplicateCustomerDialog: this
    // popover is non-modal, and Radix omits the role on non-modal popover content.
    const dialog = screen.getByRole('dialog');

    // Radix's DismissableLayer only treats a `focusin` as "outside" while its internal
    // isFocusInsideReactTreeRef is false. The popover's autoFocus'd search input set that
    // ref to true on mount, and jsdom fires no focusout when that input unmounts (mode
    // flips to 'create') — so the ref stays stuck true and a bare focusIn is a NO-OP that
    // never reaches the guard. Blurring an element that IS inside the popover content
    // first resets the ref via React's onBlurCapture, which is exactly the handoff a real
    // browser performs when focus leaves the popover for the newly-mounted modal dialog.
    fireEvent.focusOut(screen.getByLabelText(/first name/i));

    // Radix dispatches FOCUS_OUTSIDE on the focusin target with bubbles:false, so this
    // counter has to be attached to the dialog itself.
    let focusOutsideFired = 0;
    dialog.addEventListener('dismissableLayer.focusOutside', () => { focusOutsideFired++; });

    // The modal dialog claims focus. It is portalled outside the popover's content tree,
    // so Radix reads this as an interact-outside on the popover's dismissable layer.
    fireEvent.focusIn(dialog);

    // Guard the guard. If Radix never evaluates interact-outside at all, the assertion
    // below would pass vacuously and this spec would be a placebo that reads as coverage.
    // Assert the dismissal mechanism actually fired BEFORE asserting it was suppressed.
    expect(focusOutsideFired).toBeGreaterThan(0);

    // …and the guard suppressed it: the popover — and the duplicate dialog it renders —
    // must still be mounted and usable.
    expect(screen.getByRole('button', { name: /create anyway/i })).toBeInTheDocument();
  });
});
