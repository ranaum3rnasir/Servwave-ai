import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { PlanUsage } from '@/pages/v2/communication/components/planUsage';

// The Phone header's calling/texting meters. These read GET
// /api/communication/usage - the org's own calls and messages for the cycle -
// so the two states that matter are a capped org (bar + percentage) and an
// uncapped org (running total, no bar, no percentage).
const mockApi = vi.mocked(api);

const usage = (over: Record<string, unknown> = {}) => ({
  cycleStart: '2026-08-01T04:00:00.000Z',
  cycleLabel: 'Aug 1 – 31',
  uncapped: false,
  calling: { used: 66, limit: 100, unit: 'min' },
  texting: { used: 2, limit: 500, unit: 'texts' },
  ...over,
});

function mockUsage(body: unknown) {
  mockApi.get.mockImplementation((url: string) =>
    url === '/api/communication/usage'
      ? Promise.resolve({ data: body })
      : Promise.resolve({ data: {} }),
  );
}

const props = { onToast: vi.fn(), branch: 'Main' };

describe('Phone plan usage meter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows usage against the allowance for a capped org', async () => {
    mockUsage(usage());
    renderWithProviders(<PlanUsage {...props} />);

    expect(await screen.findByText('66 / 100 min')).toBeInTheDocument();
    expect(screen.getByText('2 / 500 texts')).toBeInTheDocument();
    // 66/100 -> 66%
    expect(screen.getByText('66%')).toBeInTheDocument();
  });

  it('shows a running total and NO percentage for an uncapped org', async () => {
    // The house orgs (demo tenant, Alpha) are exempt. A percentage here would
    // have to be computed against a limit that does not exist.
    mockUsage(
      usage({
        uncapped: true,
        calling: { used: 128, limit: null, unit: 'min' },
        texting: { used: 22, limit: null, unit: 'texts' },
      }),
    );
    renderWithProviders(<PlanUsage {...props} />);

    expect(await screen.findByText('128 min this cycle')).toBeInTheDocument();
    expect(screen.getByText('22 texts this cycle')).toBeInTheDocument();
    expect(screen.getAllByText('No limit')).toHaveLength(2);
    expect(screen.queryByText(/%$/)).not.toBeInTheDocument();
  });

  it("holds the meter's place while the real figures are still loading", async () => {
    // The control used to render nothing until the request landed, so on a cold
    // Phone load it appeared out of nowhere and shoved the header's buttons
    // sideways. It now occupies its final footprint from the first paint.
    mockApi.get.mockImplementation(() => new Promise(() => {}));
    const { container } = renderWithProviders(<PlanUsage {...props} />);

    await waitFor(() =>
      expect(container.querySelector('[data-slot="skeleton"]')).toBeInTheDocument(),
    );
  });

  it('shows no figure of any kind while loading', async () => {
    // The original rule stands: a placeholder that renders a bar or a number
    // reads as a genuine 0%, which is worse than no meter. Reserving the space
    // is allowed; stating a usage the server has not sent is not.
    mockApi.get.mockImplementation(() => new Promise(() => {}));
    const { container } = renderWithProviders(<PlanUsage {...props} />);

    await waitFor(() =>
      expect(container.querySelector('[data-slot="skeleton"]')).toBeInTheDocument(),
    );
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\bmin\b/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\btexts\b/)).not.toBeInTheDocument();
    expect(screen.queryByText('No limit')).not.toBeInTheDocument();
  });

  it('renders nothing when the usage request fails', async () => {
    mockApi.get.mockRejectedValue(new Error('boom'));
    const { container } = renderWithProviders(<PlanUsage {...props} />);

    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
