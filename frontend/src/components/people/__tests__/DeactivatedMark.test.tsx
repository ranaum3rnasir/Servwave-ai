/**
 * Roles & Permissions alignment, AL-13a (P19): a deactivated person keeps their name on a record and is marked.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DeactivatedMark } from '../DeactivatedMark';
import { LeadPeopleBlock } from '@/components/leads/LeadPeopleBlock';

describe('DeactivatedMark', () => {
  it('draws "Deactivated" for a person whose record says they are inactive', () => {
    render(<DeactivatedMark person={{ is_active: false }} />);
    expect(screen.getByText('Deactivated')).toBeInTheDocument();
  });

  it('draws nothing for an active person, for a record that does not say, and for nobody', () => {
    const { container, rerender } = render(<DeactivatedMark person={{ is_active: true }} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<DeactivatedMark person={{}} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<DeactivatedMark person={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('the lead people block', () => {
  it('keeps the name of a deactivated Owner and Dispatcher and marks each, and marks nobody else', () => {
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <LeadPeopleBlock
          leadId="l1"
          owner={{ id: 'o', first_name: 'Olive', last_name: 'Owner', is_active: false }}
          dispatcher={{ id: 'd', first_name: 'Dan', last_name: 'Dispatch', is_active: true }}
          canAssign={false}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByText('Olive Owner')).toBeInTheDocument();
    expect(screen.getByText('Dan Dispatch')).toBeInTheDocument();
    expect(screen.getAllByText('Deactivated')).toHaveLength(1);
  });
});
