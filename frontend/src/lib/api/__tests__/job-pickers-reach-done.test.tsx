// Roles & Permissions, PRD 6, S06.30 - the Jobs list's default view leaves Done out, so a picker that has to reach
// every job (attach a call or text to a job, link a task to a job) asks for them.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import { useJobSearch } from '@/lib/api/communication';
import { LinkedEntitySelect } from '@/pages/v2/tasks/components/linkedEntitySelect';
import { LinkedEntitySelect as TaskModalLinkedEntitySelect } from '@/components/tasks/LinkedEntitySelect';

const mockApi = vi.mocked(api);

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.clearAllMocks();
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.scrollIntoView ??= () => {};
  mockApi.get.mockResolvedValue({ data: { jobs: [] } });
});

const jobsParams = () => {
  const call = mockApi.get.mock.calls.find(([url]) => url === '/api/jobs');
  return (call?.[1] as { params: Record<string, unknown> } | undefined)?.params;
};

describe('the pickers that must reach every job', () => {
  it('the communication attach search asks for Done jobs too', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;

    renderHook(() => useJobSearch('J00'), { wrapper });

    await waitFor(() => expect(jobsParams()).toBeDefined());
    expect(jobsParams()).toMatchObject({ search: 'J00', include_done: 'true' });
  });

  it('the task link picker asks for Done jobs too', async () => {
    renderWithProviders(<LinkedEntitySelect value={null} onChange={vi.fn()} />);

    fireEvent.click(screen.getByTestId('linked-entity-select-trigger'));

    await waitFor(() => expect(jobsParams()).toBeDefined());
    expect(jobsParams()).toMatchObject({ include_done: 'true' });
  });

  it("the task modal's link picker (the job page's Tasks tab) asks for Done jobs too", async () => {
    renderWithProviders(<TaskModalLinkedEntitySelect value={null} onChange={vi.fn()} />);

    fireEvent.click(screen.getByTestId('linked-entity-select-trigger'));

    await waitFor(() => expect(jobsParams()).toBeDefined());
    expect(jobsParams()).toMatchObject({ include_done: 'true' });
  });
});
