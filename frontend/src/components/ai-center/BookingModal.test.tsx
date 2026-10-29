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

describe('BookingModal - who the call is about', () => {
  it("shows the agent's animal as its still portrait, with the role without AI", () => {
    render(
      <BookingModal
        target={{ agentId: 'carlos', name: 'Hawk', role: 'AI Job-Doc Reviewer', initial: 'H', color: '#5B6DFF' }}
        onOpenChange={vi.fn()}
      />,
    );
    const animal = screen.getByRole('img', { name: 'Hawk' });
    expect(animal).toHaveAttribute('src', '/ai-center/agents/still/carlos.jpg');
    expect(screen.getByText('Job-doc reviewer · 30 min')).toBeInTheDocument();
    // The poster stays still: no loop is ever mounted here.
    expect(document.querySelector('img[src$=".webp"]')).toBeNull();
  });

  it('the services offer has no animal and keeps its own label', () => {
    render(
      <BookingModal
        target={{ name: 'AI Specialist Implementation', role: 'Done for you', initial: '*', color: '#5B6DFF' }}
        onOpenChange={vi.fn()}
      />,
    );
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText('Done for you · 30 min')).toBeInTheDocument();
  });
});

