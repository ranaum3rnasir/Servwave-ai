// Ship-readiness follow-up: the Stage/Approval email + preview surfaces still
// carried the pre-rename "FieldOS" brand string and a hardcoded "Brooklyn HQ" /
// br_brooklyn_hq fallback that stood in for real org/branch data (the same
// defect class D6 fixed on POPreviewDialog/PODetailDialog). Fixtures below
// deliberately use a branch that is NOT named/id'd Brooklyn, so a leaked
// hardcoded default would be caught rather than accidentally matching.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from './helpers';
import { EmailComposeDialog } from '@/components/inventory/EmailComposeDialog';
import { ApprovalEmailDialog } from '@/components/inventory/ApprovalEmailDialog';
import { StagePreviewDialog } from '@/components/inventory/StagePreviewDialog';
import type { JobStage, StockApproval } from '@/lib/api/inventory';

const ORG_NAME = 'Downtown Security Co';

const hoisted = vi.hoisted(() => ({
  branches: [
    {
      id: 'br_downtown',
      name: 'Downtown Branch',
      address: '1 Test Plaza, Metro City',
      phone: '5551234567',
      managerName: 'Jordan Lee',
    },
  ],
  techs: [
    { id: 'tech_1', name: 'Alex Rivera', email: 'alex.rivera@downtown.example.com', role: 'field_tech' as const, branch: 'Downtown Branch', vehicle: 'Van 1' },
  ],
  org: { id: 'org-1', name: 'Downtown Security Co' },
  emailSpy: vi.fn(),
}));

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  const stable =
    <T,>(data: T) =>
    () => ({ data, isLoading: false, isError: false });
  return {
    ...actual,
    useBranches: stable(hoisted.branches),
    useTechs: stable(hoisted.techs),
    useInventoryItems: stable([]),
    useLocations: stable([]),
    useVendors: stable([]),
    useEmailStagePickup: () => ({ mutate: hoisted.emailSpy, mutateAsync: hoisted.emailSpy, isPending: false }),
  };
});

vi.mock('@/lib/api/organization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/organization')>();
  return { ...actual, useOrganization: () => ({ data: hoisted.org, isLoading: false, isError: false }) };
});

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const STAGE_FIXTURE: JobStage = {
  id: 'stg_test_1',
  jobNumber: 'J-9001',
  customer: 'Test Customer',
  site: '9 Test St',
  assignedTechId: 'tech_1',
  trade: 'security',
  status: 'ready_for_pickup',
  items: [],
  createdAt: '2026-07-01T00:00:00Z',
};

const APPROVAL_FIXTURE: StockApproval = {
  id: 'apr_test_1',
  requestedAt: '2026-07-01T00:00:00Z',
  requestedByTechId: 'tech_1',
  requestedByTechName: 'Alex Rivera',
  type: 'consume_on_job',
  itemSku: 'SKU-1',
  itemName: 'Test Part',
  uom: 'ea',
  qty: 2,
  fromLocationId: 'loc_1',
  fromLocationName: 'Van 1',
  status: 'pending',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('EmailComposeDialog — real recipient + real send, no fabricated data', () => {
  it('pre-fills the assigned tech\'s REAL directory email — no name-derived fake, no FieldOS/Brooklyn', () => {
    renderWithProviders(
      <EmailComposeDialog open onClose={vi.fn()} stage={STAGE_FIXTURE} onSent={vi.fn()} />,
    );

    expect(screen.queryByText(/fieldos/i)).toBeNull();

    const message = screen.getByLabelText('Message') as HTMLTextAreaElement;
    expect(message.value).not.toContain('Brooklyn HQ');
    expect(message.value).not.toMatch(/fieldos/i);

    // Suggested recipient + To pre-fill use the tech's REAL directory email,
    // not a name-derived @servwave.com fake.
    expect(screen.getByText('alex.rivera@downtown.example.com')).toBeInTheDocument();
    expect(screen.queryByText(/@servwave\.com/)).toBeNull();
  });

  it('sends through the real endpoint (not an optimistic-only toast)', async () => {
    hoisted.emailSpy.mockResolvedValue({ ok: true });
    const onSent = vi.fn();
    renderWithProviders(
      <EmailComposeDialog open onClose={vi.fn()} stage={STAGE_FIXTURE} onSent={onSent} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /send email/i }));

    await waitFor(() => expect(hoisted.emailSpy).toHaveBeenCalledTimes(1));
    expect(hoisted.emailSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        stageId: 'stg_test_1',
        to: ['alex.rivera@downtown.example.com'],
      }),
    );
    await waitFor(() => expect(onSent).toHaveBeenCalled());
  });
});

describe('ApprovalEmailDialog — org brand + real deep link, not FieldOS', () => {
  it('drops the FieldOS signature/fieldos.io mailbox and the fake fieldos.io deep link', () => {
    renderWithProviders(
      <ApprovalEmailDialog open onClose={vi.fn()} approval={APPROVAL_FIXTURE} onSent={vi.fn()} />,
    );

    expect(screen.queryByText(/fieldos/i)).toBeNull();

    const message = screen.getByLabelText('Message') as HTMLTextAreaElement;
    expect(message.value).toContain(ORG_NAME);
    expect(message.value).not.toContain('Brooklyn HQ');
    expect(message.value).not.toMatch(/fieldos/i);
    expect(message.value).toContain(`${window.location.origin}/approvals/${APPROVAL_FIXTURE.id}`);
  });
});

describe('StagePreviewDialog — org brand, not FieldOS', () => {
  it('shows the real org brand + a real resolved branch in the header and footer', () => {
    renderWithProviders(<StagePreviewDialog open onClose={vi.fn()} stage={STAGE_FIXTURE} />);

    expect(screen.queryByText(/fieldos/i)).toBeNull();
    expect(screen.getAllByText(new RegExp(ORG_NAME, 'i')).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(/Downtown Branch/).length).toBeGreaterThanOrEqual(1);
  });
});
