/**
 * The upload queue under StrictMode's double-invoked effects.
 *
 * `main.tsx:9` wraps the whole app in `<React.StrictMode>`, and React still runs
 * setup -> cleanup -> setup on mount in development. Refs survive that cycle, so any ref that
 * is armed at creation and disarmed in a cleanup comes out of mount DISARMED and stays that
 * way for the component's whole life. `useUploadQueue`'s `alive` ref is exactly that shape.
 *
 * The rest of the suite renders without StrictMode, which is why this was invisible: every
 * other test mounts the hook once and `alive` is never cleaned up. That makes this file the
 * only thing standing between a dev build and an upload surface that silently never finishes.
 *
 * Asserted through behaviour a user would notice, not by reading the ref.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StrictMode } from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { TooltipProvider as KitTooltipProvider } from '@/ui-kit/components/ui/tooltip';
import api from '@/lib/axios';
import { AttachmentsTabBody } from '@/components/jobs/AttachmentsTabBody';

const mockApi = vi.mocked(api);
const MB = 1024 * 1024;

function videoFile(megabytes: number, name = 'walkthrough.mp4'): File {
  const f = new File(['x'], name, { type: 'video/mp4' });
  Object.defineProperty(f, 'size', { value: Math.round(megabytes * MB) });
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockResolvedValue({ data: { attachments: [] } });
  mockApi.post.mockResolvedValue({ data: {} });
});

/**
 * StrictMode must be the RENDER ROOT, exactly as `main.tsx` mounts it.
 *
 * This is not cosmetic and it is the reason this hazard kept reading as unreproducible:
 * React runs the extra setup -> cleanup -> setup pass for the tree it is mounting, so a
 * `<StrictMode>` placed BELOW already-mounting providers does not double-invoke its
 * descendants at all. Measured in this harness:
 *
 *   StrictMode outermost          -> setup,cleanup,setup
 *   StrictMode inside providers   -> setup
 *
 * So the obvious way to write this test - `renderWithProviders(<StrictMode>...)` - passes
 * against the broken hook. Hence the hand-built tree rather than the shared helper.
 */
function renderInStrictMode() {
  return render(
    <StrictMode>
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
          })
        }
      >
        <KitTooltipProvider delayDuration={320}>
          <MemoryRouter>
            <AttachmentsTabBody jobId="job-1" attachments={[]} />
          </MemoryRouter>
        </KitTooltipProvider>
      </QueryClientProvider>
    </StrictMode>
  );
}

async function pick(container: HTMLElement, file: File) {
  let input: HTMLInputElement | undefined;
  await waitFor(() => {
    input = container.querySelector<HTMLInputElement>('input[type="file"]') ?? undefined;
    expect(input).toBeDefined();
  });
  fireEvent.change(input!, { target: { files: [file] } });
}

describe('useUploadQueue under StrictMode', () => {
  it('uploads a picked file', async () => {
    const { container } = renderInStrictMode();

    await pick(container, videoFile(30));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
  });

  it('finishes: the selection row clears once the upload succeeds', async () => {
    // The real symptom of a disarmed `alive`: the transport resolves, but the completion
    // handler early-returns, so the row never reaches 'done', the batch never settles, the
    // file input is never reset and the surface reports itself busy for ever.
    const { container } = renderInStrictMode();

    await pick(container, videoFile(30));
    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());

    await waitFor(() => {
      expect(screen.queryByTestId('upload-selection')).not.toBeInTheDocument();
    });
  });

  it('stops reporting itself busy once the batch is done', async () => {
    // `isUploading` drives the Upload button's disabled state and its "Uploading…" label. If
    // the batch never settles, the control never comes back.
    const { container } = renderInStrictMode();

    await pick(container, videoFile(30));
    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());

    await waitFor(() => {
      expect(screen.queryByText('Uploading…')).not.toBeInTheDocument();
    });
  });
});
