/// <reference types="@testing-library/jest-dom/vitest" />
// The Phone numbers tab and the Call flows tab are separate switches. Someone with the first and not the second is not
// sent the org's call flows (the server refuses them), so the Phone numbers tab has a number's flow id and no flow
// name. It must not claim the number has no flow, offer a picker with nothing in it, or draw "Remove flow" for a flow
// it cannot name. This renders the real NumbersView, as the routed page does, for that shape.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import { NumbersView } from '@/components/communication/phone/NumbersView';
import type { CallFlow, OwnedNumber } from '@/lib/api/communication';

const mockApi = vi.mocked(api);
const EDITOR = buildAbility([{ action: 'manage', subject: 'Communication' }] as never);

const withFlow: OwnedNumber = {
  id: 'n1', number: '(201) 555-0101', type: 'Local', flowId: 'flow:f1', forwardTo: null,
  status: 'active', createdAt: '2026-10-01T12:00:00Z', smsEnabled: true,
} as OwnedNumber;
const withoutFlow: OwnedNumber = { ...withFlow, id: 'n2', number: '(201) 555-0102', flowId: '' };

const mainLine = { id: 'f1', name: 'Main line', status: 'active' } as unknown as CallFlow;

function renderNumbers(o: { flows: CallFlow[]; flowsHidden?: boolean }) {
  return renderWithProviders(
    <NumbersView
      numbers={[withFlow, withoutFlow]}
      setNumbers={vi.fn()}
      callFlows={o.flows}
      flowsHidden={o.flowsHidden}
      onToast={vi.fn()}
    />,
    { ability: EDITOR },
  );
}

describe('Phone numbers tab without the Call flows tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.get.mockResolvedValue({ data: { numbers: [] } });
    mockApi.post.mockResolvedValue({ data: { added: 0, numbers: [] } });
  });

  it('says a number has a flow set instead of calling it Unassigned, with no picker and no Remove flow', () => {
    renderNumbers({ flows: [], flowsHidden: true });

    expect(screen.getByText('Set')).toBeInTheDocument();
    // Only the number that really has no flow is called Unassigned.
    expect(screen.getAllByText('Unassigned')).toHaveLength(1);
    expect(screen.queryByLabelText(/Assign flow for/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove flow' })).toBeNull();
    expect(screen.getByText('No flow')).toBeInTheDocument();
  });

  it('keeps the picker, the flow name and Remove flow for someone who is sent the flows', () => {
    renderNumbers({ flows: [mainLine] });

    expect(screen.getByLabelText('Assign flow for (201) 555-0101')).toHaveTextContent('Main line');
    expect(screen.getAllByRole('button', { name: 'Remove flow' })).toHaveLength(1);
    expect(screen.queryByText('Set')).toBeNull();
  });

  it('offers no flow choice when getting a number', async () => {
    renderNumbers({ flows: [], flowsHidden: true });

    await userEvent.click(screen.getByRole('button', { name: /get a number/i }));
    await screen.findByText(/Choose a number from the list/);
    expect(screen.queryByLabelText('Assign flow for new number')).toBeNull();
  });
});
