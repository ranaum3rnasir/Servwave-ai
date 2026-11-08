/**
 * R5f — scope-of-work photo attachments. Covers `ScopePhotoStrip` directly (upload FormData
 * shape hitting the SCOPE endpoint keyed on the block's stable `id`, not its array index; delete)
 * and `EstimateScopeOfWorkCard`'s grouping of the estimate's flat top-level `scope_photos[]` by
 * `scope_id` — a photo belonging to one scope block must only ever render under THAT block, never
 * a sibling. Mirrors `estimate-line-item-photos.test.tsx`'s axios-mock convention.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { ScopePhotoStrip } from '@/components/estimates/photos/ScopePhotoStrip';
import { EstimateScopeOfWorkCard } from '@/components/estimates/EstimateLineItemsEditor';
import type { EstimateScopePhoto } from '@/lib/api/estimates';
import type { Scope } from '@/lib/api/jobs';

// #2029 — every pick now goes through `normaliseImageForUpload`, whose real pipeline needs a
// canvas jsdom does not have. Stubbed to the identity conversion so this file keeps testing what
// it is about (the FormData shape and the endpoint), and the normalisation decisions are covered
// on their own in lib/image-normalise.test.ts.
vi.mock('@/lib/image-normalise', async () => {
  const actual = await vi.importActual<typeof import('@/lib/image-normalise')>('@/lib/image-normalise');
  return {
    ...actual,
    normaliseImageForUpload: async (file: File) => ({ file, width: 480, height: 360 }),
  };
});

const mockApi = vi.mocked(api);

const ESTIMATE_ID = 'est-1';
const SCOPE_ID = 'scope-aaa';

const EXISTING_PHOTO: EstimateScopePhoto = {
  id: 'sp-1',
  scope_id: SCOPE_ID,
  url: 'https://signed.example/scope-existing.jpg',
  mime_type: 'image/jpeg',
  caption: 'scope-existing.jpg',
  uploaded_at: '2026-07-10T00:00:00.000Z',
  uploaded_by: 'Test Admin',
  size_bytes: 123,
};

beforeEach(() => {
  vi.clearAllMocks();
});

function pickFiles(input: HTMLInputElement, files: File[]) {
  fireEvent.change(input, { target: { files } });
}

describe('ScopePhotoStrip — upload/delete against the scope endpoint', () => {
  it('picking a file POSTs multipart FormData to /scopes/:scopeId/photos, keyed on the stable id', async () => {
    mockApi.post.mockResolvedValue({
      data: { photo: { ...EXISTING_PHOTO, id: 'sp-2', url: 'https://signed.example/new.jpg' } },
    });
    renderWithProviders(<ScopePhotoStrip estimateId={ESTIMATE_ID} scopeId={SCOPE_ID} photos={[]} canManage estimatePhotoCount={0} />);

    const file = new File(['abc'], 'photo.jpg', { type: 'image/jpeg' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    pickFiles(input, [file]);

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledTimes(1));
    const [url, body, config] = mockApi.post.mock.calls[0]!;
    expect(url).toBe(`/api/estimates/${ESTIMATE_ID}/scopes/${SCOPE_ID}/photos`);
    expect((body as FormData).get('file')).toBeInstanceOf(File);
    // Regression: see the identical assertion in estimate-line-item-photos.test.tsx — the shared
    // axios instance's default `Content-Type: application/json` silently wins over a FormData
    // body unless explicitly overridden per-request.
    expect(config?.headers).toMatchObject({ 'Content-Type': 'multipart/form-data' });
  });

  it('deleting confirms then DELETEs /scopes/:scopeId/photos/:photoId and removes the thumbnail', async () => {
    mockApi.delete.mockResolvedValue({ data: undefined });
    renderWithProviders(
      <ScopePhotoStrip estimateId={ESTIMATE_ID} scopeId={SCOPE_ID} photos={[EXISTING_PHOTO]} canManage estimatePhotoCount={1} />,
    );

    expect(screen.getByAltText('scope-existing.jpg')).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText('Remove scope photo'));
    await userEvent.click(await screen.findByRole('button', { name: 'Remove' }));

    await waitFor(() =>
      expect(mockApi.delete).toHaveBeenCalledWith(
        `/api/estimates/${ESTIMATE_ID}/scopes/${SCOPE_ID}/photos/${EXISTING_PHOTO.id}`,
      ),
    );
  });
});

describe('EstimateScopeOfWorkCard — grouping photos by scope_id', () => {
  const SCOPE_A: Scope = {
    id: 'scope-a',
    title: 'Demo & haul-away',
    body: 'Remove old unit.',
    flat_price: null,
    is_taxable: true,
    internal_cost: null,
  };
  const SCOPE_B: Scope = {
    id: 'scope-b',
    title: 'Permit filing',
    body: '',
    flat_price: null,
    is_taxable: false,
    internal_cost: null,
  };

  function photoFor(scopeId: string, id: string, caption: string): EstimateScopePhoto {
    return {
      id,
      scope_id: scopeId,
      url: `https://signed.example/${id}.jpg`,
      mime_type: 'image/jpeg',
      caption,
      uploaded_at: '2026-07-10T00:00:00.000Z',
      uploaded_by: 'Test Admin',
      size_bytes: 10,
    };
  }

  it("shows a scope's own photo only under its own block, not a sibling block", () => {
    const photoA = photoFor('scope-a', 'sp-a1', 'photo-for-a');
    renderWithProviders(
      <EstimateScopeOfWorkCard
        estimate={{ id: ESTIMATE_ID, scopes: [SCOPE_A, SCOPE_B], scope_photos: [photoA] }}
        canManage
        canSeePricing
      />,
    );

    const blocks = screen.getAllByTestId('scope-block');
    expect(blocks).toHaveLength(2);
    const [blockA, blockB] = blocks;
    expect(within(blockA!).getByAltText('photo-for-a')).toBeInTheDocument();
    expect(within(blockB!).queryByAltText('photo-for-a')).not.toBeInTheDocument();
    // Block B has no photos of its own, but canManage still shows its own "Add scope photo" tile.
    expect(within(blockB!).getByLabelText('Add scope photo')).toBeInTheDocument();
  });

  it('splits photos correctly when both blocks have their own photos', () => {
    const photoA = photoFor('scope-a', 'sp-a1', 'photo-for-a');
    const photoB = photoFor('scope-b', 'sp-b1', 'photo-for-b');
    renderWithProviders(
      <EstimateScopeOfWorkCard
        estimate={{ id: ESTIMATE_ID, scopes: [SCOPE_A, SCOPE_B], scope_photos: [photoA, photoB] }}
        canManage
        canSeePricing
      />,
    );

    const [blockA, blockB] = screen.getAllByTestId('scope-block');
    expect(within(blockA!).getByAltText('photo-for-a')).toBeInTheDocument();
    expect(within(blockA!).queryByAltText('photo-for-b')).not.toBeInTheDocument();
    expect(within(blockB!).getByAltText('photo-for-b')).toBeInTheDocument();
    expect(within(blockB!).queryByAltText('photo-for-a')).not.toBeInTheDocument();
  });
});
