/**
 * S5 on the FIFTH video surface: the staging dialog's "Record video" control.
 *
 * `StageDetailDialog` accepts `video/*` with `capture="environment"`, so it is a phone camera
 * pointed straight at an upload — exactly the case the PRD is about. It was missed on the
 * first pass because the other four surfaces are found by `ACCEPTED_UPLOAD_TYPES` and this
 * one is not: it posts to the inventory stage-attachment route with its own 100MB video cap.
 *
 * It already refused oversize picks with a visible message, and already probed duration to
 * ship as metadata. What it never did was SHOW any of it: size, clip length, nudge and
 * progress were all absent behind a boolean spinner.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent, within, act } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders, inventoryWriteAbility } from './helpers';
import { StageDetailDialog } from '@/components/inventory/StageDetailDialog';
import type { JobStage } from '@/lib/api/inventory';
import { LONG_CLIP_NUDGE, LARGE_FILE_NUDGE } from '@/lib/attachments/uploadGuidance';

let probedDuration: number | null = null;
let probeRejects = false;

vi.mock('@/lib/attachments/uploadGuidance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/attachments/uploadGuidance')>();
  return {
    ...actual,
    probeVideoDuration: vi.fn(async (file: File) => {
      if (probeRejects) throw new Error('probe blew up');
      return file.type.startsWith('video/') ? probedDuration : null;
    }),
  };
});

const mockApi = vi.mocked(api);
const MB = 1024 * 1024;
const STAGE_ID = '11111111-2222-4333-8444-555555555555';

function makeStage(): JobStage {
  return {
    id: STAGE_ID,
    jobNumber: 'J-1900',
    customer: 'Acme Corp',
    site: '1 Main St',
    trade: 'security',
    status: 'partial',
    items: [
      {
        id: 'li-1', itemSku: 'CAM-01', itemName: 'Dome Camera', uom: 'EA',
        qtyOrdered: 2, qtyReceived: 1, vendor: 'Acme', poNumber: 'P00001', serialized: false,
      },
    ],
    photos: [],
    createdAt: '2026-07-01T00:00:00.000Z',
  };
}

function renderDialog() {
  return renderWithProviders(
    <StageDetailDialog
      open
      onClose={vi.fn()}
      stage={makeStage()}
      locations={[]}
      onSave={vi.fn()}
      onReceiveOne={vi.fn()}
    />,
    { ability: inventoryWriteAbility() }
  );
}

/** The "Record video" input — the one that declares `accept="video/*"`. */
function videoInput(): HTMLInputElement {
  const inputs = Array.from(
    document.querySelectorAll<HTMLInputElement>('input[type="file"]')
  );
  const found = inputs.find((i) => (i.getAttribute('accept') ?? '').includes('video/*'));
  if (!found) throw new Error('no video capture input found on StageDetailDialog');
  return found;
}

function videoFile(megabytes: number, name = 'walkthrough.mp4'): File {
  const f = new File(['x'], name, { type: 'video/mp4' });
  Object.defineProperty(f, 'size', { value: Math.round(megabytes * MB) });
  return f;
}

interface PostCall {
  domAtCall: string;
  onUploadProgress?: (e: { loaded: number; total?: number }) => void;
}

function captureHangingPost(): PostCall[] {
  const calls: PostCall[] = [];
  mockApi.post.mockImplementation(((
    _url: string,
    _body: unknown,
    config?: Record<string, unknown>
  ) => {
    calls.push({
      domAtCall: document.body.textContent ?? '',
      onUploadProgress: config?.onUploadProgress as PostCall['onUploadProgress'],
    });
    return new Promise(() => {});
  }) as unknown as typeof api.post);
  return calls;
}

beforeEach(() => {
  vi.clearAllMocks();
  probedDuration = null;
  probeRejects = false;
  mockApi.get.mockImplementation(((url: string) => {
    if (url === '/api/inventory/vendors') return Promise.resolve({ data: { vendors: [] } });
    if (url === '/api/inventory/techs') return Promise.resolve({ data: { techs: [] } });
    return Promise.resolve({ data: {} });
  }) as typeof mockApi.get);
});

describe('StageDetailDialog — video upload guidance', () => {
  it('shows the size before the upload starts', async () => {
    const calls = captureHangingPost();
    renderDialog();

    fireEvent.change(videoInput(), { target: { files: [videoFile(40)] } });

    expect(await screen.findByText(/40\.0 MB/)).toBeInTheDocument();
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]!.domAtCall).toContain('40.0 MB');
  });

  it('shows the clip length beside the size when the browser reports one', async () => {
    probedDuration = 125;
    captureHangingPost();
    renderDialog();

    fireEvent.change(videoInput(), { target: { files: [videoFile(40)] } });

    expect(await screen.findByText(/40\.0 MB · 2:05/)).toBeInTheDocument();
  });

  it('renders no garbage when the browser cannot measure the clip', async () => {
    probedDuration = null;
    captureHangingPost();
    renderDialog();

    fireEvent.change(videoInput(), { target: { files: [videoFile(40)] } });

    expect(await screen.findByText(/40\.0 MB/)).toBeInTheDocument();
    expect(screen.queryByText(/Infinity|NaN/)).not.toBeInTheDocument();
  });

  it('nudges on a long clip and uploads it anyway', async () => {
    probedDuration = 600;
    const calls = captureHangingPost();
    renderDialog();

    fireEvent.change(videoInput(), { target: { files: [videoFile(10)] } });

    expect(await screen.findByText(LONG_CLIP_NUDGE)).toBeInTheDocument();
    await waitFor(() => expect(calls.length).toBe(1));
  });

  it('nudges on a large file and uploads it anyway', async () => {
    const calls = captureHangingPost();
    renderDialog();

    fireEvent.change(videoInput(), { target: { files: [videoFile(60)] } });

    expect(await screen.findByText(LARGE_FILE_NUDGE)).toBeInTheDocument();
    await waitFor(() => expect(calls.length).toBe(1));
  });

  it('stays quiet about a short, ordinary clip', async () => {
    probedDuration = 20;
    captureHangingPost();
    renderDialog();

    fireEvent.change(videoInput(), { target: { files: [videoFile(5)] } });

    expect(await screen.findByText(/5\.0 MB/)).toBeInTheDocument();
    expect(screen.queryByText(LONG_CLIP_NUDGE)).not.toBeInTheDocument();
    expect(screen.queryByText(LARGE_FILE_NUDGE)).not.toBeInTheDocument();
  });

  it('shows real byte progress fed by the transport', async () => {
    const calls = captureHangingPost();
    renderDialog();

    fireEvent.change(videoInput(), { target: { files: [videoFile(40)] } });
    await waitFor(() => expect(calls.length).toBe(1));

    const report = calls[0]!.onUploadProgress;
    expect(report).toBeTypeOf('function');

    act(() => report!({ loaded: 10 * MB, total: 40 * MB }));
    const row = await screen.findByTestId('upload-selection');
    expect(within(row).getByText('25%')).toBeInTheDocument();
  });

  it('says "Uploading…" rather than inventing a percentage with no total', async () => {
    const calls = captureHangingPost();
    renderDialog();

    fireEvent.change(videoInput(), { target: { files: [videoFile(40)] } });
    await waitFor(() => expect(calls.length).toBe(1));

    act(() => calls[0]!.onUploadProgress!({ loaded: 10 * MB, total: undefined }));

    const row = await screen.findByTestId('upload-selection');
    expect(within(row).getByText('Uploading…')).toBeInTheDocument();
    expect(within(row).queryByText(/\d+%/)).not.toBeInTheDocument();
  });

  it('keeps refusing past its own 100 MB cap, visibly, and never nudges a refused file', async () => {
    const calls = captureHangingPost();
    renderDialog();

    fireEvent.change(videoInput(), { target: { files: [videoFile(150, 'huge.mp4')] } });

    expect(
      await screen.findByText(/"huge\.mp4" is 150 MB — over the 100 MB limit/)
    ).toBeInTheDocument();
    expect(screen.queryByText(LARGE_FILE_NUDGE)).not.toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.length).toBe(0);
  });

  it('still uploads the batch when the duration probe throws', async () => {
    // The probe is awaited inside uploadFiles' outer try here, so an unguarded rejection
    // would abort every remaining file in the pick, not just lose one clip length.
    probeRejects = true;
    const calls = captureHangingPost();
    renderDialog();

    fireEvent.change(videoInput(), { target: { files: [videoFile(30)] } });

    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]!.domAtCall).toContain('30.0 MB');
  });
});
