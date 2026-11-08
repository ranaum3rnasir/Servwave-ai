import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BookingModal, type BookingTarget } from './BookingModal';

vi.mock('@/lib/axios', () => ({
  default: {
    post: vi.fn(),
  },
}));

import api from '@/lib/axios';
const mockPost = api.post as ReturnType<typeof vi.fn>;

const TARGET: BookingTarget = {
  name: 'Carlos',
  role: 'Invoice Auditor',
  initial: 'C',
  color: '#5B6DFF',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('BookingModal — real booking request', () => {
  it('posts the booking to the backend and shows the confirmation on success', async () => {
    mockPost.mockResolvedValueOnce({ data: { ok: true } });
    render(<BookingModal target={TARGET} onOpenChange={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '10:30 AM' }));
    fireEvent.click(screen.getByRole('button', { name: /^Confirm .+ at / }));

    await waitFor(() => expect(screen.getByText("You're booked!")).toBeInTheDocument());
    expect(mockPost).toHaveBeenCalledWith(
      '/api/ai-farm/bookings',
      expect.objectContaining({ agentName: 'Carlos', agentRole: 'Invoice Auditor' })
    );
  });

  it('shows an error and does not confirm when the request fails', async () => {
    mockPost.mockRejectedValueOnce(new Error('network down'));
    render(<BookingModal target={TARGET} onOpenChange={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '10:30 AM' }));
    fireEvent.click(screen.getByRole('button', { name: /^Confirm .+ at / }));

    await waitFor(() =>
      expect(screen.getByText(/Something went wrong sending your booking request/)).toBeInTheDocument()
    );
    expect(screen.queryByText("You're booked!")).not.toBeInTheDocument();
  });
});
