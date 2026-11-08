/**
 * #2047 — the shared `AttachmentRowActions` control and its `downloadAttachment`/`downloadFileName`
 * helper. Folds the helper's own unit cases, the menu/gating behaviour and the Rename flow into one
 * suite (R17, to stay inside the run's `diff_files` cap), plus the AC5 UI half (a `source: 'LEAD'`
 * job tile exposes Download and no Rename) via `AttachmentsTabBody` and `JobFilesCard` directly,
 * since editing `job-attachment-delete.test.tsx` (one of the six shipped suites) is out per this
 * run's explicit UNEDITED instruction.
 *
 * Conventions mirror `attachments-panel-lightbox.test.tsx` + `helpers.tsx`'s `ability` option:
 * `@/lib/axios` is globally mocked in `setup.ts`, `renderWithProviders` for the wrapper, and
 * `buildAbility` for the two gating shapes (same pattern `repro-2047.test.tsx` already uses).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import { AttachmentRowActions } from '@/components/attachments/AttachmentRowActions';
import { AttachmentsTabBody } from '@/components/jobs/AttachmentsTabBody';
import { JobFilesCard } from '@/components/jobs/overview/JobFilesCard';
import { downloadAttachment, downloadFileName } from '@/lib/attachments/downloadAttachment';

const mockApi = vi.mocked(api);

const hoisted = vi.hoisted(() => ({ downloadBlob: vi.fn(), toast: vi.fn() }));
vi.mock('@/lib/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/utils')>();
  return { ...actual, downloadBlob: hoisted.downloadBlob };
});
vi.mock('@/components/ui/use-toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/use-toast')>();
  return { ...actual, toast: hoisted.toast };
});

const ATTACHMENT = {
  id: 'att-1',
  file_url: 'https://signed.example/site-photo.jpg?token=secret',
  file_name: 'Site photo.jpg',
  display_name: 'Site photo',
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

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── downloadFileName ──────────────────────────────────────────────────────

describe('downloadFileName', () => {
  it('keeps the display name unchanged when it already ends with the stored extension', () => {
    expect(downloadFileName({ file_name: 'photo.png', display_name: 'photo.png' })).toBe('photo.png');
  });

  it('appends the stored extension when the display name lacks one', () => {
    expect(downloadFileName({ file_name: 'photo.png', display_name: 'Vacation photo' })).toBe(
      'Vacation photo.png',
    );
  });

  it('the real stored extension always wins over one embedded in a renamed display name', () => {
    // R6's own example: a display_name of report.pdf on a stored photo.png saves as report.pdf.png.
    expect(downloadFileName({ file_name: 'photo.png', display_name: 'report.pdf' })).toBe(
      'report.pdf.png',
    );
  });

  it('falls back to the stored file_name when display_name is empty after sanitising', () => {
    expect(downloadFileName({ file_name: 'photo.png', display_name: '   ' })).toBe('photo.png');
  });

  it('falls back to "download" when nothing survives sanitising', () => {
    expect(downloadFileName({ file_name: null, display_name: '' })).toBe('download');
  });

  it('strips a path prefix and never lets unsanitised user text become a bucket-style path', () => {
    // R6: display_name is unsanitised free text — strip any path prefix before it becomes a
    // saved filename.
    expect(downloadFileName({ file_name: 'a.png', display_name: '../../etc/passwd' })).toBe(
      'passwd.png',
    );
  });
});

// ─── downloadAttachment ────────────────────────────────────────────────────

describe('downloadAttachment', () => {
  it('fetches the signed URL, builds a blob and saves it via the shared downloadBlob helper', async () => {
    const blob = new Blob(['x']);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, blob: () => Promise.resolve(blob) }),
    );
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

    await downloadAttachment(ATTACHMENT);

    expect(fetch).toHaveBeenCalledWith(ATTACHMENT.file_url);
    expect(hoisted.downloadBlob).toHaveBeenCalledWith(blob, 'Site photo.jpg');
    expect(openSpy).not.toHaveBeenCalled();
    expect(hoisted.toast).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('retries once with a refreshed URL after a failed first attempt, then succeeds', async () => {
    const blob = new Blob(['x']);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true, blob: () => Promise.resolve(blob) });
    vi.stubGlobal('fetch', fetchMock);
    const refreshedUrl = 'https://signed.example/site-photo.jpg?token=fresh';
    const refresh = vi.fn().mockResolvedValue(refreshedUrl);

    await downloadAttachment(ATTACHMENT, { refresh });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(1, ATTACHMENT.file_url);
    expect(fetchMock).toHaveBeenNthCalledWith(2, refreshedUrl);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(hoisted.downloadBlob).toHaveBeenCalledWith(blob, 'Site photo.jpg');
    expect(hoisted.toast).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('does not retry with the same URL the first attempt already used', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    const refresh = vi.fn().mockResolvedValue(ATTACHMENT.file_url);

    await downloadAttachment(ATTACHMENT, { refresh });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(hoisted.downloadBlob).not.toHaveBeenCalled();
    expect(hoisted.toast).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('toasts a de-branded failure after two failed attempts, at most two attempts ever', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    const refresh = vi.fn().mockResolvedValue('https://signed.example/site-photo.jpg?token=fresh2');

    await downloadAttachment(ATTACHMENT, { refresh });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(hoisted.downloadBlob).not.toHaveBeenCalled();
    expect(hoisted.toast).toHaveBeenCalledWith({
      variant: 'destructive',
      title: 'Download failed',
      description: 'Could not download this file. Please try again.',
    });
    vi.unstubAllGlobals();
  });

  it('treats a rejected fetch (offline/DNS) the same as a non-ok response, and never rethrows', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    await expect(downloadAttachment(ATTACHMENT)).resolves.toBeUndefined();

    expect(hoisted.toast).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('never logs the signed URL, even on failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await downloadAttachment(ATTACHMENT);

    for (const call of [...errorSpy.mock.calls, ...warnSpy.mock.calls]) {
      expect(JSON.stringify(call)).not.toContain('token=secret');
    }
    vi.unstubAllGlobals();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

// ─── AttachmentRowActions — menu, gating, rename ───────────────────────────

describe('AttachmentRowActions', () => {
  async function openMenu(ability?: ReturnType<typeof buildAbility>, renamable?: boolean) {
    const user = userEvent.setup();
    const onRenamed = vi.fn();
    const utils = ability
      ? renderWithProviders(
          <AttachmentRowActions
            attachment={ATTACHMENT}
            entityType="lead"
            entityId="lead-1"
            renamable={renamable}
            onRenamed={onRenamed}
          />,
          { ability },
        )
      : render(
          <AttachmentRowActions
            attachment={ATTACHMENT}
            entityType="lead"
            entityId="lead-1"
            renamable={renamable}
            onRenamed={onRenamed}
          />,
        );
    const trigger = await screen.findByRole('button', { name: 'Actions for Site photo' });
    await user.click(trigger);
    return { user, onRenamed, ...utils };
  }

  it('exposes Download and Rename under update Attachment', async () => {
    await openMenu(fullAttachmentAbility());

    expect(screen.getByRole('menuitem', { name: /download/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /rename/i })).toBeInTheDocument();
  });

  it('exposes Download but not Rename without update Attachment', async () => {
    await openMenu(noUpdateAttachmentAbility());

    expect(screen.getByRole('menuitem', { name: /download/i })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /rename/i })).not.toBeInTheDocument();
  });

  it('exposes Download but not Rename with no ability provider at all', async () => {
    await openMenu();

    expect(screen.getByRole('menuitem', { name: /download/i })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /rename/i })).not.toBeInTheDocument();
  });

  it('renamable={false} hides Rename even with update Attachment', async () => {
    await openMenu(fullAttachmentAbility(), false);

    expect(screen.getByRole('menuitem', { name: /download/i })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /rename/i })).not.toBeInTheDocument();
  });

  it('Download calls the shared helper with the row and never navigates', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, blob: () => Promise.resolve(new Blob(['x'])) }),
    );
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const { user } = await openMenu(fullAttachmentAbility());

    await user.click(screen.getByRole('menuitem', { name: /download/i }));

    await waitFor(() => expect(hoisted.downloadBlob).toHaveBeenCalledWith(expect.any(Blob), 'Site photo.jpg'));
    expect(openSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('renames end to end: PATCHes exactly {display_name}, invalidates via onRenamed, and closes', async () => {
    mockApi.patch.mockResolvedValue({ data: {} });
    const { user, onRenamed } = await openMenu(fullAttachmentAbility());

    await user.click(screen.getByRole('menuitem', { name: /rename/i }));
    const dialog = await screen.findByRole('dialog', { name: 'Rename file' });
    const input = within(dialog).getByRole('textbox');
    expect(input).toHaveValue('Site photo');
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();

    await user.clear(input);
    await user.type(input, 'Site photo renamed');
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeEnabled();

    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockApi.patch).toHaveBeenCalledTimes(1));
    expect(mockApi.patch).toHaveBeenCalledWith('/api/attachments/lead/lead-1/att-1', {
      display_name: 'Site photo renamed',
    });
    expect(onRenamed).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Rename file' })).not.toBeInTheDocument(),
    );
  });

  it('a failing rename keeps the dialog open with the typed value and shows the server error', async () => {
    mockApi.patch.mockRejectedValue({ response: { data: { error: 'Name already in use' } } });
    const { user } = await openMenu(fullAttachmentAbility());

    await user.click(screen.getByRole('menuitem', { name: /rename/i }));
    const dialog = await screen.findByRole('dialog', { name: 'Rename file' });
    const input = within(dialog).getByRole('textbox');
    await user.clear(input);
    await user.type(input, 'New name');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.getByText('Name already in use')).toBeInTheDocument());
    expect(screen.getByRole('dialog', { name: 'Rename file' })).toBeInTheDocument();
    expect(within(dialog).getByRole('textbox')).toHaveValue('New name');
  });

  it('never sends a whitespace-only name — Save stays disabled and the field caps at 255', async () => {
    const { user } = await openMenu(fullAttachmentAbility());

    await user.click(screen.getByRole('menuitem', { name: /rename/i }));
    const dialog = await screen.findByRole('dialog', { name: 'Rename file' });
    const input = within(dialog).getByRole('textbox');
    await user.clear(input);
    await user.type(input, '   ');

    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(input).toHaveAttribute('maxlength', '255');
    expect(mockApi.patch).not.toHaveBeenCalled();
  });
});

// ─── AC5's UI half — From-lead job tiles get no Rename ─────────────────────

describe('job tiles — Rename follows source, not the surface (AC5 UI half)', () => {
  const JOB_OWNED = {
    id: 'att-job-owned',
    file_name: 'permit.pdf',
    file_url: 'https://files.test/permit.pdf',
    file_type: 'application/pdf',
    display_name: 'Job doc',
    source: null,
  };
  const FROM_LEAD = {
    id: 'att-from-lead',
    file_name: 'contract.pdf',
    file_url: 'https://files.test/contract.pdf',
    file_type: 'application/pdf',
    display_name: 'Lead doc',
    source: 'LEAD',
  };

  it('AttachmentsTabBody: a job-owned tile offers Rename, a From-lead tile does not', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <AttachmentsTabBody jobId="job-1" attachments={[JOB_OWNED, FROM_LEAD]} />,
      { ability: fullAttachmentAbility() },
    );

    await user.click(await screen.findByRole('button', { name: 'Actions for Job doc' }));
    expect(screen.getByRole('menuitem', { name: /download/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /rename/i })).toBeInTheDocument();
    await user.keyboard('{Escape}');

    await user.click(await screen.findByRole('button', { name: 'Actions for Lead doc' }));
    expect(screen.getByRole('menuitem', { name: /download/i })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /rename/i })).not.toBeInTheDocument();
  });

  it('JobFilesCard: same rule on the Overview tab surface (R1)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<JobFilesCard jobId="job-1" attachments={[JOB_OWNED, FROM_LEAD]} />, {
      ability: fullAttachmentAbility(),
    });

    await user.click(await screen.findByRole('button', { name: 'Actions for Job doc' }));
    expect(screen.getByRole('menuitem', { name: /rename/i })).toBeInTheDocument();
    await user.keyboard('{Escape}');

    await user.click(await screen.findByRole('button', { name: 'Actions for Lead doc' }));
    expect(screen.queryByRole('menuitem', { name: /rename/i })).not.toBeInTheDocument();
  });
});
