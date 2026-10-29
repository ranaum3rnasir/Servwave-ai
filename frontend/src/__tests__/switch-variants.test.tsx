/**
 * The ui-kit Switch's additive variants (AI Agentic Farm controls, 14 Oct): a large size, a green
 * "running" tone, the On / Off word, a saving state and an unavailable-but-focusable state. A
 * Switch with none of the props renders as it always did.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Switch } from '@/ui-kit/components/ui/switch';

describe('Switch variants', () => {
  it('keeps the default look when no variant is asked for', () => {
    render(<Switch aria-label="Plain" />);
    const sw = screen.getByRole('switch', { name: 'Plain' });
    expect(sw).not.toHaveAttribute('data-size');
    expect(sw.querySelector('[data-slot="switch-track"]')).toHaveClass('h-5.5', 'w-9.5', 'group-data-[state=checked]/switch:bg-brand');
    expect(sw.querySelector('[data-slot="switch-label"]')).toBeNull();
  });

  it('the large green switch writes On / Off beside its 52x30 track, hidden from readers', () => {
    const { rerender } = render(<Switch aria-label="Agent" size="lg" tone="success" stateLabel checked={false} />);
    const sw = screen.getByRole('switch', { name: 'Agent' });
    expect(sw).toHaveClass('h-11');
    const track = sw.querySelector('[data-slot="switch-track"]')!;
    expect(track).toHaveClass('h-[30px]', 'w-[52px]', 'group-data-[state=checked]/switch:bg-success');
    expect(sw.querySelector('[data-slot="switch-thumb"]')).toHaveClass('size-[26px]');
    const label = sw.querySelector('[data-slot="switch-label"]')!;
    expect(label).toHaveAttribute('aria-hidden', 'true');
    expect(label).toHaveTextContent('Off');
    rerender(<Switch aria-label="Agent" size="lg" tone="success" stateLabel checked />);
    expect(label).toHaveTextContent('On');
  });

  it('ignores clicks and shows a spinner while busy', async () => {
    const onChange = vi.fn();
    render(<Switch aria-label="Saving" busy checked onCheckedChange={onChange} />);
    const sw = screen.getByRole('switch', { name: 'Saving' });
    expect(sw).toHaveAttribute('aria-busy', 'true');
    expect(sw.querySelector('[data-slot="switch-spinner"]')).not.toBeNull();
    await userEvent.click(sw);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('is focusable but does nothing while aria-disabled, with its reason as the description', async () => {
    const onChange = vi.fn();
    render(
      <>
        <Switch aria-label="Unavailable" aria-disabled aria-describedby="why" checked={false} onCheckedChange={onChange} />
        <p id="why">Set it up first</p>
      </>,
    );
    const sw = screen.getByRole('switch', { name: 'Unavailable' });
    sw.focus();
    expect(sw).toHaveFocus();
    expect(sw).toHaveAccessibleDescription('Set it up first');
    await userEvent.click(sw);
    expect(onChange).not.toHaveBeenCalled();
    expect(sw).not.toBeChecked();
  });

  it('stands still under reduced motion', () => {
    render(<Switch aria-label="Motion" />);
    const sw = screen.getByRole('switch', { name: 'Motion' });
    expect(sw.querySelector('[data-slot="switch-track"]')).toHaveClass('motion-reduce:transition-none');
    expect(sw.querySelector('[data-slot="switch-thumb"]')).toHaveClass('motion-reduce:transition-none');
  });
});
