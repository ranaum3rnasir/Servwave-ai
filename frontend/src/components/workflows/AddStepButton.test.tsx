import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import AddStepButton from './AddStepButton';
import { lockedStepTypesFor } from '@/lib/workflows/featureFlags';
import type { WorkflowCatalog } from '@/lib/api/workflows';

async function openPicker() {
  await userEvent.click(screen.getByRole('button', { name: 'Add a step' }));
  return screen.findByRole('menu', { name: 'Add a step' });
}

describe('AddStepButton - the in-app step is not offered', () => {
  it('offers no in-app option', async () => {
    renderWithProviders(<AddStepButton onPick={vi.fn()} variant="block" />);
    const menu = await openPicker();
    expect(within(menu).queryByText('Notify team')).toBeNull();
    expect(within(menu).queryByText('In-app alert to your staff')).toBeNull();
  });

  it('offers exactly wait, send text, send email and stop if', async () => {
    renderWithProviders(<AddStepButton onPick={vi.fn()} variant="block" />);
    const menu = await openPicker();
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(4);
  });
});

describe('AddStepButton — SMS authoring lock', () => {
  it('locks "Send text": shows a "Not connected" badge and does not call onPick when activated', async () => {
    const onPick = vi.fn();
    renderWithProviders(<AddStepButton onPick={onPick} variant="block" />);
    const menu = await openPicker();

    const row = within(menu).getByText('Send text').closest('[role="menuitem"]') as HTMLElement;
    expect(within(row).getByText('Not connected')).toBeInTheDocument();
    expect(row).toHaveAttribute('aria-disabled', 'true');

    await userEvent.click(row);
    expect(onPick).not.toHaveBeenCalled();
  });

  it('keeps the other three step types pickable', async () => {
    const onPick = vi.fn();
    renderWithProviders(<AddStepButton onPick={onPick} variant="block" />);
    const menu = await openPicker();

    await userEvent.click(within(menu).getByText('Send email'));
    expect(onPick).toHaveBeenCalledWith('SEND_EMAIL');
  });

  it('unlocks "Send text" when the locked set is empty (post-CTM)', async () => {
    const onPick = vi.fn();
    renderWithProviders(<AddStepButton onPick={onPick} variant="block" lockedTypes={[]} />);
    const menu = await openPicker();

    expect(within(menu).queryByText('Not connected')).toBeNull();
    await userEvent.click(within(menu).getByText('Send text'));
    expect(onPick).toHaveBeenCalledWith('SEND_TEXT');
  });

  // SERV10X-70: the lock is per-org (catalog.capabilities.sms_available), not a
  // hardcoded flag — drive lockedTypes off the same helper BuilderSpine uses.
  it('locks "Send text" when the catalog reports the org cannot text', async () => {
    const onPick = vi.fn();
    const catalog = { capabilities: { sms_available: false } } as unknown as WorkflowCatalog;
    renderWithProviders(<AddStepButton onPick={onPick} variant="block" lockedTypes={lockedStepTypesFor(catalog)} />);
    const menu = await openPicker();

    const row = within(menu).getByText('Send text').closest('[role="menuitem"]') as HTMLElement;
    expect(row).toHaveAttribute('aria-disabled', 'true');
  });

  it('unlocks "Send text" when the catalog reports the org can text', async () => {
    const onPick = vi.fn();
    const catalog = { capabilities: { sms_available: true } } as unknown as WorkflowCatalog;
    renderWithProviders(<AddStepButton onPick={onPick} variant="block" lockedTypes={lockedStepTypesFor(catalog)} />);
    const menu = await openPicker();

    await userEvent.click(within(menu).getByText('Send text'));
    expect(onPick).toHaveBeenCalledWith('SEND_TEXT');
  });
});
