/**
 * Mobile slice 05 (PRD module 10, stories 109/110/119, rubric CMP-14): the public estimate's
 * signature pad, as the page hosts it.
 *
 * Audit F20 (and why the 2026-04-10 "ResizeObserver fix" never worked): the observer effect ran
 * once, on the page's FIRST render, which is the loading spinner. The pad's container did not
 * exist yet, so nothing was ever observed and the buffer stayed at its 600x128 default on every
 * phone (ink drawn at the wrong scale). And had it fired, it reset the buffer and set "signed" to
 * false, so a rotation silently wiped the signature and disabled Approve.
 *
 * The real drawing library needs a 2D canvas, which jsdom does not have, so it is replaced by a
 * stand-in that renders the same <canvas> with the props the page passes and records what the
 * page asks it to draw. The real library runs in the mobile gate (e2e/mobile/signature.spec.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useAuthStore } from '@/stores/auth.store';
import { renderPublicEstimate, servePublicEstimate } from '@/__tests__/harness/publicEstimatePage';
import { CAPTURED, PUBLIC_PAYLOAD_DEPOSIT_OUTSTANDING } from '@/__tests__/fixtures/public-estimate-payload';

type Point = { x: number; y: number; time: number; color: string };

const pad = vi.hoisted(() => ({
  /** What the stand-in currently "holds" (the library's own point groups). */
  data: [] as Array<Array<{ x: number; y: number; time: number; color: string }>>,
  /** Ordered log of the calls the page made: drawing scale, redraws, clears. */
  calls: [] as unknown[][],
  props: null as null | { onEnd?: () => void; canvasProps?: Record<string, unknown> },
}));

vi.mock('react-signature-canvas', async () => {
  const React = await import('react');
  class FakeSignatureCanvas extends React.Component<{ onEnd?: () => void; canvasProps?: Record<string, unknown> }> {
    canvas: HTMLCanvasElement | null = null;
    getCanvas = () => {
      if (!this.canvas) throw new Error('unmounted');
      return this.canvas;
    };
    toData = () => pad.data;
    fromData = (d: typeof pad.data) => {
      pad.calls.push(['fromData', structuredClone(d)]);
      pad.data = d;
    };
    clear = () => {
      pad.calls.push(['clear']);
      pad.data = [];
    };
    isEmpty = () => pad.data.length === 0;
    toDataURL = () => 'data:image/png;base64,SIGNED';
    override render() {
      pad.props = this.props;
      return React.createElement('canvas', {
        ref: (c: HTMLCanvasElement | null) => {
          this.canvas = c;
        },
        ...this.props.canvasProps,
      });
    }
  }
  return { default: FakeSignatureCanvas };
});

vi.mock('react-router-dom', async () => (await import('@/__tests__/harness/publicEstimateMocks')).publicRouter());

/** A ResizeObserver whose callbacks the test fires, standing in for a real layout change. */
const observers: Array<{ cb: ResizeObserverCallback; targets: Element[] }> = [];
class ControlledResizeObserver {
  private rec: { cb: ResizeObserverCallback; targets: Element[] };
  constructor(cb: ResizeObserverCallback) {
    this.rec = { cb, targets: [] };
    observers.push(this.rec);
  }
  observe(el: Element) {
    this.rec.targets.push(el);
  }
  unobserve() {}
  disconnect() {
    this.rec.targets = [];
  }
}

/** Every observed element now measures width x height (a resize or a rotation). */
function resizeTo(width: number, height: number) {
  act(() => {
    for (const o of observers) {
      if (o.targets.length === 0) continue;
      const entries = o.targets.map(
        (target) => ({ target, contentRect: { width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0 } }) as unknown as ResizeObserverEntry,
      );
      o.cb(entries, o as unknown as ResizeObserver);
    }
  });
}

const SIGNED_OUT = { user: null, isAuthenticated: false, isLoading: false };
const stroke = (pts: Array<[number, number]>): Point[] => pts.map(([x, y], i) => ({ x, y, time: 1000 + i * 16, color: 'black' }));
const STROKES = [stroke([[20, 40], [60, 80], [100, 120]])];

function payload() {
  const base = structuredClone(PUBLIC_PAYLOAD_DEPOSIT_OUTSTANDING) as Record<string, unknown>;
  const estimate = base.estimate as Record<string, unknown>;
  estimate.invoices = [];
  estimate.send_config = null;
  estimate.status = 'SENT';
  return { ...base, organization: { ...(base.organization as object), estimate_terms: null } };
}

let fetchMock: ReturnType<typeof vi.fn>;
let pixelRatio = 3;

beforeEach(() => {
  vi.clearAllMocks();
  pad.data = [];
  pad.calls = [];
  pad.props = null;
  observers.length = 0;
  pixelRatio = 3;
  vi.stubGlobal('ResizeObserver', ControlledResizeObserver);
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, get: () => pixelRatio });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    return {
      setTransform: (...args: number[]) => pad.calls.push(['setTransform', ...args]),
    } as unknown as CanvasRenderingContext2D;
  } as unknown as HTMLCanvasElement['getContext']);
  fetchMock = servePublicEstimate({
    page: () => payload(),
    write: () => ({ body: { estimate: { ...(payload().estimate as object), status: 'WON' } } }),
  });
  vi.mocked(useAuthStore).mockImplementation(((selector?: (s: unknown) => unknown) =>
    selector ? selector(SIGNED_OUT) : SIGNED_OUT) as unknown as typeof useAuthStore);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1, writable: true });
});

async function renderPage() {
  renderPublicEstimate({ id: CAPTURED.estimateId, entry: `/p/estimates/${CAPTURED.estimateId}?token=tok-1` });
  await screen.findByText('Door install');
  // The page's only canvas (the label has its own test, so every other test fails on behaviour).
  const canvas = document.querySelector('canvas');
  if (!canvas) throw new Error('no signature canvas rendered');
  return canvas;
}

/** The customer finishes a stroke: the library now holds it and tells the page. */
function drawStroke(strokes = STROKES) {
  act(() => {
    pad.data = structuredClone(strokes);
    pad.props?.onEnd?.();
  });
}

const approveButton = () => screen.getByRole('button', { name: /approve estimate/i });
const lastCall = (name: string) => [...pad.calls].reverse().find((c) => c[0] === name);

describe('public estimate signature pad - buffer sized to the box (CMP-14)', () => {
  it.each([
    [1, 302, 160],
    [2, 604, 320],
    [2.625, 793, 420],
    [3, 906, 480],
  ])('at pixel ratio %s the buffer is %s x %s once the pad is laid out at 302 x 160', async (ratio, w, h) => {
    pixelRatio = ratio;
    const canvas = await renderPage();
    resizeTo(302, 160);
    expect(canvas.getAttribute('width')).toBe(String(w));
    expect(canvas.getAttribute('height')).toBe(String(h));
  });

  it('draws at the same scale the buffer was grown by, so the ink lands under the finger', async () => {
    await renderPage();
    resizeTo(302, 160);
    expect(lastCall('setTransform')).toEqual(['setTransform', 3, 0, 0, 3, 0, 0]);
  });

  it('has an accessible name', async () => {
    const canvas = await renderPage();
    expect(canvas.tagName).toBe('CANVAS');
    expect(canvas).toHaveAccessibleName(/signature/i);
  });
});

describe('public estimate signature pad - rotation keeps the signature (CMP-14)', () => {
  it('redraws the same strokes, unstretched, at the new size and keeps Approve enabled', async () => {
    const canvas = await renderPage();
    resizeTo(302, 160);
    drawStroke();
    expect(approveButton()).toBeEnabled();

    pad.calls = [];
    resizeTo(638, 160); // portrait -> landscape: wider, same height
    expect(canvas.getAttribute('width')).toBe(String(638 * 3));
    // The scale is reset for the new buffer BEFORE the strokes are drawn again.
    const order = pad.calls.map((c) => c[0]);
    expect(order.indexOf('setTransform')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('setTransform')).toBeLessThan(order.lastIndexOf('fromData'));
    expect(lastCall('fromData')).toEqual(['fromData', STROKES]);
    expect(approveButton()).toBeEnabled();

    resizeTo(302, 160); // and back
    expect(lastCall('fromData')).toEqual(['fromData', STROKES]);
    expect(approveButton()).toBeEnabled();
  });

  it('a signed estimate still submits after a rotation, with the pad image', async () => {
    await renderPage();
    resizeTo(302, 160);
    drawStroke();
    resizeTo(638, 160);
    resizeTo(302, 160);
    await userEvent.click(approveButton());
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true));
    const [, init] = fetchMock.mock.calls.find(([, i]) => i?.method === 'POST')!;
    expect(JSON.parse(init.body as string).signature_data).toBe('data:image/png;base64,SIGNED');
  });

  it('Clear forgets the signature, so a later rotation does not bring it back', async () => {
    await renderPage();
    resizeTo(302, 160);
    drawStroke();
    await userEvent.click(screen.getByRole('button', { name: /^clear/i }));
    expect(approveButton()).toBeDisabled();

    pad.calls = [];
    resizeTo(638, 160);
    expect(pad.calls.some((c) => c[0] === 'fromData')).toBe(false);
    expect(approveButton()).toBeDisabled();
  });
});
