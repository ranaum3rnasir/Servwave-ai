/**
 * Mobile slice 27 - one toaster, placed for phones, always closable.
 *
 * The older toast API (`@/components/ui/use-toast`, ~77 callers, including the global
 * rate-limit / plan / server-error toasts) is an adapter onto the single surviving
 * toaster (`@/ui-kit/components/ui/sonner`). Its own mount is gone.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { toast as sonnerToast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Toaster } from '@/ui-kit/components/ui/sonner';
import { toast, useToast } from '@/components/ui/use-toast';
import { handle429 } from '@/lib/handle429';
import { handle402 } from '@/lib/handle402';
import { handle500 } from '@/lib/handle500';

function mockPhone(isPhone: boolean) {
  window.matchMedia = ((query: string) => ({
    // Only the below-md query matches on a phone.
    matches: isPhone && /max-width/.test(query),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

/** sonner mounts a toast a tick after `toast()`; let timers and microtasks settle. */
async function flush(ms = 50) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function show(props: Parameters<typeof toast>[0]) {
  act(() => {
    toast(props);
  });
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  mockPhone(false);
});

afterEach(() => {
  act(() => {
    sonnerToast.dismiss();
  });
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('one toaster', () => {
  it('App mounts exactly one toaster, and the older toaster file is gone', () => {
    const app = readFileSync(join(__dirname, '..', 'App.tsx'), 'utf8');
    expect(app).not.toMatch(/components\/ui\/toaster/);
    expect(app.match(/<(Kit)?Toaster\b/g)).toHaveLength(1);
  });

  it('rendering the toaster mounts one live region', async () => {
    render(<Toaster />);
    await show({ title: 'One' });
    expect(document.querySelectorAll('[data-sonner-toaster]')).toHaveLength(1);
  });
});

describe('older toast API shows on the surviving toaster', () => {
  it('title and description', async () => {
    render(<Toaster />);
    await show({ title: 'Saved', description: 'Job J1 updated' });
    expect(screen.getByText('Saved')).toBeInTheDocument();
    expect(screen.getByText('Job J1 updated')).toBeInTheDocument();
  });

  it('description-only toast', async () => {
    render(<Toaster />);
    await show({ description: 'Text sent' });
    expect(screen.getByText('Text sent')).toBeInTheDocument();
  });

  it('variant destructive is an error toast', async () => {
    render(<Toaster />);
    await show({ title: 'Failed', variant: 'destructive' });
    expect(screen.getByText('Failed').closest('[data-sonner-toast]')).toHaveAttribute('data-type', 'error');
  });

  it('useToast().toast works too', async () => {
    function Probe() {
      const { toast: t } = useToast();
      return <button onClick={() => t({ title: 'From hook' })}>go</button>;
    }
    render(
      <>
        <Toaster />
        <Probe />
      </>,
    );
    fireEvent.click(screen.getByText('go'));
    await flush();
    expect(screen.getByText('From hook')).toBeInTheDocument();
  });

  it('auto-dismisses after the default, but duration Infinity stays', async () => {
    render(<Toaster />);
    await show({ title: 'Brief' });
    await show({ title: 'Sticky', variant: 'destructive', duration: Infinity });
    expect(screen.getByText('Brief')).toBeInTheDocument();
    await flush(10_000);
    expect(screen.queryByText('Brief')).not.toBeInTheDocument();
    expect(screen.getByText('Sticky')).toBeInTheDocument();
  });

  it('an action element becomes a working button', async () => {
    const onClick = vi.fn();
    render(<Toaster />);
    await show({
      title: 'Sent',
      // Same shape callers pass: an element carrying altText, onClick and a label.
      action: { type: 'ToastAction', props: { altText: 'Undo', onClick, children: 'Undo' } } as never,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('the global rate-limit, plan and server-error handlers still toast', async () => {
    render(<Toaster />);
    const err = (status: number, extra: object = {}) =>
      ({ response: { status, headers: {}, data: {}, ...extra }, config: { method: 'post' } }) as never;
    act(() => {
      handle429(err(429, { headers: { 'retry-after': '5' } }), toast, () => 1_000_000);
      handle402(
        { response: { status: 402, data: { feature: 'Texting', requiredPlan: 'Pro' } }, config: { method: 'post' } } as never,
        toast,
        () => 1_000_000,
      );
      handle500(err(500), toast, () => 1_000_000);
    });
    await flush();
    expect(document.querySelectorAll('[data-sonner-toast]').length).toBeGreaterThanOrEqual(2);
  });
});

describe('placement', () => {
  it('desktop keeps the bottom-right corner', async () => {
    mockPhone(false);
    render(<Toaster />);
    await show({ title: 'Placed' });
    const el = document.querySelector('[data-sonner-toaster]')!;
    expect(el).toHaveAttribute('data-y-position', 'bottom');
    expect(el).toHaveAttribute('data-x-position', 'right');
  });

  it('phone sits top-centre, below the top bar and inside the safe area', async () => {
    mockPhone(true);
    render(<Toaster />);
    await show({ title: 'Placed' });
    const el = document.querySelector('[data-sonner-toaster]') as HTMLElement;
    expect(el).toHaveAttribute('data-y-position', 'top');
    expect(el).toHaveAttribute('data-x-position', 'center');
    const top = el.style.getPropertyValue('--offset-top') + el.style.getPropertyValue('--mobile-offset-top');
    expect(top).toContain('env(safe-area-inset-top');
    expect(top).toContain('50px');
  });
});

describe('every toast is closable', () => {
  it.each([
    ['default', {}],
    ['error that never auto-dismisses', { variant: 'destructive' as const, duration: Infinity }],
  ])('%s toast has a visible, named close button that dismisses it', async (_n, extra) => {
    render(<Toaster />);
    await show({ title: 'Closable', ...extra });
    const close = screen.getByRole('button', { name: /close/i });
    expect(close).toBeVisible();
    fireEvent.click(close);
    await flush(1000);
    expect(screen.queryByText('Closable')).not.toBeInTheDocument();
  });
});

describe('a toast can be pressed while a modal is open', () => {
  // A Radix modal sets `pointer-events: none` on <body> and that inherits into the toaster. A toast
  // with no `pointer-events: auto` of its own cannot be pressed: not its close, not its action,
  // not a swipe. (jsdom does not load Tailwind, so the class is the contract here; the gate's
  // toaster spec presses the real close over a real dialog.)
  it('every toast restores pointer events for itself', async () => {
    render(<Toaster />);
    await show({ title: 'Pressable', variant: 'destructive', duration: Infinity });
    const el = document.querySelector('[data-sonner-toast]') as HTMLElement;
    expect(el.className.split(/\s+/)).toContain('pointer-events-auto');
  });
});
