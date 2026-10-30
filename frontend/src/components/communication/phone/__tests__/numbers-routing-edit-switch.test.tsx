/// <reference types="@testing-library/jest-dom/vitest" />
// Roles & Permissions, PRD 8, slice S08.15 - the Phone numbers tab shows a number's call flow to everyone who sees the tab,
// and lets only a holder of Edit communication records change it (the server refuses the change otherwise).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import { abilityWithSwitches } from '@/__tests__/support/backendSwitchCatalog';
import { NumbersView } from '../NumbersView';
import type { OwnedNumber } from '@/lib/api/communication';
import type { CallFlow } from '@/lib/api/communication';

const mockApi = vi.mocked(api);

const NUMBER: OwnedNumber = {
  id: 'num-1', number: '(609) 719-1235', type: 'Local', flowId: 'flow:flow-1', forwardTo: '+16098745252',
  status: 'active', createdAt: '2026-08-06T02:46:37.507Z', smsEnabled: true,
};
const FLOW = { id: 'flow-1', name: 'After-hours flow', status: 'active' } as unknown as CallFlow;

const SECTION = ['Access Communication', 'View communication', 'Phone numbers tab'];

function renderNumbers(labels: string[]) {
  renderWithProviders(
    <NumbersView numbers={[NUMBER]} setNumbers={vi.fn()} callFlows={[FLOW]} onToast={vi.fn()} />,
    { ability: abilityWithSwitches(...labels) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockResolvedValue({ data: {} });
});

describe('Phone numbers tab: the call flow of a number', () => {
  it('offers the flow picker and Remove flow with Edit communication records on', () => {
    renderNumbers([...SECTION, 'Edit communication records']);
    expect(screen.getByRole('button', { name: /Assign flow for/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove flow' })).toBeInTheDocument();
  });

  it('shows the flow by name but offers no way to change it with Edit communication records off', () => {
    renderNumbers(SECTION);
    expect(screen.getByText('After-hours flow')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Assign flow for/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove flow' })).toBeNull();
  });
});
