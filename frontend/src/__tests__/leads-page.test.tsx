import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import api from '@/lib/axios';
import { renderWithProviders, LEAD_LIST_FIXTURE } from './helpers';
import LeadsPage from '@/pages/LeadsPage';
import { buildAbility } from '@/lib/ability';

const manageAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

const mockApi = vi.mocked(api);

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockResolvedValue({ data: LEAD_LIST_FIXTURE });
});

// Radix Popover needs a real constructable ResizeObserver + fireEvent (not
// userEvent) to open in jsdom — mirrors FilterBar.test.tsx's established
// precedent.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
beforeEach(() => {
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
});

/** Exposes the MemoryRouter's current path+search so tests can assert on the URL. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-probe">{location.pathname + location.search}</div>;
}

function leadsApiCalls() {
  return mockApi.get.mock.calls.filter(([url]) => url === '/api/leads');
}

describe('LeadsPage', () => {
  it('renders page heading', async () => {
    renderWithProviders(<LeadsPage />);
    expect(screen.getByText('Leads')).toBeInTheDocument();
  });

  it('renders KPI strip with stat labels', async () => {
    renderWithProviders(<LeadsPage />);

    await waitFor(() => {
      expect(screen.getByText('Total Leads')).toBeInTheDocument();
    });
    expect(screen.getByText('New This Week')).toBeInTheDocument();
    expect(screen.getByText('Unassigned')).toBeInTheDocument();
    expect(screen.getByText('Won')).toBeInTheDocument();
    expect(screen.getByText('Lost')).toBeInTheDocument();
  });

  it('renders lead customer name in table', async () => {
    renderWithProviders(<LeadsPage />);

    await waitFor(() => {
      expect(screen.getByText('John Doe')).toBeInTheDocument();
    });
  });

  it('renders service request in table', async () => {
    renderWithProviders(<LeadsPage />);

    await waitFor(() => {
      expect(screen.getByText('AC not cooling')).toBeInTheDocument();
    });
  });

  it('shows New Lead button', () => {
    // Task 10 (Spec A): gated on ability.can('create', 'Lead') now, not ungated.
    renderWithProviders(<LeadsPage />, { ability: manageAbility });
    expect(screen.getByText('New Lead')).toBeInTheDocument();
  });

  it('shows Export button', () => {
    renderWithProviders(<LeadsPage />);
    expect(screen.getByText('Export')).toBeInTheDocument();
  });

  it('shows search placeholder', () => {
    renderWithProviders(<LeadsPage />);
    expect(screen.getByPlaceholderText('Search leads...')).toBeInTheDocument();
  });

  it('calls API with correct params on mount', async () => {
    renderWithProviders(<LeadsPage />);

    await waitFor(() => {
      expect(mockApi.get).toHaveBeenCalledWith('/api/leads', {
        params: expect.objectContaining({ page: 1, limit: 25 }),
      });
    });
  });
});

describe('LeadsPage — generalized filter registry (Task 9)', () => {
  it('setting Status + # of Estimates updates both the URL query string and the /api/leads request params', async () => {
    renderWithProviders(
      <>
        <LeadsPage />
        <LocationProbe />
      </>
    );

    await waitFor(() => {
      expect(screen.getByText('Total Leads')).toBeInTheDocument();
    });

    // Open the Filter popover (Status is the first/default facet pane).
    fireEvent.click(screen.getByRole('button', { name: /^filter$/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Won' }));

    // Switch to the "# of Estimates" facet and set an exact From/To range.
    fireEvent.click(screen.getByRole('tab', { name: /estimates/i }));
    fireEvent.change(screen.getByLabelText('# of Estimates From'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('# of Estimates To'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: /^done$/i }));

    // URL reflects both facets, using the frontend codec's range suffix convention.
    await waitFor(() => {
      const url = screen.getByTestId('location-probe').textContent ?? '';
      expect(url).toContain('status=WON');
      expect(url).toContain('estimates_min=1');
      expect(url).toContain('estimates_max=3');
    });

    // The outgoing /api/leads request carries the matching (backend-aligned) param names.
    await waitFor(() => {
      const calls = leadsApiCalls();
      const lastCall = calls[calls.length - 1];
      expect(lastCall[1]).toEqual(
        expect.objectContaining({
          params: expect.objectContaining({
            status: 'WON',
            estimates_min: '1',
            estimates_max: '3',
          }),
        })
      );
    });
  });

  it('clicking the "Won" KPI tile applies {status: [WON]} and requests /api/leads with status=WON', async () => {
    renderWithProviders(<LeadsPage />);

    await waitFor(() => {
      expect(screen.getByText('Total Leads')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /won/i }));

    await waitFor(() => {
      const calls = leadsApiCalls();
      const lastCall = calls[calls.length - 1];
      expect(lastCall[1]).toEqual(
        expect.objectContaining({ params: expect.objectContaining({ status: 'WON' }) })
      );
      // Only the status facet is active — no leftover assigned_to/created bound
      // from a previous preset (guards the KPI preset's exact FilterState shape).
      expect(lastCall[1].params.assigned_to).toBeUndefined();
      expect(lastCall[1].params.created_after).toBeUndefined();
    });

    // The tile now shows itself as active; clicking it again clears back to the default view.
    fireEvent.click(screen.getByRole('button', { name: /won/i }));

    await waitFor(() => {
      const calls = leadsApiCalls();
      const lastCall = calls[calls.length - 1];
      expect(lastCall[1].params.status).toBeUndefined();
    });
  });
});
