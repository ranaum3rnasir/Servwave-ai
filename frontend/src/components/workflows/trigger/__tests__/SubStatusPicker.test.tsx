import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import SubStatusPicker from '../SubStatusPicker';

const mockGet = vi.fn();
vi.mock('@/lib/axios', () => ({
  default: { get: (...args: unknown[]) => mockGet(...args) },
}));

const SUB_STATUSES = [
  { id: 'sub-1', parent: 'IN_PROGRESS', label: 'Waiting on parts', sort_order: 0 },
  { id: 'sub-2', parent: 'IN_PROGRESS', label: 'Waiting on customer', sort_order: 1 },
  { id: 'sub-3', parent: 'COMPLETED', label: 'Pending office review', sort_order: 0 },
];

beforeEach(() => {
  mockGet.mockReset();
});

describe('SubStatusPicker', () => {
  it('renders every org sub-status as a radio row, captioned with its parent status', async () => {
    mockGet.mockResolvedValue({ data: { job_sub_statuses: SUB_STATUSES } });
    renderWithProviders(<SubStatusPicker onPick={vi.fn()} />);

    expect(await screen.findByText('Waiting on parts')).toBeInTheDocument();
    expect(screen.getByText('Waiting on customer')).toBeInTheDocument();
    expect(screen.getByText('Pending office review')).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(3);
  });

  it('captions each option with its parent JobStatus label, so same-word labels under different parents are distinguishable', async () => {
    mockGet.mockResolvedValue({ data: { job_sub_statuses: SUB_STATUSES } });
    renderWithProviders(<SubStatusPicker onPick={vi.fn()} />);

    await screen.findByText('Waiting on parts');
    const row = screen.getByText('Pending office review').closest('button')!;
    expect(row).toHaveTextContent('Completed');
  });

  it('clicking an option calls onPick with that sub-status id, and only that argument', async () => {
    mockGet.mockResolvedValue({ data: { job_sub_statuses: SUB_STATUSES } });
    const onPick = vi.fn();
    renderWithProviders(<SubStatusPicker onPick={onPick} />);

    fireEvent.click(await screen.findByText('Waiting on customer'));

    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith('sub-2');
    expect(onPick.mock.calls[0]).toHaveLength(1);
  });

  it('value drives aria-checked; switching value moves the selection', async () => {
    mockGet.mockResolvedValue({ data: { job_sub_statuses: SUB_STATUSES } });
    const { rerender } = renderWithProviders(<SubStatusPicker value={undefined} onPick={vi.fn()} />);

    const row = (label: string) => screen.getByText(label).closest('button')!;
    await screen.findByText('Waiting on parts');
    expect(row('Waiting on parts')).toHaveAttribute('aria-checked', 'false');

    rerender(<SubStatusPicker value="sub-1" onPick={vi.fn()} />);
    expect(row('Waiting on parts')).toHaveAttribute('aria-checked', 'true');
    expect(row('Waiting on customer')).toHaveAttribute('aria-checked', 'false');

    rerender(<SubStatusPicker value="sub-2" onPick={vi.fn()} />);
    expect(row('Waiting on parts')).toHaveAttribute('aria-checked', 'false');
    expect(row('Waiting on customer')).toHaveAttribute('aria-checked', 'true');
  });

  // SRVW-113 — the org must be able to add a label without leaving the drawer's own
  // flow, so this is a real navigable link, not just disabled placeholder text.
  it('renders a link to Settings > Job Sub-Statuses when the org has none defined yet, instead of an empty list', async () => {
    mockGet.mockResolvedValue({ data: { job_sub_statuses: [] } });
    renderWithProviders(<SubStatusPicker onPick={vi.fn()} />);

    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    expect(screen.getByText('No job sub-statuses yet')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /Job Sub-Statuses/i });
    expect(link).toHaveAttribute('href', '/settings/job-sub-statuses');
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
  });
});
