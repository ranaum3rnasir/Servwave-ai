/**
 * FormField adoption on JobFormPage / LeadFormPage - phase 11b rendered contract.
 *
 * The FormField unit test (components/patterns/__tests__/FormField.test.tsx)
 * proves the pattern wires an id in isolation. This file proves the two
 * converted CALL SITES actually get that wiring, and - the part a unit test
 * cannot see - that wrapping a control in the pattern did not restyle it.
 *
 * Four things are asserted.
 *
 * 1. THE DEFECT THE CONVERSION CLOSES: before this change every label on these
 *    two pages was a propless `<Label>` with no `htmlFor` at all, sitting next
 *    to a control with no `id`. Each converted field now has one generated id
 *    on both ends.
 * 2. BYTE-EXACT CLASS STRINGS FOR EVERYTHING FormField ITSELF AUTHORS: the
 *    root Stack and the error paragraph. Literals, same as the pattern's own
 *    test, because those two strings ARE the pattern's rendered contract.
 * 3. BYTE-EXACT CLASS STRINGS FOR THE CONTROLS, BY REFERENCE RENDER, NOT BY
 *    LITERAL. The claim under test is "the conversion changed no control's
 *    appearance", and the only honest way to state that is to render the bare
 *    primitive in the same test and compare the two strings. A hardcoded copy
 *    of input.tsx's base string would restate the primitive rather than check
 *    the page against it, and would go red for edits that never touched these
 *    pages.
 * 4. THE DEFERRALS ARE PINNED, NOT ASSUMED. LeadFormPage's four schedule
 *    fields are deliberately NOT converted (TimeSelect declares an `id` prop
 *    but never forwards it to the control it renders). The assertion below
 *    records that as the current, known state, so the day SelectField can
 *    carry an id this test goes red and points at the field left behind.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import JobFormPage from '@/pages/JobFormPage';
import LeadFormPage from '@/pages/LeadFormPage';
import { buildAbility } from '@/lib/ability';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => vi.fn() };
});

vi.mock('@/lib/api/organization', () => ({
  useOrganization: () => ({ data: { job_type_options: [], source_options: [] } }),
  useUpdateOrganization: () => ({ mutate: vi.fn() }),
}));

vi.mock('@/lib/api/users', () => ({
  useAssignableUsers: () => ({ data: [] }),
}));

const mockApi = vi.mocked(api);
const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

const EXISTING = {
  id: 'c0000000-0000-0000-0000-0000000000aa',
  first_name: 'Imported',
  last_name: 'Customer',
  company_name: null,
  phone: '2015550100',
  email: null,
  ad_source: null,
  service_locations: [
    {
      id: 'l0000000-0000-0000-0000-0000000000bb',
      address_line1: '12 Elm St',
      address_line2: null,
      city: 'Ridgefield',
      state: 'NJ',
      zip: '07657',
      is_primary: true,
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockImplementation((url: string) => {
    if (url === `/api/customers/${EXISTING.id}`) {
      return Promise.resolve({ data: { customer: EXISTING } });
    }
    return Promise.resolve({ data: { customers: [] } });
  });
  mockApi.post.mockResolvedValue({ data: { job: { id: 'j1' } } });
});

/** The FormField wrapper for `label`, located from the label element upwards. */
function fieldRootFor(labelText: string): HTMLElement {
  const label = screen.getByText(labelText);
  return label.parentElement as HTMLElement;
}

describe('JobFormPage - FormField id wiring on the converted fields', () => {
  it('wires one generated id to both the label and the control, on a Textarea field that had neither before', () => {
    renderWithProviders(<JobFormPage />, { ability: adminAbility, initialEntries: ['/jobs/new'] });

    const textarea = screen.getByPlaceholderText('Describe the work needed...');
    const label = screen.getByText('Service Request *');

    expect(textarea.id).toBeTruthy();
    expect(label.getAttribute('for')).toBe(textarea.id);
    expect(screen.getByLabelText('Service Request *')).toBe(textarea);
  });

  it('wires an Input field the same way', () => {
    renderWithProviders(<JobFormPage />, { ability: adminAbility, initialEntries: ['/jobs/new'] });

    const city = screen.getByLabelText('City *');
    expect(city.tagName).toBe('INPUT');
    expect(city.id).toBeTruthy();
    expect(screen.getByText('City *').getAttribute('for')).toBe(city.id);
  });

  it('wires the render-prop Select field: the label points at the Radix trigger button', async () => {
    renderWithProviders(<JobFormPage />, {
      ability: adminAbility,
      initialEntries: [`/jobs/new?customer_id=${EXISTING.id}`],
    });

    await waitFor(() => expect(screen.getByDisplayValue('Imported')).toBeInTheDocument());

    const trigger = screen.getByLabelText('Location *');
    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger.id).toBeTruthy();
    expect(screen.getByText('Location *').getAttribute('for')).toBe(trigger.id);
  });

  it('gives every converted field a DISTINCT id - one useId per FormField, not one shared literal', () => {
    renderWithProviders(<JobFormPage />, { ability: adminAbility, initialEntries: ['/jobs/new'] });

    const ids = ['Service Request *', 'City *', 'State *', 'ZIP *', 'Unit'].map(
      (text) => (screen.getByLabelText(text) as HTMLElement).id,
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every(Boolean)).toBe(true);
  });
});

describe('JobFormPage - FormField renders the exact class strings it owns', () => {
  it('the field root is the pattern Stack and nothing else, byte-exact', () => {
    renderWithProviders(<JobFormPage />, { ability: adminAbility, initialEntries: ['/jobs/new'] });

    expect(fieldRootFor('Service Request *').getAttribute('class')).toBe('flex flex-col gap-1.5');
    expect(fieldRootFor('City *').getAttribute('class')).toBe('flex flex-col gap-1.5');
  });

  it('the error line renders through Text, byte-exact, wired to the control by aria-describedby and aria-invalid', async () => {
    renderWithProviders(<JobFormPage />, {
      ability: adminAbility,
      initialEntries: [`/jobs/new?customer_id=${EXISTING.id}`],
    });
    await waitFor(() => expect(screen.getByDisplayValue('Imported')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /create job/i }));

    const error = await screen.findByText('Service request is required');
    const textarea = screen.getByPlaceholderText('Describe the work needed...');

    expect(error.tagName).toBe('P');
    expect(error.getAttribute('class')).toBe('text-xs text-danger-text');
    expect(error.id).toBe(`${textarea.id}-error`);
    expect(textarea).toHaveAttribute('aria-invalid', 'true');
    expect(textarea).toHaveAttribute('aria-describedby', error.id);
  });

  it('sets no aria-describedby and no aria-invalid on a field with no error', () => {
    renderWithProviders(<JobFormPage />, { ability: adminAbility, initialEntries: ['/jobs/new'] });

    const unit = screen.getByLabelText('Unit');
    expect(unit).not.toHaveAttribute('aria-describedby');
    expect(unit).not.toHaveAttribute('aria-invalid');
  });
});

describe('JobFormPage - the conversion restyles nothing', () => {
  it('the label renders the Label primitive class string unchanged - the pattern adds no className', () => {
    renderWithProviders(<JobFormPage />, { ability: adminAbility, initialEntries: ['/jobs/new'] });
    const { container } = render(<Label>reference</Label>);
    const reference = container.querySelector('label') as HTMLElement;

    expect(screen.getByText('Service Request *').getAttribute('class')).toBe(
      reference.getAttribute('class'),
    );
  });

  it('the Textarea renders the primitive class string unchanged', () => {
    renderWithProviders(<JobFormPage />, { ability: adminAbility, initialEntries: ['/jobs/new'] });
    const { container } = render(<Textarea rows={3} placeholder="reference" />);
    const reference = container.querySelector('textarea') as HTMLElement;

    expect(
      screen.getByPlaceholderText('Describe the work needed...').getAttribute('class'),
    ).toBe(reference.getAttribute('class'));
  });

  it('the Input renders the primitive class string unchanged', () => {
    renderWithProviders(<JobFormPage />, { ability: adminAbility, initialEntries: ['/jobs/new'] });
    const { container } = render(<Input />);
    const reference = container.querySelector('input') as HTMLElement;

    expect((screen.getByLabelText('City *') as HTMLElement).getAttribute('class')).toBe(
      reference.getAttribute('class'),
    );
  });

  it('renders the shared schedule field set, each control wired to its own label', () => {
    renderWithProviders(<JobFormPage />, { ability: adminAbility, initialEntries: ['/jobs/new'] });
    fireEvent.click(screen.getByRole('switch'));

    // The page's four hand-rolled Start/End Date/Time fields (each with its own width
    // override) are now ScheduleTimeFields, the same set the scheduler board and the job
    // dialog render. FormField still owns the id/htmlFor wiring inside it.
    for (const name of ['Start date', 'Start time', 'End date', 'End time']) {
      const control = screen.getByLabelText(name);
      expect(control.id).toBeTruthy();
      expect(screen.getByText(name).getAttribute('for')).toBe(control.id);
    }
    expect(screen.queryByLabelText('Start Date')).not.toBeInTheDocument();
  });
});

describe('LeadFormPage - converted fields and the recorded deferrals', () => {
  it('wires the create form Service Request and Notes fields', () => {
    renderWithProviders(<LeadFormPage />, { ability: adminAbility, initialEntries: ['/leads/new'] });

    const request = screen.getByPlaceholderText('Describe the service needed...');
    expect(screen.getByText('Service Request *').getAttribute('for')).toBe(request.id);
    expect(request.id).toBeTruthy();

    const notes = screen.getByPlaceholderText('Internal notes...');
    expect(screen.getByText('Notes').getAttribute('for')).toBe(notes.id);
  });

  it('wires the render-prop Selects, and keeps the inline add-a-job-type row OUTSIDE the field root', () => {
    renderWithProviders(<LeadFormPage />, { ability: adminAbility, initialEntries: ['/leads/new'] });

    const jobType = screen.getByLabelText('Job Type');
    expect(jobType.tagName).toBe('BUTTON');
    expect(screen.getByText('Job Type').getAttribute('for')).toBe(jobType.id);

    // The pattern wraps the Select and NOTHING else: the inline "add a new job
    // type" row stays a sibling of the FormField, so opening it keeps its own
    // seam to the Select instead of inheriting the pattern gap on top of it.
    // The third child is Radix's own hidden form-bubble select, which is
    // absolutely positioned and therefore out of flow - it takes no gap.
    const root = fieldRootFor('Job Type');
    const kids = Array.from(root.children) as HTMLElement[];
    expect(root.getAttribute('class')).toBe('flex flex-col gap-1.5');
    expect(kids.map((el) => el.tagName)).toEqual(['LABEL', 'BUTTON', 'SELECT']);
    expect(kids[2]).toHaveAttribute('aria-hidden', 'true');
    expect(kids[2].style.position).toBe('absolute');

    expect(screen.getByLabelText('Source').tagName).toBe('BUTTON');
  });

  it('DEFERRED: the schedule rows are still hand wired, because TimeSelect drops the id it is handed', () => {
    renderWithProviders(<LeadFormPage />, { ability: adminAbility, initialEntries: ['/leads/new'] });
    fireEvent.click(screen.getByRole('switch'));

    // Both halves of the row are unconverted, so they stay consistent with each
    // other. Converting only the Date half would wire one label and leave the
    // two controls in the row vertically out of step.
    expect(screen.getByText('Start Date').getAttribute('for')).toBeNull();
    expect(screen.getByText('Start Time').getAttribute('for')).toBeNull();
    expect(screen.getByText('End Date').getAttribute('for')).toBeNull();
    expect(screen.getByText('End Time').getAttribute('for')).toBeNull();
  });
});
