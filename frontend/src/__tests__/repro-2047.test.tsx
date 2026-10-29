/**
 * repro-2047 — frozen reproduction for #2047.
 *
 * Ground truth verified in the worktree before writing this file:
 *  - `AttachmentsPanel` (frontend/src/components/crm/AttachmentsPanel.tsx:278-286) renders only a
 *    "Delete attachment" row button. No Download/Rename control exists.
 *  - `AttachmentSection` (frontend/src/components/crm/AttachmentSection.tsx:358-370) — same: only
 *    a "Delete attachment" tile-overlay button.
 *  - `AttachmentsTabBody` (frontend/src/components/jobs/AttachmentsTabBody.tsx:101-113) — same:
 *    only a "Delete <name>" button per tile.
 *  - None of the three imports `useAppAbility`/checks the CASL ability at all (grep confirmed),
 *    so today there is no permission gate on anything attachment-related in the frontend.
 *  - The backend already has `PATCH /api/attachments/:entityType/:entityId/:attachmentId`
 *    (backend/src/routes/attachment.routes.ts:32), gated `canDo('update', 'Attachment')`, wired to
 *    a real controller (`updateAttachment`, backend/src/controllers/attachment.controller.ts:452).
 *    No frontend file calls `api.patch` against `/api/attachments/...` anywhere (grep across
 *    frontend/src confirmed zero matches) — the route is unreachable from the UI. Because the
 *    backend endpoint already exists and already works, this repro needs no backend test: the gap
 *    is entirely "no UI ever calls it", which these three frontend suites capture directly.
 *
 * Desired end state (from the issue): each row gets a shared actions control exposing Download
 * (always available) and Rename (only under `update Attachment`), alongside the existing Delete.
 * These tests assert that behaviourally, by accessible role/name, not by any class name — a
 * per-row trigger whose accessible name mentions "actions" (the convention already used for this
 * exact shape elsewhere in the app, e.g. `frontend/src/components/workflows/StepNode.tsx:175`'s
 * `aria-label={`Step ${index + 1} actions`}` opening a DropdownMenu of `menuitem`s), which reveals
 * "Download" and "Rename" items.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import { AttachmentsPanel } from '@/components/crm/AttachmentsPanel';
import { AttachmentSection } from '@/components/crm/AttachmentSection';
import { AttachmentsTabBody } from '@/components/jobs/AttachmentsTabBody';

// @/lib/axios is globally mocked in src/__tests__/setup.ts
const mockApi = vi.mocked(api);

const IMAGE_ATTACHMENT = {
  id: 'att-image-1',
  file_name: 'site-photo.jpg',
  file_url: 'https://signed.example/site-photo.jpg',
  file_type: 'image/jpeg',
  file_size: 2048,
  display_name: 'Site photo',
  description: '',
  created_at: '2026-07-10T00:00:00.000Z',
  uploader: { id: 'u-1', first_name: 'Test', last_name: 'Admin' },
};

const TAB_ATTACHMENT = {
  id: 'att-tab-1',
  file_name: 'panel.png',
  file_url: 'https://files.test/panel.png',
  file_type: 'image/png',
  display_name: 'Panel',
  description: null,
  source: null,
};

const fullAttachmentAbility = () =>
  buildAbility([
    { action: 'read', subject: 'Attachment' },
    { action: 'update', subject: 'Attachment' },
    { action: 'delete', subject: 'Attachment' },
  ]);

const noUpdateAttachmentAbility = () =>
  buildAbility([
    { action: 'read', subject: 'Attachment' },
    { action: 'delete', subject: 'Attachment' },
  ]);

/** Opens the row's actions control and returns once it is open. Fails (correctly) on base,
 * where no such control exists at all. */
async function openRowActions(user: ReturnType<typeof userEvent.setup>) {
  const trigger = await screen.findByRole('button', { name: /actions/i });
  await user.click(trigger);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('repro-2047 — AttachmentsPanel row actions', () => {
  it('exposes Download and Rename for a user with update Attachment', async () => {
    mockApi.get.mockResolvedValue({ data: { attachments: [IMAGE_ATTACHMENT] } });
    const user = userEvent.setup();
    renderWithProviders(<AttachmentsPanel entityType="INVOICE" entityId="inv-1" />, {
      ability: fullAttachmentAbility(),
    });

    await screen.findByText(IMAGE_ATTACHMENT.display_name);
    await openRowActions(user);

    expect(await screen.findByRole('menuitem', { name: /download/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /rename/i })).toBeInTheDocument();
  });

  it('a user without update Attachment gets Download but no Rename', async () => {
    mockApi.get.mockResolvedValue({ data: { attachments: [IMAGE_ATTACHMENT] } });
    const user = userEvent.setup();
    renderWithProviders(<AttachmentsPanel entityType="INVOICE" entityId="inv-1" />, {
      ability: noUpdateAttachmentAbility(),
    });

    await screen.findByText(IMAGE_ATTACHMENT.display_name);
    await openRowActions(user);

    expect(await screen.findByRole('menuitem', { name: /download/i })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /rename/i })).not.toBeInTheDocument();
  });
});

describe('repro-2047 — AttachmentSection row actions', () => {
  it('exposes Download and Rename for a user with update Attachment', async () => {
    mockApi.get.mockResolvedValue({ data: { attachments: [IMAGE_ATTACHMENT] } });
    const user = userEvent.setup();
    renderWithProviders(<AttachmentSection entityType="LEAD" entityId="lead-1" />, {
      ability: fullAttachmentAbility(),
    });

    await screen.findByText(IMAGE_ATTACHMENT.display_name);
    await openRowActions(user);

    expect(await screen.findByRole('menuitem', { name: /download/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /rename/i })).toBeInTheDocument();
  });
});

describe('repro-2047 — AttachmentsTabBody row actions', () => {
  it('exposes Download and Rename for a user with update Attachment', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <AttachmentsTabBody jobId="job-1" attachments={[TAB_ATTACHMENT]} />,
      { ability: fullAttachmentAbility() }
    );

    await screen.findByText(TAB_ATTACHMENT.display_name);
    await openRowActions(user);

    expect(await screen.findByRole('menuitem', { name: /download/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /rename/i })).toBeInTheDocument();
  });
});
