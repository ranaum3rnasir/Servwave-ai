/**
 * Job uploads that work on cellular (mobile slice 09, rubric CMP-13 and PERF-05).
 *
 * Four behaviours, each pinned through the component a technician actually touches:
 *
 *  1. The line-item photo control offers the photo LIBRARY as well as the camera. A file input
 *     carrying `capture` makes iOS and Android open the camera straight away, with no way to
 *     pick a photo already taken.
 *  2. A large job photo is downscaled BEFORE the upload request, so the bytes on the wire are a
 *     fraction of what the camera produced (a payload-size assertion, not a flag check).
 *  3. A failed job upload leaves a Retry on screen, and Retry sends it again.
 *  4. Attachment tiles set width and height and load lazily, and load the picture ONCE (no
 *     blurred second copy of the full original behind it).
 *
 * jsdom has no canvas and no `createImageBitmap`, so the browser's pixel calls are stubbed with
 * a fake whose output size is proportional to the pixels drawn: a 4032x3024 decode that comes
 * back as a few hundred kilobytes proves the canvas was sized down, because the stub cannot
 * produce a small blob from a full-size canvas.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import api from '@/lib/axios';
import { AttachmentsTabBody } from '@/components/jobs/AttachmentsTabBody';
import { JobFilesCard } from '@/components/jobs/overview/JobFilesCard';
import { ProductThumb } from '@/components/jobs/items/ProductThumb';
import CustomerFormPage from '@/pages/v2/customers/CustomerFormPage';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// @/lib/axios is globally mocked in src/__tests__/setup.ts

const hoisted = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/components/ui/use-toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/use-toast')>();
  return { ...actual, toast: hoisted.toast };
});

const CAMERA_WIDTH = 4032;
const CAMERA_HEIGHT = 3024;
/** A camera-sized JPEG: 6MB of bytes, as a phone hands it over. */
const ORIGINAL_BYTES = 6 * 1024 * 1024;
/** Bytes the fake encoder emits per pixel drawn. 4032x3024 would come back at ~1.8MB. */
const BYTES_PER_PIXEL = 0.15;

function cameraPhoto(name = 'IMG_0412.JPG'): File {
  return new File([new Uint8Array(ORIGINAL_BYTES)], name, { type: 'image/jpeg' });
}

let canvasSizes: Array<{ width: number; height: number }> = [];

function stubBrowserImagePipeline() {
  canvasSizes = [];
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width: CAMERA_WIDTH, height: CAMERA_HEIGHT, close: () => {} })),
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => ({ drawImage: () => {} }) as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
    this: HTMLCanvasElement,
    callback: BlobCallback,
    type?: string,
  ) {
    canvasSizes.push({ width: this.width, height: this.height });
    const size = Math.round(this.width * this.height * BYTES_PER_PIXEL);
    callback(new Blob([new Uint8Array(size)], { type: type ?? 'image/png' }));
  });
}

function withQuery(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

function emptyTabDropZone(): HTMLLabelElement {
  return screen
    .getByText(/drag & drop files here, or click to upload/i)
    .closest('label') as HTMLLabelElement;
}

function sentFile(callIndex = 0): File {
  const body = vi.mocked(api.post).mock.calls[callIndex][1] as FormData;
  return body.get('file') as File;
}

beforeEach(() => {
  hoisted.toast.mockClear();
  vi.mocked(api.post).mockReset();
  vi.mocked(api.post).mockResolvedValue({ data: {} } as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the line-item photo control (CMP-13)', () => {
  it('lets the user pick from the library, not only the camera', () => {
    const { container } = render(
      <ProductThumb alt="Door closer" onAddImage={() => {}} />,
    );
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    // `capture` (any value) sends a phone straight to the camera with no library option.
    expect(input.hasAttribute('capture')).toBe(false);
    expect(input.accept).toContain('image/jpeg');
  });
});

describe('a large job photo is downscaled before the upload request', () => {
  it('on the Attachments tab, the multipart body carries a downscaled JPEG', async () => {
    stubBrowserImagePipeline();
    const original = cameraPhoto();
    withQuery(<AttachmentsTabBody jobId="job-1" attachments={[]} />);

    fireEvent.drop(emptyTabDropZone(), { dataTransfer: { files: [original] } });

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    const sent = sentFile();
    expect(vi.mocked(api.post).mock.calls[0][0]).toBe('/api/attachments/job/job-1');
    expect(sent).not.toBe(original);
    expect(sent.type).toBe('image/jpeg');
    // The payload-size assertion: well under a tenth of what the camera produced.
    expect(sent.size).toBeLessThan(ORIGINAL_BYTES / 10);
    // The canvas was drawn at the capped edge, aspect kept.
    expect(canvasSizes).toEqual([{ width: 2048, height: 1536 }]);
    // The display name still comes from the picked file, not from a re-encoded copy's name.
    const body = vi.mocked(api.post).mock.calls[0][1] as FormData;
    expect(body.get('display_name')).toBe('IMG_0412');
  });

  it('on the Overview files card, the multipart body carries a downscaled JPEG', async () => {
    stubBrowserImagePipeline();
    const original = cameraPhoto();
    const { container } = withQuery(<JobFilesCard jobId="job-1" attachments={[]} />);
    const input = container.querySelector('#overview-files-upload') as HTMLInputElement;

    fireEvent.change(input, { target: { files: [original] } });

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(sentFile().size).toBeLessThan(ORIGINAL_BYTES / 10);
    expect(sentFile().type).toBe('image/jpeg');
  });

  it('sends a small photo as picked, with no re-encode', async () => {
    stubBrowserImagePipeline();
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({ width: 1200, height: 900, close: () => {} })),
    );
    const small = new File([new Uint8Array(300 * 1024)], 'small.jpg', { type: 'image/jpeg' });
    withQuery(<AttachmentsTabBody jobId="job-1" attachments={[]} />);

    fireEvent.drop(emptyTabDropZone(), { dataTransfer: { files: [small] } });

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(sentFile()).toBe(small);
    expect(canvasSizes).toEqual([]);
  });

  it('sends the original when the browser cannot decode the photo, rather than failing', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new Error('decode failed'); }));
    const original = cameraPhoto();
    withQuery(<AttachmentsTabBody jobId="job-1" attachments={[]} />);

    fireEvent.drop(emptyTabDropZone(), { dataTransfer: { files: [original] } });

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(sentFile()).toBe(original);
  });

  it('never touches a video or a document', async () => {
    stubBrowserImagePipeline();
    const pdf = new File([new Uint8Array(2 * 1024 * 1024)], 'quote.pdf', { type: 'application/pdf' });
    withQuery(<AttachmentsTabBody jobId="job-1" attachments={[]} />);

    fireEvent.drop(emptyTabDropZone(), { dataTransfer: { files: [pdf] } });

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(sentFile()).toBe(pdf);
    expect(canvasSizes).toEqual([]);
  });
});

describe('a customer attachment is downscaled before the upload request', () => {
  const CUSTOMER = {
    id: 'cust-1',
    customer_number: 'd00512',
    first_name: 'Pat',
    last_name: 'Example',
    company_name: '',
    email: 'pat@example.test',
    phone: '5551234567',
    phone_ext: null,
    segment: null,
    extra_emails: [],
    phones: [],
    ad_source: null,
    source: null,
    allow_billing: false,
    tax_exempt: true,
    parent_id: null,
    is_parent: false,
    billing_terms: null,
    billing_address_line1: null,
    billing_city: null,
    billing_state: null,
    billing_zip: null,
    notes: null,
    created_at: '2026-08-24T13:48:35.986Z',
    service_locations: [],
  };

  it('the tax-exempt certificate photo goes up shrunk', async () => {
    stubBrowserImagePipeline();
    vi.mocked(api.get).mockImplementation((url: string) =>
      url === '/api/customers/cust-1'
        ? Promise.resolve({ data: { customer: CUSTOMER } } as never)
        : Promise.resolve({ data: {} } as never),
    );
    vi.mocked(api.patch).mockResolvedValue({ data: { customer: CUSTOMER } } as never);
    const original = cameraPhoto('certificate.jpg');

    const { container } = withQuery(
      <MemoryRouter initialEntries={['/customers/cust-1/edit']}>
        <Routes>
          <Route path="/customers/:id/edit" element={<CustomerFormPage />} />
          <Route path="/customers/:id" element={<div>customer detail</div>} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByTestId('customer-form');
    // The certificate control lives under "More Details", which starts collapsed.
    fireEvent.click(await screen.findByRole('button', { name: /More Details/ }));
    const input = await waitFor(() => {
      const el = container.querySelector('input[type="file"][accept*="application/pdf"]');
      if (!el) throw new Error('certificate input not rendered yet');
      return el as HTMLInputElement;
    });
    fireEvent.change(input, { target: { files: [original] } });
    fireEvent.click(await screen.findByTestId('customer-form-submit'));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        '/api/attachments/customer/cust-1',
        expect.anything(),
        expect.anything(),
      ),
    );
    const call = vi.mocked(api.post).mock.calls.find(([url]) => url === '/api/attachments/customer/cust-1')!;
    const sent = (call[1] as FormData).get('file') as File;
    expect(sent.type).toBe('image/jpeg');
    expect(sent.size).toBeLessThan(ORIGINAL_BYTES / 10);
  });
});

describe('a failed job upload shows Retry, and Retry succeeds', () => {
  it('on the Attachments tab', async () => {
    vi.mocked(api.post)
      .mockRejectedValueOnce({ response: { data: { error: 'The connection dropped. Try again.' } } })
      .mockResolvedValueOnce({ data: {} } as never);
    const pdf = new File(['%PDF-1.4'], 'quote.pdf', { type: 'application/pdf' });
    withQuery(<AttachmentsTabBody jobId="job-1" attachments={[]} />);

    fireEvent.drop(emptyTabDropZone(), { dataTransfer: { files: [pdf] } });

    const retry = await screen.findByRole('button', { name: 'Retry quote.pdf' });
    expect(screen.getByText(/The connection dropped\. Try again\./)).toBeInTheDocument();

    fireEvent.click(retry);

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    expect(sentFile(1)).toBe(pdf);
    // Succeeded: the failed row and its Retry are gone.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Retry quote.pdf' })).not.toBeInTheDocument(),
    );
    expect(screen.queryByText(/The connection dropped/)).not.toBeInTheDocument();
  });

  it('on the Overview files card', async () => {
    vi.mocked(api.post)
      .mockRejectedValueOnce({ response: { data: { error: 'The connection dropped. Try again.' } } })
      .mockResolvedValueOnce({ data: {} } as never);
    const pdf = new File(['%PDF-1.4'], 'quote.pdf', { type: 'application/pdf' });
    const { container } = withQuery(<JobFilesCard jobId="job-1" attachments={[]} />);
    const input = container.querySelector('#overview-files-upload') as HTMLInputElement;

    fireEvent.change(input, { target: { files: [pdf] } });
    fireEvent.click(await screen.findByRole('button', { name: 'Retry quote.pdf' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Retry quote.pdf' })).not.toBeInTheDocument(),
    );
  });
});

describe('attachment tiles (PERF-05)', () => {
  const photo = {
    id: 'att-1',
    file_name: 'front-door.jpg',
    file_url: 'https://files.example.test/front-door.jpg',
    file_type: 'image/jpeg',
    display_name: 'Front door',
  };

  function assertOneLazySizedImage(container: HTMLElement) {
    const imgs = container.querySelectorAll(`img[src="${photo.file_url}"]`);
    // Once, not twice: no blurred full-size duplicate behind the tile.
    expect(imgs).toHaveLength(1);
    const img = imgs[0] as HTMLImageElement;
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(Number(img.getAttribute('width'))).toBeGreaterThan(0);
    expect(Number(img.getAttribute('height'))).toBeGreaterThan(0);
  }

  it('on the Attachments tab, set width and height and load lazily', () => {
    const { container } = withQuery(<AttachmentsTabBody jobId="job-1" attachments={[photo]} />);
    assertOneLazySizedImage(container);
  });

  it('on the Overview files card, set width and height and load lazily', () => {
    const { container } = withQuery(<JobFilesCard jobId="job-1" attachments={[photo]} />);
    assertOneLazySizedImage(container);
  });
});
