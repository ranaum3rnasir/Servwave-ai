/**
 * Mobile slice 66: a page holding half-filled work (the lead, customer and job create forms) asks
 * before the user leaves it.
 *
 * The app uses the declarative router, which has no navigation blocker, so the guard rides the
 * shared pieces already in place: every in-app exit (sidebar, top bar, search, logo) goes through
 * `useSettingsGuard().requestLeave`; Back is held with a history marker; a reload asks through
 * the browser; and the unsaved-work signal is on, so the update prompt waits.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { useLeaveGuard } from '@/hooks/useLeaveGuard';
import { useSettingsGuard } from '@/stores/settingsGuard.store';
import { hasUnsavedWork } from '@/ui-kit/lib/unsavedWork';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

function Harness({ dirty }: { dirty: boolean }) {
  const guard = useLeaveGuard(dirty);
  return (
    <div>
      <button type="button" onClick={guard.leaveBack}>Cancel</button>
      <button type="button" onClick={() => guard.finish('/leads/42', { replace: true })}>Finish</button>
      <button
        type="button"
        onClick={() => useSettingsGuard.getState().requestLeave(() => mockNavigate('/customers'))}
      >
        Sidebar link
      </button>
      {guard.leaveDialog}
    </div>
  );
}

function renderHarness(dirty: boolean) {
  const view = render(<MemoryRouter><Harness dirty={dirty} /></MemoryRouter>);
  return {
    ...view,
    setDirty: (next: boolean) => view.rerender(<MemoryRouter><Harness dirty={next} /></MemoryRouter>),
  };
}

const markerOnTop = () => Boolean((window.history.state as Record<string, unknown> | null)?.__leaveGuardMarker);
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 30)));

beforeEach(() => {
  vi.clearAllMocks();
  // A fresh, marker-free entry on top of whatever an earlier test left in jsdom's history.
  window.history.pushState(null, '');
  useSettingsGuard.setState({ isDirty: false, pendingLeave: null });
});
afterEach(() => {
  useSettingsGuard.setState({ isDirty: false, pendingLeave: null });
});

describe('useLeaveGuard', () => {
  it('a clean page leaves without a question', async () => {
    const user = userEvent.setup();
    renderHarness(false);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mockNavigate).toHaveBeenCalledWith(-1);
    expect(screen.queryByText('Discard your changes?')).not.toBeInTheDocument();
    expect(hasUnsavedWork()).toBe(false);
  });

  it('Cancel on a dirty page asks; Keep editing stays put', async () => {
    const user = userEvent.setup();
    renderHarness(true);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText('Discard your changes?')).toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByText('Discard your changes?')).not.toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('Discard leaves the page', async () => {
    const user = userEvent.setup();
    renderHarness(true);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(await screen.findByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith(-1));
  });

  it('an in-app link (sidebar, top bar, search) asks, then goes where it was going', async () => {
    const user = userEvent.setup();
    renderHarness(true);
    await user.click(screen.getByRole('button', { name: 'Sidebar link' }));
    expect(await screen.findByText('Discard your changes?')).toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/customers'));
  });

  it('an in-app link on a clean page just goes', async () => {
    const user = userEvent.setup();
    renderHarness(false);
    await user.click(screen.getByRole('button', { name: 'Sidebar link' }));
    expect(mockNavigate).toHaveBeenCalledWith('/customers');
  });

  it('is on the unsaved-work signal exactly while dirty, and releases the shared guard on unmount', () => {
    const { setDirty, unmount } = renderHarness(false);
    expect(hasUnsavedWork()).toBe(false);
    setDirty(true);
    expect(hasUnsavedWork()).toBe(true);
    expect(useSettingsGuard.getState().isDirty).toBe(true);
    setDirty(false);
    expect(hasUnsavedWork()).toBe(false);
    setDirty(true);
    unmount();
    expect(hasUnsavedWork()).toBe(false);
    expect(useSettingsGuard.getState().isDirty).toBe(false);
  });

  it('asks the browser to confirm a reload or tab close while dirty, and not otherwise', () => {
    const { setDirty } = renderHarness(false);
    const fire = () => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(fire()).toBe(false);
    setDirty(true);
    expect(fire()).toBe(true);
  });

  it('once the user has chosen Discard, or the work is saved, the browser is not asked a second time', async () => {
    const user = userEvent.setup();
    renderHarness(true);
    const prevented = () => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(prevented()).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(await screen.findByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith(-1));
    // Going back to a page that is another document would fire beforeunload; it must not ask again.
    expect(prevented()).toBe(false);
  });

  it('Keep editing puts the browser question back', async () => {
    const user = userEvent.setup();
    renderHarness(true);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(await screen.findByRole('button', { name: 'Keep editing' }));
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('finish leaves without a question, even on a dirty page', async () => {
    const user = userEvent.setup();
    renderHarness(true);
    await settle();
    await user.click(screen.getByRole('button', { name: 'Finish' }));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/leads/42', { replace: true }));
    expect(screen.queryByText('Discard your changes?')).not.toBeInTheDocument();
  });

  describe('the Back button', () => {
    it('holds a marker on top of the history while dirty, and takes it off when clean again', async () => {
      const { setDirty } = renderHarness(false);
      expect(markerOnTop()).toBe(false);
      setDirty(true);
      expect(markerOnTop()).toBe(true);
      setDirty(false);
      await waitFor(() => expect(markerOnTop()).toBe(false));
    });

    it('Back asks instead of leaving; Keep editing puts the marker back', async () => {
      const user = userEvent.setup();
      renderHarness(true);
      expect(markerOnTop()).toBe(true);
      act(() => { window.history.back(); });
      expect(await screen.findByText('Discard your changes?')).toBeInTheDocument();
      expect(mockNavigate).not.toHaveBeenCalled();
      await user.click(screen.getByRole('button', { name: 'Keep editing' }));
      expect(markerOnTop()).toBe(true);
    });

    it('Back then Discard goes back one step, the marker already gone', async () => {
      const user = userEvent.setup();
      renderHarness(true);
      act(() => { window.history.back(); });
      await user.click(await screen.findByRole('button', { name: 'Discard' }));
      await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith(-1));
    });

    it('Cancel then Discard takes the marker off before it goes, so no stray entry is left behind', async () => {
      const user = userEvent.setup();
      renderHarness(true);
      await user.click(screen.getByRole('button', { name: 'Cancel' }));
      await user.click(await screen.findByRole('button', { name: 'Discard' }));
      await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith(-1));
      expect(markerOnTop()).toBe(false);
    });

    it('Back on a page that went clean again does not ask', async () => {
      const back = vi.spyOn(window.history, 'back');
      const { setDirty } = renderHarness(true);
      expect(markerOnTop()).toBe(true);
      setDirty(false);
      await waitFor(() => expect(markerOnTop()).toBe(false));
      back.mockClear();
      // The marker is already off, so this Back is the user's own and nothing intercepts it.
      act(() => { window.history.back(); });
      await settle();
      expect(back).toHaveBeenCalledTimes(1);
      expect(screen.queryByText('Discard your changes?')).not.toBeInTheDocument();
      back.mockRestore();
    });
  });
});
