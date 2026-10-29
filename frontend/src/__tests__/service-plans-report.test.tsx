import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from './helpers';
import ServicePlansReport from '@/pages/reports/ServicePlansReport';
import { useServicePlans, type ServicePlan } from '@/lib/api/service-plans';

// The report must read the real API hook, not the mock Zustand store (#156).
vi.mock('@/lib/api/service-plans', () => ({
  useServicePlans: vi.fn(),
}));

const mockUseServicePlans = vi.mocked(useServicePlans);

type HookResult = ReturnType<typeof useServicePlans>;

function hookResult(data: ServicePlan[] | undefined, isLoading: boolean): HookResult {
  return { data, isLoading } as unknown as HookResult;
}

/** Minimal real-shaped plan — only the fields the KPI derivation reads. */
function makePlan(overrides: Partial<ServicePlan>): ServicePlan {
  return {
    id: crypto.randomUUID(),
    status: 'ACTIVE',
    effective_status: 'ACTIVE',
    contract_price: '0',
    due_soon: false,
    ...overrides,
  } as unknown as ServicePlan;
}

// 2 active ($1,200 + $800), 1 draft, 4 expired, 3 due-soon → every tile value unique.
const FIXTURE: ServicePlan[] = [
  makePlan({ effective_status: 'ACTIVE', contract_price: '1200', due_soon: true }),
  makePlan({ effective_status: 'ACTIVE', contract_price: 800 }),
  makePlan({ status: 'DRAFT', effective_status: 'DRAFT', due_soon: true }),
  makePlan({ effective_status: 'EXPIRED', due_soon: true }),
  makePlan({ effective_status: 'EXPIRED' }),
  makePlan({ effective_status: 'EXPIRED' }),
  makePlan({ effective_status: 'EXPIRED' }),
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ServicePlansReport — live /api/service-plans KPIs (#156)', () => {
  it('derives KPI tile values from the real hook data', () => {
    mockUseServicePlans.mockReturnValue(hookResult(FIXTURE, false));
    renderWithProviders(<ServicePlansReport />);

    expect(screen.getByText('Active plans')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument(); // active
    expect(screen.getByText('Drafts')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument(); // drafts
    expect(screen.getByText('Due soon')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument(); // due soon
    expect(screen.getByText('Expired')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument(); // expired
    expect(screen.getByText('Contract revenue (active)')).toBeInTheDocument();
    expect(screen.getByText('$2,000')).toBeInTheDocument(); // 1200 + 800, ACTIVE only
  });

  it('renders skeleton tiles (no values) while loading', () => {
    mockUseServicePlans.mockReturnValue(hookResult(undefined, true));
    const { container } = renderWithProviders(<ServicePlansReport />);

    // Labels render, values are replaced by 5 pulse skeletons.
    expect(screen.getByText('Active plans')).toBeInTheDocument();
    expect(container.querySelectorAll('.animate-pulse')).toHaveLength(5);
    expect(screen.queryByText('$0')).toBeNull();
    expect(screen.queryByText('0')).toBeNull();
  });

  it('renders zeros on an empty org without crashing', () => {
    mockUseServicePlans.mockReturnValue(hookResult([], false));
    renderWithProviders(<ServicePlansReport />);

    expect(screen.getAllByText('0')).toHaveLength(4);
    expect(screen.getByText('$0')).toBeInTheDocument();
  });
});
