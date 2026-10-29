/**
 * Collapse follows the reduced-motion setting (mobile slice 16, A11Y-05).
 *
 * framer-motion's `reducedMotion` only switches off transform and layout animations; a height
 * animation keeps running for someone who asked the system for less motion. So Collapse reads the
 * setting itself (through MotionConfig, which the app root sets to follow the OS) and opens and
 * closes in one step when it is on.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MotionConfig } from 'framer-motion';

import { Collapse } from '@/components/ui/collapse';

function Tree({ open, reduced }: { open: boolean; reduced: boolean }) {
  return (
    <MotionConfig reducedMotion={reduced ? 'always' : 'never'}>
      <Collapse open={open}>
        <p>Section body</p>
      </Collapse>
    </MotionConfig>
  );
}

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

describe('Collapse and reduced motion', () => {
  it('with reduced motion on, closing removes the section at once instead of animating for 200 ms', async () => {
    const { rerender } = render(<Tree open reduced />);
    expect(screen.getByText('Section body')).toBeInTheDocument();
    rerender(<Tree open={false} reduced />);
    // Well inside the 200 ms the animation would take.
    await waitFor(() => expect(screen.queryByText('Section body')).not.toBeInTheDocument(), { timeout: 80, interval: 5 });
  });

  it('with reduced motion on, opening shows the section at full height with no animation in flight', async () => {
    const { rerender, container } = render(<Tree open={false} reduced />);
    rerender(<Tree open reduced />);
    await sleep(40);
    const wrapper = container.querySelector('div') as HTMLElement;
    expect(screen.getByText('Section body')).toBeInTheDocument();
    expect(wrapper.style.height).toBe('auto');
    expect(wrapper.style.opacity).toBe('1');
  });

  it('control: with reduced motion off, the section is still animating out 60 ms after closing', async () => {
    const { rerender } = render(<Tree open reduced={false} />);
    rerender(<Tree open={false} reduced={false} />);
    await sleep(60);
    expect(screen.getByText('Section body')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Section body')).not.toBeInTheDocument(), { timeout: 1500 });
  });
});
