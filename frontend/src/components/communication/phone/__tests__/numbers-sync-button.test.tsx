// The Sync numbers button on Communication -> Phone -> Phone numbers.
//
// The sync adds missing numbers and switches texting on where it is off, so the
// result the admin sees has to say both, in ServWave's own words.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import { NumbersView } from '../NumbersView';
import type { OwnedNumber } from '@/lib/api/communication';

const mockApi = vi.mocked(api);
const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);

function renderNumbers() {
  const onToast = vi.fn();
  const setNumbers = vi.fn();
  renderWithProviders(
    <NumbersView numbers={[]} setNumbers={setNumbers} callFlows={[]} onToast={onToast} />,
    { ability: ADMIN },
  );
  return { onToast, setNumbers };
}

function syncReturns(body: Record<string, unknown>) {
  mockApi.post.mockResolvedValue({
    data: { synced: 30, added: 0, texting_enabled: 0, texting_failed: 0, numbers: [], ...body },
  });
}

const pressSync = () => fireEvent.click(screen.getByRole('button', { name: /sync numbers/i }));

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockResolvedValue({ data: {} });
});

describe('Sync numbers button', () => {
  it('reports the numbers added and the numbers that had texting switched on', async () => {
    syncReturns({ added: 10, texting_enabled: 12 });
    const { onToast } = renderNumbers();

    pressSync();

    await waitFor(() =>
      expect(onToast).toHaveBeenCalledWith(
        'Sync complete: 10 numbers added, texting switched on for 12 numbers',
      ),
    );
    expect(mockApi.post).toHaveBeenCalledWith('/api/communication/numbers/refresh');
  });

  it('uses the singular for one number', async () => {
    syncReturns({ added: 1, texting_enabled: 1 });
    const { onToast } = renderNumbers();

    pressSync();

    await waitFor(() =>
      expect(onToast).toHaveBeenCalledWith(
        'Sync complete: 1 number added, texting switched on for 1 number',
      ),
    );
  });

  it('says so when texting could not be switched on for some numbers', async () => {
    syncReturns({ added: 0, texting_enabled: 10, texting_failed: 2 });
    const { onToast } = renderNumbers();

    pressSync();

    await waitFor(() =>
      expect(onToast).toHaveBeenCalledWith(
        'Sync complete: 0 numbers added, texting switched on for 10 numbers. Texting could not be switched on for 2 numbers yet',
      ),
    );
  });

  it('never names the phone vendor in the result', async () => {
    syncReturns({ added: 3, texting_enabled: 2, texting_failed: 1 });
    const { onToast } = renderNumbers();

    pressSync();

    await waitFor(() => expect(onToast).toHaveBeenCalled());
    expect(String(onToast.mock.calls[0]?.[0])).not.toMatch(/ctm|calltracking|tracking metrics/i);
  });
});

describe('Phone numbers table - names', () => {
  const row = (over: Partial<OwnedNumber>): OwnedNumber => ({
    id: 'num-1',
    number: '(609) 719-1235',
    type: 'Local',
    flowId: '',
    forwardTo: null,
    status: 'active',
    createdAt: '2026-08-06T02:46:37.507Z',
    smsEnabled: true,
    ...over,
  });

  function renderRows(numbers: OwnedNumber[]) {
    renderWithProviders(
      <NumbersView numbers={numbers} setNumbers={vi.fn()} callFlows={[]} onToast={vi.fn()} />,
      { ability: ADMIN },
    );
  }

  it("shows a number's stored name beside its digits", () => {
    renderRows([row({ tag: 'Google Ads' })]);

    expect(screen.getByText('(609) 719-1235')).toBeInTheDocument();
    expect(screen.getByText('Google Ads')).toBeInTheDocument();
  });

  it('falls back to the digits alone for a number with no name', () => {
    renderRows([row({ tag: undefined })]);

    const cell = screen.getByText('(609) 719-1235').closest('td')!;
    expect(cell.textContent).toBe('(609) 719-1235');
  });
});
