import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { MarkLostDialog } from '@/pages/v2/leads/components/leadDialogs';

const mockApi = vi.mocked(api);

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.post.mockResolvedValue({ data: { lead: {} } });
});

describe('MarkLostDialog', () => {
  it('renders dialog title and description when open', () => {
    renderWithProviders(
      <MarkLostDialog open={true} onOpenChange={vi.fn()} leadId="lead-1" />
    );

    expect(screen.getByText('Mark Lead as Lost')).toBeInTheDocument();
    expect(screen.getByText(/cannot be undone/)).toBeInTheDocument();
  });

  it('shows reason textarea', () => {
    renderWithProviders(
      <MarkLostDialog open={true} onOpenChange={vi.fn()} leadId="lead-1" />
    );

    expect(screen.getByPlaceholderText('Why was this lead lost?')).toBeInTheDocument();
  });

  it('disables Mark Lost button when reason is empty', () => {
    renderWithProviders(
      <MarkLostDialog open={true} onOpenChange={vi.fn()} leadId="lead-1" />
    );

    expect(screen.getByText('Mark Lost')).toBeDisabled();
  });

  it('enables Mark Lost button when reason is provided', async () => {
    const user = userEvent.setup();

    renderWithProviders(
      <MarkLostDialog open={true} onOpenChange={vi.fn()} leadId="lead-1" />
    );

    await user.type(screen.getByPlaceholderText('Why was this lead lost?'), 'Customer chose competitor');

    expect(screen.getByText('Mark Lost')).not.toBeDisabled();
  });

  it('calls API when Mark Lost is clicked', async () => {
    const user = userEvent.setup();

    renderWithProviders(
      <MarkLostDialog open={true} onOpenChange={vi.fn()} leadId="lead-1" />
    );

    await user.type(screen.getByPlaceholderText('Why was this lead lost?'), 'No budget');
    await user.click(screen.getByText('Mark Lost'));

    await waitFor(() => {
      expect(mockApi.post).toHaveBeenCalledWith(
        '/api/leads/lead-1/mark-lost',
        { lost_reason: 'No budget' }
      );
    });
  });

  it('calls onOpenChange when Cancel is clicked', async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(
      <MarkLostDialog open={true} onOpenChange={onOpenChange} leadId="lead-1" />
    );

    await user.click(screen.getByText('Cancel'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
