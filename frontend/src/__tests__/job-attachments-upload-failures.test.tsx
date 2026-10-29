/**
 * One rejected file must not take the rest of the batch down with it (#1605).
 *
 * The upload loop was all-or-nothing: `await` inside a `for` with a single outer `catch`, so the
 * first rejection ended the batch, every file queued behind it was silently dropped, and the
 * toast never said which file failed. That is how a .docx that Storage refused looked like
 * "attachments are broken" rather than "this one file was refused".
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import api from '@/lib/axios';
import { AttachmentsTabBody } from '@/components/jobs/AttachmentsTabBody';

const hoisted = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/components/ui/use-toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/use-toast')>();
  return { ...actual, toast: hoisted.toast };
});

function renderTab() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AttachmentsTabBody jobId="job-1" attachments={[]} />
    </QueryClientProvider>,
  );
}

function dropZone(): HTMLLabelElement {
  return screen.getByText(/drag & drop files here, or click to upload/i).closest('label') as HTMLLabelElement;
}

beforeEach(() => {
  hoisted.toast.mockClear();
  vi.mocked(api.post).mockReset();
});

describe('a rejected file in a multi-file drop', () => {
  it('still uploads the other files and names the one that failed', async () => {
    // The real shape of the fix: storage refused the .docx, the photo was fine. The body is the
    // server's own ServWave sentence for that case (attachment.controller.ts mapStorageError).
    vi.mocked(api.post).mockImplementation((_url, body) => {
      const name = ((body as FormData).get('file') as File).name;
      return name.endsWith('.docx')
        ? Promise.reject({ response: { data: { error: "This file type couldn't be saved. Try saving it as a PDF, or contact support." } } })
        : Promise.resolve({ data: {} } as never);
    });

    renderTab();
    fireEvent.drop(dropZone(), {
      dataTransfer: {
        files: [
          new File(['PK'], 'evaluation.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
          new File(['bytes'], 'photo.png', { type: 'image/png' }),
        ],
      },
    });

    // The photo behind the failure still went out.
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));

    await waitFor(() => expect(hoisted.toast).toHaveBeenCalledTimes(1));
    const { title, description } = hoisted.toast.mock.calls[0][0];
    expect(title).toBe('Upload failed');
    expect(description).toContain('evaluation.docx');
    expect(description).toContain("This file type couldn't be saved.");
    expect(description).not.toContain('photo.png');
  });

  it('counts the failures when more than one file is refused', async () => {
    vi.mocked(api.post).mockRejectedValue({ response: { data: { error: "The file couldn't be saved. Please try again." } } });

    renderTab();
    fireEvent.drop(dropZone(), {
      dataTransfer: {
        files: [
          new File(['a'], 'one.docx', { type: 'text/plain' }),
          new File(['b'], 'two.docx', { type: 'text/plain' }),
        ],
      },
    });

    await waitFor(() => expect(hoisted.toast).toHaveBeenCalledTimes(1));
    expect(hoisted.toast.mock.calls[0][0].title).toBe('2 uploads failed');
  });
});
