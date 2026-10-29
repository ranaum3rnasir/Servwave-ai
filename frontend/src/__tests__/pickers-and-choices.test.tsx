// Mobile slice 44 (CMP-05, CMP-07; stories 51, 53, 54): short choices are a bottom sheet below md and
// the menu they were from md up; searchable pickers are a full-screen sheet below md and the popover
// they were from md up; a touch move over the customer picker's results is not swallowed by the
// surrounding dialog's scroll lock. jsdom applies no CSS, so presentations are read from
// `data-presentation` / `data-picker` and the classes that carry the geometry; the real-browser
// measurement is e2e/mobile/popovers-and-pickers.spec.ts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { MEDIA } from '@/ui-kit/lib/breakpoints';
import { ChoiceMenu } from '@/ui-kit/components/ui/choiceMenu';
import { Combobox as KitCombobox } from '@/ui-kit/components/form/combobox';
import { Combobox } from '@/components/ui/combobox';
import { CustomerPickerWithCreate } from '@/components/crm/CustomerPickerWithCreate';
import { Dialog, DialogContent, DialogTitle } from '@/ui-kit/components/ui/dialog';
import api from '@/lib/axios';

vi.mock('@/lib/axios', () => ({ default: { get: vi.fn(), post: vi.fn() } }));
vi.mock('@/contexts/AbilityContext', () => ({ useAppAbility: () => ({ can: () => true }) }));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

function mockWidth(opts: { belowMd: boolean; shortHeight?: boolean }) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: (query === MEDIA.belowMd && opts.belowMd) || (query === MEDIA.shortHeight && !!opts.shortHeight),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const OPTIONS = ['Waiting on parts', 'Waiting on customer', 'Ready to dispatch'];

function Choice({ onSelect }: { onSelect: (label: string) => void }) {
  return (
    <ChoiceMenu
      title="Sub-status"
      trigger={<button type="button">Set sub-status</button>}
      options={[
        ...OPTIONS.map((label) => ({ key: label, label, onSelect: () => onSelect(label) })),
        { key: 'none', label: 'None', separatorBefore: true, onSelect: () => onSelect('none') },
      ]}
    />
  );
}

describe('ChoiceMenu: a short choice', () => {
  it('is a bottom sheet below md: edge to edge, 44 px rows, the title names it', async () => {
    mockWidth({ belowMd: true });
    const user = userEvent.setup();
    render(<Choice onSelect={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Set sub-status' }));
    const sheet = await screen.findByRole('dialog', { name: 'Sub-status' });
    expect(sheet).toHaveAttribute('data-presentation', 'bottom-sheet');
    expect(sheet.className).toContain('bottom-[var(--keyboard-inset,0px)]');
    const rows = within(sheet).getAllByRole('button').filter((b) => b.getAttribute('aria-label') !== 'Close');
    expect(rows.map((r) => r.textContent)).toEqual([...OPTIONS, 'None']);
    for (const row of rows) expect(row.className).toContain('min-h-11');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('choosing a row runs it once and closes the sheet', async () => {
    mockWidth({ belowMd: true });
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<Choice onSelect={onSelect} />);
    await user.click(screen.getByRole('button', { name: 'Set sub-status' }));
    await user.click(await screen.findByRole('button', { name: 'Waiting on customer' }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('Waiting on customer');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('stays the menu from md up, with the same rows in the same order', async () => {
    mockWidth({ belowMd: false });
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<Choice onSelect={onSelect} />);
    await user.click(screen.getByRole('button', { name: 'Set sub-status' }));
    const menu = await screen.findByRole('menu');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual([...OPTIONS, 'None']);
    await user.click(within(menu).getByRole('menuitem', { name: 'Ready to dispatch' }));
    expect(onSelect).toHaveBeenCalledWith('Ready to dispatch');
  });

  it('is a menu on a phone held sideways (wide but short): a card, not a sheet', async () => {
    mockWidth({ belowMd: false, shortHeight: true });
    const user = userEvent.setup();
    render(<Choice onSelect={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Set sub-status' }));
    expect(await screen.findByRole('menu')).toBeInTheDocument();
  });
});

const MANY = Array.from({ length: 12 }, (_, i) => ({ value: `v${i}`, label: `Person ${i + 1}` }));

describe('searchable pickers: full-screen below md, a popover from md up', () => {
  const cases: Array<[string, (onValueChange: (v: string) => void) => React.ReactElement]> = [
    ['app combobox', (onValueChange) => <Combobox aria-label="Assignee" value="" onValueChange={onValueChange} options={MANY} />],
    ['kit combobox', (onValueChange) => <KitCombobox aria-label="Assignee" value="" onValueChange={onValueChange} options={MANY} />],
  ];

  for (const [name, make] of cases) {
    it(`${name}: a full-screen dialog on a phone, with the search field above the results`, async () => {
      mockWidth({ belowMd: true });
      const onValueChange = vi.fn();
      const user = userEvent.setup();
      render(make(onValueChange));
      await user.click(screen.getByRole('combobox', { name: 'Assignee' }));
      const dialog = await screen.findByRole('dialog', { name: 'Assignee' });
      expect(dialog).toHaveAttribute('data-presentation', 'fullscreen');
      expect(dialog.className).toContain('inset-0');
      expect(dialog.className).toContain('h-[calc(100dvh-var(--keyboard-inset,0px))]');
      const input = within(dialog).getByPlaceholderText(/search/i);
      const option = within(dialog).getByText('Person 7');
      // The field comes before the results in the document, so it sits above them and the keyboard.
      expect(input.compareDocumentPosition(option) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      await user.click(option);
      expect(onValueChange).toHaveBeenCalledWith('v6');
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it(`${name}: filters inside the full-screen dialog`, async () => {
      mockWidth({ belowMd: true });
      const user = userEvent.setup();
      render(make(() => {}));
      await user.click(screen.getByRole('combobox', { name: 'Assignee' }));
      const dialog = await screen.findByRole('dialog', { name: 'Assignee' });
      await user.type(within(dialog).getByPlaceholderText(/search/i), 'Person 12');
      expect(within(dialog).getByText('Person 12')).toBeInTheDocument();
      expect(within(dialog).queryByText('Person 3')).toBeNull();
    });

    it(`${name}: no dialog from md up - the popover it always was`, async () => {
      mockWidth({ belowMd: false });
      const user = userEvent.setup();
      render(make(() => {}));
      await user.click(screen.getByRole('combobox', { name: 'Assignee' }));
      expect(await screen.findByText('Person 7')).toBeInTheDocument();
      // A popover is itself role="dialog" (Radix); what must be absent is the full-screen sheet.
      expect(document.querySelector('[data-picker="fullscreen"]')).toBeNull();
      expect(document.querySelector('[data-slot="popover-content"], [role="dialog"]')?.getAttribute('data-presentation')).toBeNull();
    });

    it(`${name}: full-screen on a phone held sideways too (wide but short)`, async () => {
      mockWidth({ belowMd: false, shortHeight: true });
      const user = userEvent.setup();
      render(make(() => {}));
      await user.click(screen.getByRole('combobox', { name: 'Assignee' }));
      expect(await screen.findByRole('dialog', { name: 'Assignee' })).toHaveAttribute('data-presentation', 'fullscreen');
    });
  }
});

describe('CustomerPickerWithCreate: the customer picker inside a dialog', () => {
  const customers = Array.from({ length: 20 }, (_, i) => ({
    id: `c${i}`, first_name: 'Picker', last_name: `Customer ${i + 1}`, company_name: null, email: null, customer_number: `C${i + 1}`,
  }));

  function renderInDialog() {
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { customers } });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <Dialog open>
          <DialogContent aria-describedby={undefined}>
            <DialogTitle>New thing</DialogTitle>
            <CustomerPickerWithCreate value="" valueLabel="" onChange={() => {}} />
          </DialogContent>
        </Dialog>
      </QueryClientProvider>,
    );
  }

  it('a touch move over its results is not cancelled by the dialog scroll lock (wide layout)', async () => {
    mockWidth({ belowMd: false });
    renderInDialog();
    fireEvent.click(screen.getByRole('button', { name: /select customer/i }));
    const results = await screen.findByTestId('customer-picker-results');
    await screen.findByText(/Customer 20/);
    // react-remove-scroll's document-level listener: it cancels every touch move outside its shard.
    const lock = vi.fn((event: Event) => event.preventDefault());
    document.addEventListener('touchmove', lock, { passive: false });
    try {
      const move = new Event('touchmove', { bubbles: true, cancelable: true });
      results.dispatchEvent(move);
      expect(lock, 'the lock never saw the move').not.toHaveBeenCalled();
      expect(move.defaultPrevented, 'so the browser may scroll the list').toBe(false);
    } finally {
      document.removeEventListener('touchmove', lock);
    }
  });

  it('is a full-screen dialog on a phone, its results the scroller', async () => {
    mockWidth({ belowMd: true });
    renderInDialog();
    fireEvent.click(screen.getByRole('button', { name: /select customer/i }));
    const picker = await screen.findByRole('dialog', { name: 'Customer' });
    expect(picker).toHaveAttribute('data-presentation', 'fullscreen');
    const results = within(picker).getByTestId('customer-picker-results');
    expect(results.className).toContain('flex-1');
    expect(results.className).toContain('overflow-y-auto');
    expect(results.className).not.toContain('max-h-60');
    await screen.findByText(/Customer 20/);
  });
});
