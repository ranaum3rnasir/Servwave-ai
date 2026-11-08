import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi } from 'vitest';
import api from '@/lib/axios';
import { AttachmentsTabBody } from '@/components/jobs/AttachmentsTabBody';

// @/lib/axios is globally mocked in src/__tests__/setup.ts

function renderEmptyAttachments() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AttachmentsTabBody jobId="job-1" attachments={[]} />
    </QueryClientProvider>
  );
}

function getDropZone(): HTMLLabelElement {
  const zone = screen
    .getByText(/drag & drop files here, or click to upload/i)
    .closest('label');
  expect(zone).not.toBeNull();
  return zone as HTMLLabelElement;
}

beforeEach(() => {
  vi.mocked(api.post).mockClear();
  vi.mocked(api.post).mockResolvedValue({ data: {} });
});

it('renders a clickable drop-zone (label + hidden file input) in the empty state', () => {
  renderEmptyAttachments();
  const zone = getDropZone();
  expect(zone).toHaveClass('cursor-pointer');
  // Self-contained hidden input nested inside the label (implicit association)
  const input = zone.querySelector('input[type="file"]');
  expect(input).not.toBeNull();
  expect(screen.getByText(/no attachments yet/i)).toBeInTheDocument();
});

it('uploads dropped files via POST /api/attachments/job/:jobId with FormData', async () => {
  renderEmptyAttachments();
  const zone = getDropZone();
  const file = new File(['fake-bytes'], 'photo.png', { type: 'image/png' });

  // Drag payloads are plain objects mimicking dataTransfer (same pattern as
  // MemberWeekBoard.test.tsx — jsdom has no real DataTransfer constructor).
  fireEvent.drop(zone, { dataTransfer: { files: [file] } });

  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  const [url, body] = vi.mocked(api.post).mock.calls[0];
  expect(url).toBe('/api/attachments/job/job-1');
  expect(body).toBeInstanceOf(FormData);
  expect((body as FormData).get('file')).toBe(file);
});

it('uploads files picked through the drop-zone hidden input', async () => {
  renderEmptyAttachments();
  const zone = getDropZone();
  const input = zone.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File(['fake-bytes'], 'manual.pdf', { type: 'application/pdf' });

  fireEvent.change(input, { target: { files: [file] } });

  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  expect(vi.mocked(api.post).mock.calls[0][0]).toBe('/api/attachments/job/job-1');
});

it('highlights the drop-zone on dragOver and clears it on dragLeave', () => {
  renderEmptyAttachments();
  const zone = getDropZone();

  expect(zone).not.toHaveClass('border-primary');
  fireEvent.dragOver(zone, { dataTransfer: { files: [] } });
  expect(zone).toHaveClass('border-primary');
  expect(zone).toHaveClass('bg-primary-subtle');

  fireEvent.dragLeave(zone);
  expect(zone).not.toHaveClass('border-primary');
});
