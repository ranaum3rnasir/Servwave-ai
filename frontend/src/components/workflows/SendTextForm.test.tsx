import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import SendTextForm from './SendTextForm';
import { FORM_CATALOG } from './step-forms.fixture';

function setup(config: Record<string, unknown> = { recipient: 'customer', body: '' }) {
  const onChange = vi.fn();
  renderWithProviders(
    <SendTextForm config={config} triggerType="JOB_SCHEDULED" catalog={FORM_CATALOG} onChange={onChange} />,
  );
  return { onChange, body: () => screen.getByLabelText('Message') as HTMLTextAreaElement };
}

describe('SendTextForm — merge chips', () => {
  it('inserts {{job.number}} at the caret and flips that chip to "in use"', async () => {
    setup({ recipient: 'customer', body: 'AB' });
    const textarea = screen.getByLabelText('Message') as HTMLTextAreaElement;
    const chip = screen.getByRole('button', { name: /Job number/i });
    expect(chip).toHaveAttribute('aria-pressed', 'false');

    // Caret between A and B.
    textarea.focus();
    textarea.setSelectionRange(1, 1);
    await userEvent.click(chip);

    expect(textarea.value).toBe('A{{job.number}}B');
    expect(screen.getByRole('button', { name: /Job number/i })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('SendTextForm — 320-char limit', () => {
  it('a 321-char body shows the plain-English error and the meter turns red', async () => {
    setup();
    const textarea = screen.getByLabelText('Message') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'a'.repeat(321) } });

    expect(await screen.findByText('Texts are capped at 320 characters')).toBeInTheDocument();
    const meter = screen.getByText('321 / 320');
    expect(meter.className).toContain('text-danger');
  });

  it('a 250-char body has no error', () => {
    setup();
    const textarea = screen.getByLabelText('Message') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'a'.repeat(250) } });

    expect(screen.queryByText('Texts are capped at 320 characters')).toBeNull();
    expect(screen.getByText('250 / 320')).toBeInTheDocument();
  });
});

describe('SendTextForm — propagation wiring', () => {
  it('calls onChange with the parsed config on a valid edit', () => {
    const { onChange } = setup();
    const textarea = screen.getByLabelText('Message') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Hello there' } });

    expect(onChange).toHaveBeenLastCalledWith({ recipient: 'customer', body: 'Hello there' });
  });
});
