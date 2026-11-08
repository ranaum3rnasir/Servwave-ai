// The Numbers table's "Rings at" column and its Release action.
//
// "Rings at" is where a purchased number's calls actually land, and the only
// place an owner can change it.
//
// Two things are worth pinning here beyond the happy path. First, the column
// exists at all: before this, the table showed number/type/ad group/flow/status
// and nothing about routing, so an owner could not even SEE where a number
// rang, let alone move it. Second, the failure copy: the server fails the
// request rather than claiming a reroute it did not achieve, and the toast has
// to carry that through - the dangerous outcome is the owner believing calls
// moved to a new phone while they keep ringing the old one.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import { NumbersView } from '../NumbersView';
import type { OwnedNumber } from '@/lib/api/communication';

const mockApi = vi.mocked(api);
const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);

const NUMBER: OwnedNumber = {
  id: 'num-1',
  number: '(609) 719-1235',
  type: 'Local',
  flowId: '',
  forwardTo: '+15555550199',
  status: 'active',
  createdAt: '2026-08-06T02:46:37.507Z',
  smsEnabled: true,
};

function renderNumbers(over: Partial<OwnedNumber> = {}) {
  const onToast = vi.fn();
  renderWithProviders(
    <NumbersView
      numbers={[{ ...NUMBER, ...over }]}
      setNumbers={vi.fn()}
      callFlows={[]}
      onToast={onToast}
    />,
    { ability: ADMIN },
  );
  return { onToast };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockResolvedValue({ data: {} });
});

describe('Numbers table - forwarding destination', () => {
  it('shows where a number rings', () => {
    renderNumbers();

    expect(screen.getByText('Rings at')).toBeInTheDocument();
    expect(screen.getByText('(555) 555-0199')).toBeInTheDocument();
  });

  it('flags a number that has no destination rather than rendering a blank cell', () => {
    renderNumbers({ forwardTo: null });

    expect(screen.getByText('Not routed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /set destination/i })).toBeInTheDocument();
  });

  it('saves a new destination as strict E.164, however the owner typed it', async () => {
    mockApi.patch.mockResolvedValue({ data: { number: { forward_to: '+16097775555' } } });
    const { onToast } = renderNumbers();

    fireEvent.click(screen.getByRole('button', { name: /change/i }));
    fireEvent.change(screen.getByRole('textbox', { name: /forward .* to/i }), {
      target: { value: '(609) 777-5555' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() =>
      expect(mockApi.patch).toHaveBeenCalledWith('/api/communication/numbers/num-1', {
        forward_to_e164: '+16097775555',
      }),
    );
    await waitFor(() =>
      expect(onToast).toHaveBeenCalledWith('(609) 719-1235 now rings (609) 777-5555'),
    );
  });

  it('will not submit a number that cannot be dialed', () => {
    renderNumbers();

    fireEvent.click(screen.getByRole('button', { name: /change/i }));
    fireEvent.change(screen.getByRole('textbox', { name: /forward .* to/i }), {
      target: { value: '12345' },
    });

    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(mockApi.patch).not.toHaveBeenCalled();
  });

  it('on failure says the number still rings its OLD destination', async () => {
    mockApi.patch.mockRejectedValue({
      response: {
        data: {
          error:
            'The phone system rejected the change - this number still rings its old destination',
        },
      },
    });
    const { onToast } = renderNumbers();

    fireEvent.click(screen.getByRole('button', { name: /change/i }));
    fireEvent.change(screen.getByRole('textbox', { name: /forward .* to/i }), {
      target: { value: '(609) 777-5555' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() =>
      expect(onToast).toHaveBeenCalledWith(expect.stringMatching(/still rings its old destination/i)),
    );
  });

  it('a non-admin sees the destination but gets no way to change it', () => {
    renderWithProviders(
      <NumbersView numbers={[NUMBER]} setNumbers={vi.fn()} callFlows={[]} onToast={vi.fn()} />,
      { ability: buildAbility([{ action: 'read', subject: 'Communication' }]) },
    );

    expect(screen.getByText('(555) 555-0199')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /change/i })).toBeNull();
  });

  it('a released number offers no way to change where it rings', () => {
    renderNumbers({ status: 'released' });

    expect(screen.getByText('Released')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^release$/i })).toBeNull();
  });
});

describe('Numbers table - releasing a number', () => {
  it('never releases straight off the row button', async () => {
    // Releasing is irreversible at the provider: the number goes back to the
    // carrier pool and someone else may take it.
    renderNumbers();

    fireEvent.click(screen.getByRole('button', { name: /^release$/i }));

    expect(await screen.findByText(/cannot be recovered/i)).toBeInTheDocument();
    expect(mockApi.delete).not.toHaveBeenCalled();
  });

  it('will not release until the number itself is typed back', async () => {
    // A confirm dialog alone is one muscle-memory click from permanently
    // losing a working business line. Northwind Services has 20 live numbers here.
    renderNumbers();

    fireEvent.click(screen.getByRole('button', { name: /^release$/i }));

    const confirm = await screen.findByRole('button', { name: /release number/i });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(mockApi.delete).not.toHaveBeenCalled();
  });

  it('stays disabled for a near-miss', async () => {
    renderNumbers();

    fireEvent.click(screen.getByRole('button', { name: /^release$/i }));
    fireEvent.change(await screen.findByLabelText(/type .* to confirm/i), {
      target: { value: '(609) 719-1234' },
    });

    expect(screen.getByRole('button', { name: /release number/i })).toBeDisabled();
  });

  it('releases once the number is typed', async () => {
    mockApi.delete.mockResolvedValue({ data: { number: { status: 'released' } } });
    const { onToast } = renderNumbers();

    fireEvent.click(screen.getByRole('button', { name: /^release$/i }));
    fireEvent.change(await screen.findByLabelText(/type .* to confirm/i), {
      target: { value: '(609) 719-1235' },
    });
    fireEvent.click(screen.getByRole('button', { name: /release number/i }));

    await waitFor(() =>
      expect(mockApi.delete).toHaveBeenCalledWith('/api/communication/numbers/num-1'),
    );
    await waitFor(() =>
      expect(onToast).toHaveBeenCalledWith(expect.stringMatching(/will not be billed again/i)),
    );
  });

  it('accepts the digits without the formatting', async () => {
    // The label is punctuated; making the owner reproduce the punctuation
    // would be a puzzle, not a safeguard.
    mockApi.delete.mockResolvedValue({ data: { number: { status: 'released' } } });
    renderNumbers();

    fireEvent.click(screen.getByRole('button', { name: /^release$/i }));
    fireEvent.change(await screen.findByLabelText(/type .* to confirm/i), {
      target: { value: '6097191235' },
    });
    fireEvent.click(screen.getByRole('button', { name: /release number/i }));

    await waitFor(() => expect(mockApi.delete).toHaveBeenCalled());
  });

  it('forgets what was typed when the dialog is dismissed', async () => {
    // Otherwise a confirmation typed once would arm the next release.
    renderNumbers();

    fireEvent.click(screen.getByRole('button', { name: /^release$/i }));
    fireEvent.change(await screen.findByLabelText(/type .* to confirm/i), {
      target: { value: '(609) 719-1235' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^release$/i }));

    expect(await screen.findByLabelText(/type .* to confirm/i)).toHaveValue('');
    expect(screen.getByRole('button', { name: /release number/i })).toBeDisabled();
  });

  it('says the number is STILL ACTIVE when the release fails', async () => {
    // The costly misreading is "I released it, so I have stopped paying".
    mockApi.delete.mockRejectedValue({
      response: {
        data: {
          error: 'The phone system could not release this number - it is still active',
        },
      },
    });
    const { onToast } = renderNumbers();

    fireEvent.click(screen.getByRole('button', { name: /^release$/i }));
    fireEvent.change(await screen.findByLabelText(/type .* to confirm/i), {
      target: { value: '(609) 719-1235' },
    });
    fireEvent.click(screen.getByRole('button', { name: /release number/i }));

    await waitFor(() =>
      expect(onToast).toHaveBeenCalledWith(expect.stringMatching(/still active/i)),
    );
  });

  it('a non-admin gets no release action at all', () => {
    renderWithProviders(
      <NumbersView numbers={[NUMBER]} setNumbers={vi.fn()} callFlows={[]} onToast={vi.fn()} />,
      { ability: buildAbility([{ action: 'read', subject: 'Communication' }]) },
    );

    expect(screen.queryByRole('button', { name: /^release$/i })).toBeNull();
  });
});
