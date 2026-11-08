import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import WaitForm from './WaitForm';

describe('WaitForm — presets + custom write duration_minutes', () => {
  it('the "1 day" preset writes 1440', () => {
    const onChange = vi.fn();
    renderWithProviders(<WaitForm config={{ duration_minutes: 60 }} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: '1 day' }));
    expect(onChange).toHaveBeenLastCalledWith({ duration_minutes: 1440 });
  });

  it('a custom value of 3 with the hours unit writes 180', () => {
    const onChange = vi.fn();
    // 120 minutes is not a preset → the form opens in custom mode seeded to hours.
    renderWithProviders(<WaitForm config={{ duration_minutes: 120 }} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText('Wait amount'), { target: { value: '3' } });
    expect(onChange).toHaveBeenLastCalledWith({ duration_minutes: 180 });
  });
});

describe('WaitForm — anchored mode (only offered when the trigger has an anchor)', () => {
  const anchor = { key: 'lead.walkthrough_scheduled_at' as const, label: 'the walkthrough' };

  it('with anchor={null}, no mode toggle renders and relative behavior is unchanged', () => {
    const onChange = vi.fn();
    renderWithProviders(<WaitForm config={{ duration_minutes: 60 }} onChange={onChange} anchor={null} />);

    expect(screen.queryByText(/before \/ after/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '1 day' }));
    expect(onChange).toHaveBeenLastCalledWith({ duration_minutes: 1440 });
  });

  it('defaults to the relative tab even when an anchor is offered', () => {
    const onChange = vi.fn();
    renderWithProviders(<WaitForm config={{}} onChange={onChange} anchor={anchor} />);

    expect(screen.getByRole('button', { name: /wait a set time/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /before \/ after the walkthrough/i })).toHaveAttribute('aria-pressed', 'false');
  });

  it('choosing anchored + 1 day + before calls onChange with the anchored config', () => {
    const onChange = vi.fn();
    renderWithProviders(<WaitForm config={{}} onChange={onChange} anchor={anchor} />);

    fireEvent.click(screen.getByRole('button', { name: /before \/ after the walkthrough/i }));
    fireEvent.click(screen.getByRole('button', { name: '1 day' }));
    fireEvent.click(screen.getByRole('button', { name: 'Before' }));

    expect(onChange).toHaveBeenLastCalledWith({
      mode: 'anchored',
      anchor: 'lead.walkthrough_scheduled_at',
      direction: 'before',
      offset_minutes: 1440,
    });
  });

  it('choosing the after direction writes direction: "after"', () => {
    const onChange = vi.fn();
    renderWithProviders(<WaitForm config={{}} onChange={onChange} anchor={anchor} />);

    fireEvent.click(screen.getByRole('button', { name: /before \/ after the walkthrough/i }));
    fireEvent.click(screen.getByRole('button', { name: 'After' }));

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: 'anchored', direction: 'after' }),
    );
  });

  it('seeds the anchored tab and its fields from an incoming anchored config', () => {
    const onChange = vi.fn();
    renderWithProviders(
      <WaitForm
        config={{ mode: 'anchored', anchor: 'lead.walkthrough_scheduled_at', direction: 'after', offset_minutes: 60 }}
        onChange={onChange}
        anchor={anchor}
      />,
    );

    expect(screen.getByRole('button', { name: /before \/ after the walkthrough/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'After' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('switching back to "Wait a set time" emits the plain duration_minutes shape', () => {
    const onChange = vi.fn();
    renderWithProviders(
      <WaitForm
        config={{ mode: 'anchored', anchor: 'lead.walkthrough_scheduled_at', direction: 'before', offset_minutes: 1440 }}
        onChange={onChange}
        anchor={anchor}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /wait a set time/i }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ duration_minutes: expect.any(Number) }));
    expect(onChange.mock.calls.at(-1)?.[0]).not.toHaveProperty('mode');
  });
});
