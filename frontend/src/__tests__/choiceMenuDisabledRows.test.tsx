/**
 * ChoiceMenu: a plain `disabled` option keeps the menu primitive's own disabled markers
 * (aria-disabled and data-disabled). The `locked` option adds its own aria-disabled, but must
 * never strip the one a `disabled` row gets from the primitive.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/__tests__/helpers';
import { DESKTOP, emulateDevice } from '@/__tests__/support/deviceShape';
import { ChoiceMenu } from '@/ui-kit/components/ui/choiceMenu';

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

describe('ChoiceMenu on a computer', () => {
  it('marks a plain disabled option aria-disabled and data-disabled, and a normal one neither', async () => {
    restore = emulateDevice(DESKTOP);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderWithProviders(
      <ChoiceMenu
        title="Pick"
        trigger={<button type="button">Open</button>}
        options={[
          { key: 'a', label: 'Open option', onSelect: vi.fn() },
          { key: 'b', label: 'Off option', disabled: true, onSelect: vi.fn() },
        ]}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Open' }));

    const off = await screen.findByRole('menuitem', { name: 'Off option' });
    expect(off).toHaveAttribute('aria-disabled', 'true');
    expect(off).toHaveAttribute('data-disabled');
    expect(screen.getByRole('menuitem', { name: 'Open option' })).not.toHaveAttribute('aria-disabled');
  });
});
