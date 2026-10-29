/**
 * Mobile slice 66: an overlay that OPENS already dirty (a log-a-call drawer reopened on a restored
 * draft) must not ask "Discard your changes?" by itself.
 *
 * In development React runs every effect twice on mount (StrictMode): the guard pushes its Back
 * marker, its cleanup takes it off again with a history pop it expects to ignore, and the re-run
 * registers a fresh Back listener BEFORE that pop is delivered. A browser delivers a history pop
 * asynchronously (jsdom does it at once, which hid this), and the "ignore my own pop" counter used
 * to be decremented by a one-shot listener registered before the fresh one, so the fresh listener
 * saw the pop as a user pressing Back and raised the question with nobody having touched anything.
 *
 * `history.back` is replaced here by an asynchronous pop, as in a browser.
 */
import { StrictMode } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

import { useDirtyGuard } from '@/ui-kit/hooks/useDirtyGuard';

const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 60)));

afterEach(async () => {
  vi.restoreAllMocks();
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 30));
});

function Probe({ onAsk }: { onAsk: (open: boolean) => void }) {
  const guard = useDirtyGuard({ dirty: true, onClose: () => {} });
  onAsk(guard.confirmOpen);
  return null;
}

describe('useDirtyGuard on an overlay that opens dirty, under StrictMode', () => {
  it('does not ask on its own when the browser delivers its own marker pop late', async () => {
    let backs = 0;
    vi.spyOn(window.history, 'back').mockImplementation(() => {
      backs += 1;
      // A browser's history pop: delivered in a later task, not inside the call.
      setTimeout(() => window.dispatchEvent(new PopStateEvent('popstate')), 0);
    });
    let asked = false;
    render(
      <StrictMode>
        <Probe onAsk={(open) => { asked = open; }} />
      </StrictMode>,
    );
    await settle();
    expect(backs).toBe(1); // the simulated unmount really took its marker off
    expect(asked).toBe(false);
  });

  it('still asks when the user really presses Back', async () => {
    let asked = false;
    render(<Probe onAsk={(open) => { asked = open; }} />);
    await settle();
    act(() => { window.history.back(); });
    await settle();
    expect(asked).toBe(true);
  });
});
