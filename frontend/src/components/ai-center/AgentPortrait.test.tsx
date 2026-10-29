import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { AgentPortrait } from './AgentPortrait';

// A controllable IntersectionObserver: tests decide when a portrait is on screen.
type IOCallback = (entries: Array<Pick<IntersectionObserverEntry, 'isIntersecting' | 'target'>>) => void;
let observers: Array<{ cb: IOCallback; targets: Element[]; disconnected: boolean }> = [];

class FakeIntersectionObserver {
  private record: (typeof observers)[number];
  constructor(cb: IOCallback) {
    this.record = { cb, targets: [], disconnected: false };
    observers.push(this.record);
  }
  observe(el: Element) {
    this.record.targets.push(el);
  }
  unobserve() {}
  disconnect() {
    this.record.disconnected = true;
  }
  takeRecords() {
    return [];
  }
}

function setOnScreen(isIntersecting: boolean) {
  act(() => {
    for (const o of observers) {
      if (o.disconnected) continue;
      o.cb(o.targets.map((target) => ({ isIntersecting, target })));
    }
  });
}

function setReducedMotion(reduce: boolean) {
  vi.mocked(window.matchMedia).mockImplementation(
    (query: string) =>
      ({
        matches: reduce && query.includes('prefers-reduced-motion'),
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }) as unknown as MediaQueryList,
  );
}

const srcs = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('img')).map((img) => img.getAttribute('src'));

beforeEach(() => {
  observers = [];
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
  setReducedMotion(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AgentPortrait', () => {
  it('shows the still first, named for the animal', () => {
    const { container } = render(<AgentPortrait agentId="jordan" name="Woodpecker" size={48} />);
    expect(screen.getByRole('img', { name: 'Woodpecker' })).toHaveAttribute(
      'src',
      '/ai-center/agents/still/jordan.jpg',
    );
    expect(srcs(container)).toEqual(['/ai-center/agents/still/jordan.jpg']);
  });

  it('swaps in the loop only while on screen, and drops it when scrolled away', () => {
    const { container } = render(<AgentPortrait agentId="jordan" name="Woodpecker" size={48} />);
    setOnScreen(true);
    expect(srcs(container)).toEqual([
      '/ai-center/agents/still/jordan.jpg',
      '/ai-center/agents/loop/jordan.webp',
    ]);
    // The loop fades in over the still only once it has decoded.
    const loop = container.querySelector('img[src$=".webp"]') as HTMLImageElement;
    expect(loop.className).toContain('opacity-0');
    fireEvent.load(loop);
    expect(loop.className).toContain('opacity-100');
    expect(container.querySelector('[data-agent-portrait]')).toHaveAttribute('data-playing', 'true');
    // Still one accessible image, not two.
    expect(screen.getAllByRole('img', { name: 'Woodpecker' })).toHaveLength(1);

    setOnScreen(false);
    expect(srcs(container)).toEqual(['/ai-center/agents/still/jordan.jpg']);
  });

  it('keeps the still under reduced motion, even on screen', () => {
    setReducedMotion(true);
    const { container } = render(<AgentPortrait agentId="jordan" name="Woodpecker" size={48} />);
    setOnScreen(true);
    expect(srcs(container)).toEqual(['/ai-center/agents/still/jordan.jpg']);
    // It does not even watch the viewport: nothing would ever play.
    expect(observers).toHaveLength(0);
  });

  it('keeps the still when animation is switched off (the job page tiles)', () => {
    const { container } = render(
      <AgentPortrait agentId="carlos" name="Hawk" size={36} animate={false} />,
    );
    setOnScreen(true);
    expect(srcs(container)).toEqual(['/ai-center/agents/still/carlos.jpg']);
  });

  it('falls back to the still when the loop fails to load', () => {
    const { container } = render(<AgentPortrait agentId="jordan" name="Woodpecker" size={48} />);
    setOnScreen(true);
    fireEvent.error(container.querySelector('img[src$=".webp"]') as HTMLImageElement);
    expect(srcs(container)).toEqual(['/ai-center/agents/still/jordan.jpg']);
  });

  it('gives the Master Agent its still portrait and no loop', () => {
    const { container } = render(<AgentPortrait agentId="master" name="Master Agent" size={48} />);
    setOnScreen(true);
    expect(srcs(container)).toEqual(['/ai-center/agents/master.png']);
  });

  it('stays still where IntersectionObserver does not exist', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const { container } = render(<AgentPortrait agentId="jordan" name="Woodpecker" size={48} />);
    expect(srcs(container)).toEqual(['/ai-center/agents/still/jordan.jpg']);
  });

  it('a decorative portrait is hidden from assistive tech', () => {
    render(<AgentPortrait agentId="jordan" name="Woodpecker" size={48} decorative />);
    expect(screen.queryByRole('img', { name: 'Woodpecker' })).toBeNull();
  });

  it('sizes itself from the size prop', () => {
    const { container } = render(<AgentPortrait agentId="jordan" name="Woodpecker" size={64} />);
    const box = container.querySelector('[data-agent-portrait]') as HTMLElement;
    expect(box.style.width).toBe('64px');
    expect(box.style.height).toBe('64px');
  });
});
