// Inventory P5 §5.4 — StageDetailDialog attachment repoint: picking a file
// POSTs multipart FormData to /api/inventory/job-stages/:id/attachments and
// appends the returned (signed-URL) attachment; oversize files short-circuit
// client-side into photoError without a POST; remove round-trips DELETE for
// server rows; PDF-page commits upload per selected page with pdf-page
// provenance (uploadPdfPages helper — the dialog's real production path).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders, inventoryWriteAbility } from './helpers';
import { StageDetailDialog, uploadPdfPages } from '@/components/inventory/StageDetailDialog';
import type { JobStage, StageAttachment } from '@/lib/api/inventory';

const mockApi = vi.mocked(api);

const STAGE_ID = '11111111-2222-4333-8444-555555555555';
const EXISTING_PHOTO_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const EXISTING_PHOTO: StageAttachment = {
  id: EXISTING_PHOTO_ID,
  kind: 'image',
  dataUrl: 'https://signed.example/existing.jpg',
  mimeType: 'image/jpeg',
  caption: 'existing.jpg',
  uploadedAt: '2026-07-10T00:00:00.000Z',
  uploadedBy: 'Test Admin',
  source: 'upload',
};

function makeStage(overrides: Partial<JobStage> = {}): JobStage {
  return {
    id: STAGE_ID,
    jobNumber: 'J-1900',
    customer: 'Acme Corp',
    site: '1 Main St',
    trade: 'security',
    status: 'partial', // in-progress → dialog opens in always-edit mode
    items: [
      {
        id: 'li-1', itemSku: 'CAM-01', itemName: 'Dome Camera', uom: 'EA',
        qtyOrdered: 2, qtyReceived: 1, vendor: 'Acme', poNumber: 'P00001', serialized: false,
      },
    ],
    photos: [EXISTING_PHOTO],
    createdAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function renderDialog(stage = makeStage()) {
  return renderWithProviders(
    <StageDetailDialog
      open
      onClose={vi.fn()}
      stage={stage}
      locations={[]}
      onSave={vi.fn()}
      onReceiveOne={vi.fn()}
    />,
    // #2043 - the dialog now gates edit mode + writes on `update Inventory`;
    // this suite exercises the writer's path throughout.
    { ability: inventoryWriteAbility() },
  );
}

/** The generic "Upload file" input (3rd hidden file input in the dialog).
 *  Queried on document — the dialog renders through a portal. */
function uploadInput(): HTMLInputElement {
  const inputs = document.querySelectorAll('input[type="file"]');
  return inputs[2] as HTMLInputElement;
}

/** Drive the hidden file input directly — display:none inputs trip
 *  user-event's pointer-events check, fireEvent.change does not. */
function pickFiles(input: HTMLInputElement, files: File[]) {
  fireEvent.change(input, { target: { files } });
}

beforeEach(() => {
  vi.clearAllMocks();
  // useVendors/useTechs (real seam hooks) resolve through the axios mock.
  mockApi.get.mockImplementation(((url: string) => {
    if (url === '/api/inventory/vendors') return Promise.resolve({ data: { vendors: [] } });
    if (url === '/api/inventory/techs') return Promise.resolve({ data: { techs: [] } });
    return Promise.resolve({ data: {} });
  }) as typeof mockApi.get);
  mockApi.post.mockResolvedValue({
    data: {
      attachment: {
        id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
        kind: 'image',
        dataUrl: 'https://signed.example/new-photo.jpg',
        mimeType: 'image/jpeg',
        caption: 'photo.jpg',
        uploadedAt: '2026-07-17T00:00:00.000Z',
        uploadedBy: 'Test Admin',
        source: 'upload',
        sizeBytes: 3,
      } satisfies StageAttachment,
    },
  });
  mockApi.delete.mockResolvedValue({ data: { success: true } });
});

describe('StageDetailDialog — Storage-backed attachments (P5 §5.4)', () => {
  it('picking an image POSTs FormData to the stage-attachments endpoint and appends the returned attachment', async () => {
    renderDialog();
    const file = new File(['abc'], 'photo.jpg', { type: 'image/jpeg' });

    pickFiles(uploadInput(), [file]);

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledTimes(1));
    const [url, body] = mockApi.post.mock.calls[0]!;
    expect(url).toBe(`/api/inventory/job-stages/${STAGE_ID}/attachments`);
    expect(body).toBeInstanceOf(FormData);
    const fd = body as FormData;
    expect((fd.get('file') as File).name).toBe('photo.jpg');
    expect(fd.get('caption')).toBe('photo.jpg');
    expect(fd.get('source')).toBe('upload');

    // The server's signed-URL attachment lands in the grid (instant feedback).
    const img = await screen.findByAltText('photo.jpg');
    expect(img).toHaveAttribute('src', 'https://signed.example/new-photo.jpg');
  });

  it('an oversize image short-circuits client-side into photoError — no POST', async () => {
    renderDialog();
    const big = new File(['x'], 'huge.jpg', { type: 'image/jpeg' });
    Object.defineProperty(big, 'size', { value: 9 * 1024 * 1024 }); // > 8 MB image cap

    pickFiles(uploadInput(), [big]);

    // Copy updated in S5: the refusal now names the real size, the limit and a next step,
    // instead of the system-voice "skipped." that left the user at a dead end.
    expect(
      await screen.findByText(/"huge\.jpg" is 9 MB — over the 8 MB limit, so it wasn't uploaded\./)
    ).toBeInTheDocument();
    expect(mockApi.post).not.toHaveBeenCalled();
  });

  it('a server 400 surfaces in photoError and does not append the file', async () => {
    mockApi.post.mockRejectedValue({
      response: { data: { error: 'File content does not match its declared type' } },
    });
    renderDialog();
    const file = new File(['abc'], 'fake.jpg', { type: 'image/jpeg' });

    pickFiles(uploadInput(), [file]);

    expect(
      await screen.findByText(/"fake\.jpg": File content does not match its declared type/),
    ).toBeInTheDocument();
    expect(screen.queryByAltText('fake.jpg')).toBeNull();
  });

  it('removing a server photo DELETEs the attachment then prunes the grid', async () => {
    renderDialog();
    expect(await screen.findByAltText('existing.jpg')).toBeInTheDocument();

    await userEvent.click(screen.getByLabelText('Remove attachment'));

    await waitFor(() =>
      expect(mockApi.delete).toHaveBeenCalledWith(
        `/api/inventory/job-stages/${STAGE_ID}/attachments/${EXISTING_PHOTO_ID}`,
      ),
    );
    await waitFor(() => expect(screen.queryByAltText('existing.jpg')).toBeNull());
  });

  it('removing a legacy local (non-uuid id) photo prunes without a DELETE', async () => {
    renderDialog(
      makeStage({ photos: [{ ...EXISTING_PHOTO, id: 'att_local_1', caption: 'local.jpg' }] }),
    );
    expect(await screen.findByAltText('local.jpg')).toBeInTheDocument();

    await userEvent.click(screen.getByLabelText('Remove attachment'));

    await waitFor(() => expect(screen.queryByAltText('local.jpg')).toBeNull());
    expect(mockApi.delete).not.toHaveBeenCalled();
  });

  it('uploadPdfPages POSTs one FormData per selected page with pdf-page provenance', async () => {
    const uploadOne = vi.fn().mockResolvedValue({
      attachment: { ...EXISTING_PHOTO, id: 'cccccccc-dddd-4eee-8fff-000000000000' },
    });
    // The helper fetches each page's data-URL to a Blob — pin fetch so the
    // test doesn't depend on the environment's data:-scheme support.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      blob: async () => new Blob(['png-bytes'], { type: 'image/png' }),
    } as unknown as Response);
    const png = 'data:image/png;base64,iVBORw0KGgo=';

    const result = await uploadPdfPages(uploadOne, STAGE_ID, 'packing-slip.pdf', [
      { num: 1, dataUrl: png },
      { num: 3, dataUrl: png },
    ]);
    fetchSpy.mockRestore();

    expect(uploadOne).toHaveBeenCalledTimes(2);
    expect(result.uploaded).toHaveLength(2);
    expect(result.failed).toBe(0);

    const first = uploadOne.mock.calls[0]![0] as { stageId: string; form: FormData };
    expect(first.stageId).toBe(STAGE_ID);
    expect(first.form.get('source')).toBe('pdf-page');
    expect(first.form.get('pdfFileName')).toBe('packing-slip.pdf');
    expect(first.form.get('pdfPageNumber')).toBe('1');
    expect(first.form.get('caption')).toBe('packing-slip.pdf · page 1');
    expect((first.form.get('file') as File).type).toBe('image/png');

    const second = uploadOne.mock.calls[1]![0] as { form: FormData };
    expect(second.form.get('pdfPageNumber')).toBe('3');
  });

  it('uploadPdfPages keeps going after a failed page and reports it', async () => {
    const uploadOne = vi
      .fn()
      .mockRejectedValueOnce({ response: { data: { error: 'boom' } } })
      .mockResolvedValueOnce({ attachment: EXISTING_PHOTO });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      blob: async () => new Blob(['png-bytes'], { type: 'image/png' }),
    } as unknown as Response);
    const png = 'data:image/png;base64,iVBORw0KGgo=';

    const result = await uploadPdfPages(uploadOne, STAGE_ID, 'slip.pdf', [
      { num: 1, dataUrl: png },
      { num: 2, dataUrl: png },
    ]);
    fetchSpy.mockRestore();

    expect(result.failed).toBe(1);
    expect(result.uploaded).toHaveLength(1);
    expect(result.lastError).toBe('boom');
  });
});
