/**
 * FE-5: LinkedEntitySelect
 *
 * Tests:
 * 1. Trigger renders with correct label (no value / with value).
 * 2. Opening the popover fetches the default type (JOB) from /api/jobs.
 * 3. Clicking a type toggle fetches the matching endpoint.
 * 4. Typing in the search box passes ?search= to the right endpoint.
 * 5. Selecting an item calls onChange with { type, id, label }.
 * 6. disabled=true disables trigger; no clear X.
 * 7. Clear X button calls onChange(null).
 *
 * Strategy:
 * - The global setup.ts already mocks @/lib/axios; we override api.get per-test.
 * - ResizeObserver needs a constructable class stub (Radix floating-ui calls `new`
 *   via autoUpdate). The global setup.ts has an arrow fn that is NOT constructable.
 * - Use real timers — waitFor waits up to 1 s which covers the 300 ms debounce.
 * - Use fireEvent for popover trigger + toggles to avoid userEvent async overhead.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import { LinkedEntitySelect } from '@/components/tasks/LinkedEntitySelect';
import api from '@/lib/axios';

// ── ResizeObserver stub (constructable — required for Radix Popover) ──────────
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
beforeEach(() => {
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.scrollIntoView ??= () => {};
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

const JOB_FIXTURES = [
  {
    id: 'job-uuid-1',
    job_number: 'J00001',
    job_type: 'HVAC',
    customer: { first_name: 'Alice', last_name: 'Smith', company_name: null, phone: '5559876543' },
    service_location: { address_line1: '1 Main St', city: 'Dallas', state: 'TX' },
  },
  {
    id: 'job-uuid-2',
    job_number: 'J00002',
    job_type: null,
    customer: { first_name: null, last_name: null, company_name: 'ACME Corp', phone: null },
    service_location: null,
  },
];
const LEAD_FIXTURES = [
  {
    id: 'lead-uuid-1',
    lead_number: 'L00001',
    service_request: 'AC not cooling',
    job_type: 'HVAC Repair',
    service_city: 'Austin',
    service_state: 'TX',
    customer: { first_name: 'Bob', last_name: 'Jones', company_name: null, phone: '5551234567' },
  },
  {
    id: 'lead-uuid-2',
    lead_number: 'L00002',
    service_request: null,
    job_type: null,
    service_city: null,
    service_state: null,
    customer: {
      first_name: 'Eve',
      last_name: 'Green',
      company_name: null,
      phone: null,
      service_locations: [{ city: 'Houston', state: 'TX' }],
    },
  },
];
const CUSTOMER_FIXTURES = [
  { id: 'cust-uuid-1', customer_number: 'C00001', first_name: 'Carol', last_name: 'White', company_name: null },
];
const ESTIMATE_FIXTURES = [
  { id: 'est-uuid-1', estimate_number: 'E00001', lead: { customer: { first_name: 'Dave', last_name: 'Black', company_name: null } } },
];

function makeResponse(type: 'jobs' | 'leads' | 'customers' | 'estimates', fixtures: unknown[]) {
  return Promise.resolve({ data: { [type]: fixtures } });
}

function setupApiMock() {
  (api.get as Mock).mockImplementation((url: string) => {
    if (url === '/api/jobs') return makeResponse('jobs', JOB_FIXTURES);
    if (url === '/api/leads') return makeResponse('leads', LEAD_FIXTURES);
    if (url === '/api/customers') return makeResponse('customers', CUSTOMER_FIXTURES);
    if (url === '/api/estimates') return makeResponse('estimates', ESTIMATE_FIXTURES);
    return Promise.reject(new Error(`Unexpected URL: ${url}`));
  });
}

afterEach(() => vi.clearAllMocks());

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('LinkedEntitySelect (FE-5)', () => {
  // ── Static (no open) ──────────────────────────────────────────────────────

  it('renders trigger showing "— None —" when no value', () => {
    renderWithProviders(<LinkedEntitySelect value={null} onChange={vi.fn()} />);
    expect(screen.getByTestId('linked-entity-select-trigger')).toHaveTextContent('— None —');
  });

  it('renders trigger with [type] prefix + label when value is set', () => {
    renderWithProviders(
      <LinkedEntitySelect
        value={{ type: 'JOB', id: 'job-uuid-1', label: 'J00001 · HVAC · Alice Smith' }}
        onChange={vi.fn()}
      />
    );
    expect(screen.getByTestId('linked-entity-select-trigger')).toHaveTextContent('[JOB] J00001 · HVAC · Alice Smith');
  });

  it('disables the trigger when disabled=true', () => {
    renderWithProviders(<LinkedEntitySelect value={null} onChange={vi.fn()} disabled={true} />);
    expect(screen.getByTestId('linked-entity-select-trigger')).toBeDisabled();
  });

  it('does not render the clear X when disabled=true and value is set', () => {
    renderWithProviders(
      <LinkedEntitySelect value={{ type: 'JOB', id: 'j1', label: 'J00001' }} onChange={vi.fn()} disabled={true} />
    );
    expect(screen.queryByLabelText('Clear linked entity')).not.toBeInTheDocument();
  });

  it('calls onChange(null) when the clear X is clicked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(
      <LinkedEntitySelect value={{ type: 'JOB', id: 'j1', label: 'J00001' }} onChange={onChange} />
    );
    await user.click(screen.getByLabelText('Clear linked entity'));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  // ── Popover open → /api/jobs default ─────────────────────────────────────

  it('queries /api/jobs when popover opens (default type = JOB)', async () => {
    setupApiMock();
    renderWithProviders(<LinkedEntitySelect value={null} onChange={vi.fn()} />);

    fireEvent.click(screen.getByTestId('linked-entity-select-trigger'));

    // debounce = 300 ms; waitFor default timeout = 1 000 ms — no fake timers needed.
    await waitFor(() => {
      expect(api.get).toHaveBeenCalledWith('/api/jobs', expect.objectContaining({
        params: expect.objectContaining({ limit: 10 }),
      }));
    }, { timeout: 1500 });
  });

  it('queries /api/leads when Lead type toggle is clicked', async () => {
    setupApiMock();
    renderWithProviders(<LinkedEntitySelect value={null} onChange={vi.fn()} />);

    fireEvent.click(screen.getByTestId('linked-entity-select-trigger'));
    await waitFor(() => screen.getByTestId('type-toggle-LEAD'));
    fireEvent.click(screen.getByTestId('type-toggle-LEAD'));

    await waitFor(() => {
      expect(api.get).toHaveBeenCalledWith('/api/leads', expect.anything());
    }, { timeout: 1500 });
  });

  it('queries /api/customers when Customer type toggle is clicked', async () => {
    setupApiMock();
    renderWithProviders(<LinkedEntitySelect value={null} onChange={vi.fn()} />);

    fireEvent.click(screen.getByTestId('linked-entity-select-trigger'));
    await waitFor(() => screen.getByTestId('type-toggle-CUSTOMER'));
    fireEvent.click(screen.getByTestId('type-toggle-CUSTOMER'));

    await waitFor(() => {
      expect(api.get).toHaveBeenCalledWith('/api/customers', expect.anything());
    }, { timeout: 1500 });
  });

  it('queries /api/estimates when Estimate type toggle is clicked', async () => {
    setupApiMock();
    renderWithProviders(<LinkedEntitySelect value={null} onChange={vi.fn()} />);

    fireEvent.click(screen.getByTestId('linked-entity-select-trigger'));
    await waitFor(() => screen.getByTestId('type-toggle-ESTIMATE'));
    fireEvent.click(screen.getByTestId('type-toggle-ESTIMATE'));

    await waitFor(() => {
      expect(api.get).toHaveBeenCalledWith('/api/estimates', expect.anything());
    }, { timeout: 1500 });
  });

  it('passes ?search= param after typing in the search box', async () => {
    setupApiMock();
    renderWithProviders(<LinkedEntitySelect value={null} onChange={vi.fn()} />);

    fireEvent.click(screen.getByTestId('linked-entity-select-trigger'));
    await waitFor(() => screen.getByTestId('linked-entity-search-input'));

    fireEvent.change(screen.getByTestId('linked-entity-search-input'), { target: { value: 'alice' } });

    await waitFor(() => {
      const calls = (api.get as Mock).mock.calls;
      const withSearch = calls.find(
        ([url, opts]: [string, { params: Record<string, unknown> }]) =>
          url === '/api/jobs' && opts?.params?.search === 'alice'
      );
      expect(withSearch).toBeDefined();
    }, { timeout: 1500 });
  });

  // ── onChange emission tests ───────────────────────────────────────────────

  it('calls onChange with {type:"JOB",id,label} when a JOB result is clicked', async () => {
    setupApiMock();
    const onChange = vi.fn();
    renderWithProviders(<LinkedEntitySelect value={null} onChange={onChange} />);

    fireEvent.click(screen.getByTestId('linked-entity-select-trigger'));

    await waitFor(() => {
      expect(screen.getByTestId('entity-option-job-uuid-1')).toBeInTheDocument();
    }, { timeout: 1500 });

    fireEvent.click(screen.getByTestId('entity-option-job-uuid-1'));

    expect(onChange).toHaveBeenCalledOnce();
    const arg = onChange.mock.calls[0][0];
    expect(arg).toMatchObject({ type: 'JOB', id: 'job-uuid-1' });
    expect(typeof arg.label).toBe('string');
    expect(arg.label).toContain('J00001');
    // #429: job label carries job_type, customer name, formatted phone, city/state
    expect(arg.label).toContain('HVAC');
    expect(arg.label).toContain('Alice Smith');
    expect(arg.label).toContain('(555) 987-6543');
    expect(arg.label).toContain('Dallas, TX');
  });

  it('JOB label skips missing parts without dangling separators (#429)', async () => {
    setupApiMock();
    const onChange = vi.fn();
    renderWithProviders(<LinkedEntitySelect value={null} onChange={onChange} />);

    fireEvent.click(screen.getByTestId('linked-entity-select-trigger'));

    await waitFor(() => {
      expect(screen.getByTestId('entity-option-job-uuid-2')).toBeInTheDocument();
    }, { timeout: 1500 });

    fireEvent.click(screen.getByTestId('entity-option-job-uuid-2'));

    const arg = onChange.mock.calls[0][0];
    expect(arg.label).toBe('J00002 · ACME Corp');
  });

  it('emits {type:"LEAD",id,label} containing lead_number', async () => {
    setupApiMock();
    const onChange = vi.fn();
    renderWithProviders(<LinkedEntitySelect value={null} onChange={onChange} />);

    fireEvent.click(screen.getByTestId('linked-entity-select-trigger'));
    await waitFor(() => screen.getByTestId('type-toggle-LEAD'));
    fireEvent.click(screen.getByTestId('type-toggle-LEAD'));

    await waitFor(() => {
      expect(screen.getByTestId('entity-option-lead-uuid-1')).toBeInTheDocument();
    }, { timeout: 1500 });

    fireEvent.click(screen.getByTestId('entity-option-lead-uuid-1'));

    const arg = onChange.mock.calls[0][0];
    expect(arg).toMatchObject({ type: 'LEAD', id: 'lead-uuid-1' });
    expect(arg.label).toContain('L00001');
    // #429: lead label carries job_type, customer name, formatted phone, city/state…
    expect(arg.label).toContain('HVAC Repair');
    expect(arg.label).toContain('Bob Jones');
    expect(arg.label).toContain('(555) 123-4567');
    expect(arg.label).toContain('Austin, TX');
    // …and NOT the service_request blurb.
    expect(arg.label).not.toContain('AC not cooling');
  });

  it('LEAD label falls back to customer primary service-location city/state (#429)', async () => {
    setupApiMock();
    const onChange = vi.fn();
    renderWithProviders(<LinkedEntitySelect value={null} onChange={onChange} />);

    fireEvent.click(screen.getByTestId('linked-entity-select-trigger'));
    await waitFor(() => screen.getByTestId('type-toggle-LEAD'));
    fireEvent.click(screen.getByTestId('type-toggle-LEAD'));

    await waitFor(() => {
      expect(screen.getByTestId('entity-option-lead-uuid-2')).toBeInTheDocument();
    }, { timeout: 1500 });

    fireEvent.click(screen.getByTestId('entity-option-lead-uuid-2'));

    const arg = onChange.mock.calls[0][0];
    expect(arg.label).toBe('L00002 · Eve Green · Houston, TX');
  });

  it('emits {type:"CUSTOMER",id,label} containing customer name', async () => {
    setupApiMock();
    const onChange = vi.fn();
    renderWithProviders(<LinkedEntitySelect value={null} onChange={onChange} />);

    fireEvent.click(screen.getByTestId('linked-entity-select-trigger'));
    await waitFor(() => screen.getByTestId('type-toggle-CUSTOMER'));
    fireEvent.click(screen.getByTestId('type-toggle-CUSTOMER'));

    await waitFor(() => {
      expect(screen.getByTestId('entity-option-cust-uuid-1')).toBeInTheDocument();
    }, { timeout: 1500 });

    fireEvent.click(screen.getByTestId('entity-option-cust-uuid-1'));

    const arg = onChange.mock.calls[0][0];
    expect(arg).toMatchObject({ type: 'CUSTOMER', id: 'cust-uuid-1' });
    expect(arg.label).toContain('Carol');
  });

  it('emits {type:"ESTIMATE",id,label} containing estimate_number', async () => {
    setupApiMock();
    const onChange = vi.fn();
    renderWithProviders(<LinkedEntitySelect value={null} onChange={onChange} />);

    fireEvent.click(screen.getByTestId('linked-entity-select-trigger'));
    await waitFor(() => screen.getByTestId('type-toggle-ESTIMATE'));
    fireEvent.click(screen.getByTestId('type-toggle-ESTIMATE'));

    await waitFor(() => {
      expect(screen.getByTestId('entity-option-est-uuid-1')).toBeInTheDocument();
    }, { timeout: 1500 });

    fireEvent.click(screen.getByTestId('entity-option-est-uuid-1'));

    const arg = onChange.mock.calls[0][0];
    expect(arg).toMatchObject({ type: 'ESTIMATE', id: 'est-uuid-1' });
    expect(arg.label).toContain('E00001');
  });

  // ── #782: results list must scroll while a Dialog holds the scroll lock ─────

  it('keeps wheel and touchmove events from reaching the document scroll lock', async () => {
    setupApiMock();
    renderWithProviders(<LinkedEntitySelect value={null} onChange={vi.fn()} />);

    fireEvent.click(screen.getByTestId('linked-entity-select-trigger'));
    const list = await screen.findByTestId('linked-entity-results');

    // react-remove-scroll (used by Dialog) listens on `document` and
    // preventDefault()s any wheel/touchmove raised outside DialogContent. If
    // either event reaches the document, this list cannot scroll.
    const onDocumentWheel = vi.fn();
    const onDocumentTouchMove = vi.fn();
    document.addEventListener('wheel', onDocumentWheel);
    document.addEventListener('touchmove', onDocumentTouchMove);
    try {
      list.dispatchEvent(new Event('wheel', { bubbles: true, cancelable: true }));
      list.dispatchEvent(new Event('touchmove', { bubbles: true, cancelable: true }));
    } finally {
      document.removeEventListener('wheel', onDocumentWheel);
      document.removeEventListener('touchmove', onDocumentTouchMove);
    }

    expect(onDocumentWheel).not.toHaveBeenCalled();
    expect(onDocumentTouchMove).not.toHaveBeenCalled();
  });
});
