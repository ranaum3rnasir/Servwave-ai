import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Toaster } from '@/ui-kit/components/ui/sonner';

/**
 * Mobile slice 67 (PWA-03). The prompt a user sees when a new version is waiting. The update
 * controller is faked here (its decisions are tested in serviceWorkerUpdate.test.ts); this
 * file proves what is shown, that Update asks the controller, and that the copy names no vendor.
 */
type Status = 'idle' | 'available' | 'blocked-by-unsaved-work' | 'applying';
const state = vi.hoisted(() => ({
  status: 'idle' as Status,
  listeners: new Set<() => void>(),
  requestApply: vi.fn(),
}));

vi.mock('@/lib/platform/registerServiceWorker', () => ({
  updateController: {
    getStatus: () => state.status,
    subscribe: (l: () => void) => {
      state.listeners.add(l);
      return () => state.listeners.delete(l);
    },
    requestApply: () => state.requestApply(),
  },
}));

import { UpdateAvailablePrompt } from '../UpdateAvailablePrompt';

function mockDesktop() {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

async function flush(ms = 50) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** A dismissed toast is marked on one frame, then leaves after its exit animation: two flushes. */
async function settleExit() {
  await flush(100);
  await flush(400);
}

async function setStatus(next: Status) {
  state.status = next;
  await act(async () => {
    state.listeners.forEach((l) => l());
  });
  await flush();
}

beforeEach(() => {
  // requestAnimationFrame is faked too: the toaster takes a dismissed toast down on a frame.
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'requestAnimationFrame', 'cancelAnimationFrame'],
  });
  mockDesktop();
  state.status = 'idle';
  state.listeners.clear();
  state.requestApply.mockClear();
});
afterEach(() => {
  document.body.style.pointerEvents = '';
  document.body.removeAttribute('data-scroll-locked');
  cleanup();
  vi.useRealTimers();
});

describe('UpdateAvailablePrompt', () => {
  it('shows nothing while no update is waiting', async () => {
    render(
      <>
        <Toaster />
        <UpdateAvailablePrompt />
      </>,
    );
    await flush();
    expect(screen.queryByText('Update available')).toBeNull();
  });

  it('shows "Update available" with an Update button, and Update asks the controller to apply', async () => {
    render(
      <>
        <Toaster />
        <UpdateAvailablePrompt />
      </>,
    );
    await setStatus('available');
    expect(screen.getByText('Update available')).toBeTruthy();
    const button = screen.getByRole('button', { name: 'Update' });
    await act(async () => {
      button.click();
    });
    expect(state.requestApply).toHaveBeenCalledTimes(1);
  });

  it('tells the user the update is waiting for their changes, and offers no second Update button', async () => {
    render(
      <>
        <Toaster />
        <UpdateAvailablePrompt />
      </>,
    );
    await setStatus('available');
    await setStatus('blocked-by-unsaved-work');
    expect(screen.getByText(/Save or discard your changes/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Update' })).toBeNull();
  });

  it('holds the prompt back while a modal is open (it would cover the form and could not be tapped), then shows it once the modal closes', async () => {
    render(
      <>
        <Toaster />
        <UpdateAvailablePrompt />
      </>,
    );
    document.body.style.pointerEvents = 'none'; // what an open dialog does to the page
    await setStatus('available');
    await settleExit(); // a dismissed toast leaves after its exit animation
    expect(screen.queryByText('Update available')).toBeNull();
    document.body.style.pointerEvents = '';
    await flush();
    expect(screen.getByText('Update available')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Update' })).toBeTruthy();
  });

  it('takes the prompt down when a modal opens over it, and brings it back after', async () => {
    render(
      <>
        <Toaster />
        <UpdateAvailablePrompt />
      </>,
    );
    await setStatus('available');
    expect(screen.getByText('Update available')).toBeTruthy();
    await act(async () => {
      document.body.setAttribute('data-scroll-locked', '1');
    });
    await settleExit();
    expect(screen.queryByText('Update available')).toBeNull();
    await act(async () => {
      document.body.removeAttribute('data-scroll-locked');
    });
    await flush();
    expect(screen.getByText('Update available')).toBeTruthy();
  });

  it('uses no vendor name in any of its copy', async () => {
    render(
      <>
        <Toaster />
        <UpdateAvailablePrompt />
      </>,
    );
    const seen: string[] = [];
    for (const status of ['available', 'blocked-by-unsaved-work', 'applying'] as const) {
      await setStatus(status);
      seen.push(document.body.textContent ?? '');
    }
    expect(seen.join(' ')).not.toMatch(/ctm|calltracking|supabase|render|vercel|twilio|resend|stripe|workbox|service worker/i);
  });
});
