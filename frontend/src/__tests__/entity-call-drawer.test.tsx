// EntityCallDrawer — the entity-tab wrapper that fetches a CallSession by id and
// renders the hub's CallDetailDrawer as a right-side slide-in. The hub drawer and
// the fetch hook are mocked so this suite stays focused on the wrapper (fetch →
// loading shell → drawer) without pulling the CallsView/Dialer graph.
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/components/communication/phone/CallsView', () => ({
  CallDetailDrawer: ({
    call,
    onClose,
  }: {
    call: { id: string };
    onClose: () => void;
    onToast: (m: string) => void;
  }) => (
    <div data-testid="call-detail-drawer" data-call-id={call.id}>
      <button type="button" onClick={onClose}>
        close
      </button>
    </div>
  ),
}));

const useCallMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/communication', () => ({
  useCall: useCallMock,
}));

import { EntityCallDrawer } from '@/components/communication/shared/EntityCallDrawer';

describe('EntityCallDrawer', () => {
  it('shows a loading shell (not the drawer) while the call loads', () => {
    useCallMock.mockReturnValue({ data: undefined, isLoading: true });
    render(<EntityCallDrawer callId="ca-1" onClose={vi.fn()} />);

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByTestId('call-detail-drawer')).not.toBeInTheDocument();
  });

  it('renders the hub CallDetailDrawer with the fetched call once loaded', async () => {
    useCallMock.mockReturnValue({ data: { id: 'ca-1' }, isLoading: false });
    render(<EntityCallDrawer callId="ca-1" onClose={vi.fn()} />);

    // The hub drawer is lazy-loaded (Suspense) — await it resolving.
    expect(await screen.findByTestId('call-detail-drawer')).toHaveAttribute('data-call-id', 'ca-1');
  });

  it('passes onClose through to the drawer', async () => {
    const onClose = vi.fn();
    useCallMock.mockReturnValue({ data: { id: 'ca-1' }, isLoading: false });
    render(<EntityCallDrawer callId="ca-1" onClose={onClose} />);

    await userEvent.click(await screen.findByText('close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows a graceful message (not a spinner) if the call fails to load', () => {
    useCallMock.mockReturnValue({ data: undefined, isLoading: false });
    render(<EntityCallDrawer callId="ca-1" onClose={vi.fn()} />);

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByTestId('call-detail-drawer')).not.toBeInTheDocument();
    expect(screen.getByText(/couldn't load this call/i)).toBeInTheDocument();
  });
});
