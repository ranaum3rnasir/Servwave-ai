import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { InfoPopover } from '../infoPopover';

describe('InfoPopover', () => {
  it('opens its note on click, and not on hover', async () => {
    const user = userEvent.setup();
    render(<InfoPopover label="Next payout">Payouts go to your bank.</InfoPopover>);

    const trigger = screen.getByRole('button', { name: 'More about Next payout' });
    await user.hover(trigger);
    expect(screen.queryByText('Payouts go to your bank.')).not.toBeInTheDocument();

    await user.click(trigger);
    expect(await screen.findByText('Payouts go to your bank.')).toBeInTheDocument();
  });

  it('opens from the keyboard', async () => {
    const user = userEvent.setup();
    render(<InfoPopover label="Next payout">Note</InfoPopover>);
    await user.tab();
    await user.keyboard('{Enter}');
    expect(await screen.findByText('Note')).toBeInTheDocument();
  });

  it('is still importable from every module that used it before the move', async () => {
    // A bad import path throws when the module loads; each of these imports the shared popover.
    const importers = await Promise.all([
      import('@/components/communication/phone/TextingView'),
      import('@/components/communication/phone/CallMaskingView'),
      import('@/pages/v2/settings/PaymentsListsPage'),
      import('@/pages/v2/settings/components/taskCategoriesSettingsCard'),
      import('@/pages/v2/settings/components/tagsSettingsCard'),
    ]);
    for (const mod of importers) expect(mod).toBeTruthy();
  });
});
