import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BeeJobSearchSelect } from '../components/BeeJobSearchSelect';
import { beeApi, BeeSampleJobContext } from '@/lib/api/bee';

vi.mock('@/lib/api/bee', () => ({
  beeApi: {
    getSampleJobs: vi.fn(),
  },
}));

const mockJobs: BeeSampleJobContext[] = Array.from({ length: 25 }, (_, i) => ({
  id: `job-${i + 1}`,
  job_number: `J0010${i + 1}`,
  customer_name: `Customer ${i + 1}`,
  customer_phone: '5551234567',
  status: 'completed',
  job_type: i % 2 === 0 ? 'HVAC Maintenance' : 'Plumbing Repair',
  phone: '5551234567',
  service_address: `${100 + i} Main St`,
  service_request: 'Fix heating unit',
  warranty_end_date: '2026-12-31',
  assigned_team: 'Dave / Bob',
  job_notes: 'Gate code 1234',
  line_items: 'Inspection $99',
  total_costs: '$99.00',
  internal_costs: '$45.00',
  visits: '1 visit on Oct 12',
  communication_history: 'Customer called via phone',
}));

describe('BeeJobSearchSelect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (beeApi.getSampleJobs as any).mockResolvedValue({
      ok: true,
      jobs: mockJobs.slice(0, 10),
      total: mockJobs.length,
      hasMore: true,
      offset: 0,
      limit: 10,
    });
  });

  it('renders with placeholder and defaults to no referenced job', () => {
    render(
      <BeeJobSearchSelect
        onSelect={vi.fn()}
        placeholder="Select a job to preview..."
        initialJobs={mockJobs.slice(0, 10)}
      />
    );

    expect(screen.getByText('Select a job to preview...')).toBeInTheDocument();
  });

  it('renders recent 10 jobs immediately on open without waiting for network', async () => {
    render(
      <BeeJobSearchSelect
        onSelect={vi.fn()}
        placeholder="Select a job to preview..."
        initialJobs={mockJobs.slice(0, 10)}
      />
    );

    const trigger = screen.getByRole('button');
    fireEvent.click(trigger);

    expect(screen.getByText('None (Show raw variables)')).toBeInTheDocument();
    expect(screen.getByText(/Customer 1 \(/)).toBeInTheDocument();
    expect(screen.getByText(/Customer 10 \(/)).toBeInTheDocument();
  });

  it('shows "Showing 10 of 25" and offers "See more" and "Show all" buttons', async () => {
    render(
      <BeeJobSearchSelect
        onSelect={vi.fn()}
        placeholder="Select a job to preview..."
        initialJobs={mockJobs.slice(0, 10)}
      />
    );

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => {
      expect(screen.getByText('See more')).toBeInTheDocument();
      expect(screen.getByText('Show all')).toBeInTheDocument();
    });
  });

  it('loads more jobs (+10) when "See more" is clicked', async () => {
    (beeApi.getSampleJobs as any)
      .mockResolvedValueOnce({
        ok: true,
        jobs: mockJobs.slice(0, 10),
        total: 25,
        hasMore: true,
      })
      .mockResolvedValueOnce({
        ok: true,
        jobs: mockJobs.slice(10, 20),
        total: 25,
        hasMore: true,
      });

    render(
      <BeeJobSearchSelect
        onSelect={vi.fn()}
        placeholder="Select a job to preview..."
        initialJobs={mockJobs.slice(0, 10)}
      />
    );

    fireEvent.click(screen.getByRole('button'));

    const seeMoreBtn = await screen.findByRole('button', { name: /See more/ });
    fireEvent.click(seeMoreBtn);

    await waitFor(() => {
      expect(screen.getByText(/Customer 15 \(/)).toBeInTheDocument();
    });
  });

  it('loads all remaining jobs when "Show all" is clicked', async () => {
    (beeApi.getSampleJobs as any)
      .mockResolvedValueOnce({
        ok: true,
        jobs: mockJobs.slice(0, 10),
        total: 25,
        hasMore: true,
      })
      .mockResolvedValueOnce({
        ok: true,
        jobs: mockJobs.slice(10, 25),
        total: 25,
        hasMore: false,
      });

    render(
      <BeeJobSearchSelect
        onSelect={vi.fn()}
        placeholder="Select a job to preview..."
        initialJobs={mockJobs.slice(0, 10)}
      />
    );

    fireEvent.click(screen.getByRole('button'));

    const showAllBtn = await screen.findByRole('button', { name: /Show all/ });
    fireEvent.click(showAllBtn);

    await waitFor(() => {
      expect(screen.getByText(/Showing all/)).toBeInTheDocument();
      expect(screen.getByText(/Customer 25 \(/)).toBeInTheDocument();
    });
  });

  it('allows selecting "None (Show raw variables)" to clear selected job', async () => {
    const onSelect = vi.fn();
    render(
      <BeeJobSearchSelect
        value="job-1"
        onSelect={onSelect}
        initialJobs={mockJobs.slice(0, 10)}
      />
    );

    const trigger = screen.getByTitle(/Job #J00101/);
    fireEvent.click(trigger);

    const noneBtn = screen.getByText('None (Show raw variables)');
    fireEvent.click(noneBtn);

    expect(onSelect).toHaveBeenCalledWith(null);
  });
});
