/**
 * Roles & Permissions S04.24 - the delete and rename controls on a file follow the server's per-file answer
 * (`can_delete`, `can_rename`, `locked_actions`), on every surface that lists files:
 *
 *   - the job's Overview card and Attachments tab (JobFilesCard, AttachmentsTabBody - what the routed job page renders),
 *   - the invoice page's side-rail panel (AttachmentsPanel, mounted by IconRail),
 *   - the lead page's list (AttachmentSection, which also lists a task's files).
 *
 * A control shows only on a file the person may change. On a locked job it shows disabled with the lock's reason; the
 * invoice panel shows no delete at all while the job is locked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import { AttachmentsTabBody } from '@/components/jobs/AttachmentsTabBody';
import { JobFilesCard } from '@/components/jobs/overview/JobFilesCard';
import { AttachmentsPanel } from '@/components/crm/AttachmentsPanel';
import { AttachmentSection } from '@/components/crm/AttachmentSection';

const mockApi = vi.mocked(api);

const LOCK_REASON = 'This job is locked. Only someone who can change locked jobs can change it.';

const base = {
  file_type: 'application/pdf',
  file_size: 2048,
  description: '',
  created_at: '2026-07-10T00:00:00.000Z',
  uploader: { id: 'u-1', first_name: 'Test', last_name: 'Admin' },
};
const file = (id: string, name: string, answer: Record<string, unknown>) => ({
  ...base, id, file_name: `${id}.pdf`, file_url: `https://files.test/${id}.pdf`, display_name: name, ...answer,
});

/** Mine: deletable, not renamable. Theirs: neither. Held: both. Locked: the lock alone stops both. */
const MINE = file('a-mine', 'My photo', { can_delete: true, can_rename: false, locked_actions: [] });
const THEIRS = file('a-theirs', 'Their photo', { can_delete: false, can_rename: false, locked_actions: [] });
const HELD = file('a-held', 'Held photo', { can_delete: true, can_rename: true, locked_actions: [] });
const LOCKED = file('a-locked', 'Locked photo', { can_delete: false, can_rename: false, locked_actions: ['delete', 'rename'] });

beforeEach(() => {
  vi.clearAllMocks();
});

const openMenu = async (name: string) => {
  await userEvent.click(await screen.findByRole('button', { name: `Actions for ${name}` }));
  return screen.findByRole('menu');
};

describe.each([
  ['the job\'s Attachments tab', (rows: unknown[], lockedReason?: string) => <AttachmentsTabBody jobId="job-1" attachments={rows as never} lockedReason={lockedReason} />],
  ['the job\'s Overview files card', (rows: unknown[], lockedReason?: string) => <JobFilesCard jobId="job-1" attachments={rows as never} lockedReason={lockedReason} />],
])('%s', (_name, render) => {
  it('draws Delete on a file the person may delete and on no other', () => {
    renderWithProviders(render([MINE, THEIRS]));
    expect(screen.getByRole('button', { name: 'Delete My photo' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Delete Their photo' })).not.toBeInTheDocument();
  });

  it('leaves Delete out of the row menu of a file the person may not delete, and Rename out of one they may not rename', async () => {
    renderWithProviders(render([THEIRS, MINE]), { ability: buildAbility([{ action: 'update', subject: 'Attachment' }]) });
    const theirs = await openMenu('Their photo');
    // The server's answer wins over the browser's own grant: this person's CASL rules include update, the file says no.
    expect(within(theirs).queryByRole('menuitem', { name: /rename/i })).not.toBeInTheDocument();
    expect(within(theirs).queryByRole('menuitem', { name: /delete/i })).not.toBeInTheDocument();
  });

  it('offers Rename and Delete in the menu of a file the person may change', async () => {
    renderWithProviders(render([HELD]));
    const menu = await openMenu('Held photo');
    expect(within(menu).getByRole('menuitem', { name: /rename/i })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: /delete/i })).toBeEnabled();
  });

  it('draws Delete disabled with the lock\'s reason when the lock alone stops the person, in the button and in the menu', async () => {
    renderWithProviders(render([LOCKED], LOCK_REASON));
    const trash = screen.getByRole('button', { name: 'Delete Locked photo' });
    expect(trash).toBeDisabled();
    expect(trash).toHaveAttribute('title', LOCK_REASON);

    const menu = await openMenu('Locked photo');
    expect(within(menu).getByRole('menuitem', { name: /delete/i })).toHaveAttribute('aria-disabled', 'true');
    expect(within(menu).getByRole('menuitem', { name: /rename/i })).toHaveAttribute('aria-disabled', 'true');
    expect(within(menu).getByText(LOCK_REASON)).toBeInTheDocument();
  });

  it('offers no delete on a file forwarded from the lead, locked or not', () => {
    const fromLead = file('a-lead', 'Lead photo', { source: 'LEAD', can_delete: false, can_rename: false, locked_actions: [] });
    renderWithProviders(render([fromLead], LOCK_REASON));
    expect(screen.getByText('Lead photo')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete Lead photo' })).not.toBeInTheDocument();
  });
});

describe('the invoice page\'s file panel', () => {
  const list = (rows: unknown[]) => mockApi.get.mockResolvedValue({ data: { attachments: rows } });

  it('draws Delete on a file the person may delete and on no other', async () => {
    list([MINE, THEIRS]);
    renderWithProviders(<AttachmentsPanel entityType="INVOICE" entityId="inv-1" />);
    await screen.findByText('My photo');
    expect(screen.getAllByRole('button', { name: 'Delete attachment' })).toHaveLength(1);
  });

  it('shows no delete at all on the files of a locked job\'s invoice', async () => {
    list([LOCKED]);
    renderWithProviders(<AttachmentsPanel entityType="INVOICE" entityId="inv-1" />);
    await screen.findByText('Locked photo');
    expect(screen.queryByRole('button', { name: 'Delete attachment' })).not.toBeInTheDocument();
    const menu = await openMenu('Locked photo');
    expect(within(menu).queryByRole('menuitem', { name: /delete/i })).not.toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: /rename/i })).not.toBeInTheDocument();
  });
});

describe('the lead page\'s file list', () => {
  const list = (rows: unknown[]) => mockApi.get.mockResolvedValue({ data: { attachments: rows } });

  it('draws Delete from the server\'s answer, not the browser\'s grant', async () => {
    list([MINE, THEIRS]);
    renderWithProviders(
      <AttachmentSection entityType="LEAD" entityId="lead-1" />,
      { ability: buildAbility([{ action: 'delete', subject: 'Attachment' }, { action: 'read', subject: 'Attachment' }]) },
    );
    await screen.findByText('My photo');
    expect(screen.getAllByRole('button', { name: 'Delete attachment' })).toHaveLength(1);
  });
});
