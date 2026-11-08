/**
 * The attachment drop zone carries NO format/size subtitle (Ran, 2026-09-20).
 *
 * It used to render "JPG, PNG, HEIC, PDF · 25MB max · MP4 · 50MB max" under the drop copy.
 * Ran asked for it gone: "I don't want to mention the sizes and the different file types.
 * Instead, we should just leave the drag-and-drop files here - no subtitles."
 *
 * There was a correctness reason as well as a taste one. The line named four formats out of
 * the thirteen the server accepts, and it hardcoded caps that have now moved (video is
 * 512MB), so it read as a rule while being wrong twice over — and it charged every user
 * attention for a constraint almost none of them meet. The file that does not fit is still
 * refused, by `oversizeRefusalMessage`, with its real size, the real limit and a next step.
 * That is the honest place to spend the words.
 *
 * WHY A TEST AND NOT JUST THE DELETION. This is the kind of line that comes back: it is one
 * `<p>`, it looks helpful, and re-adding it breaks nothing.
 *
 * The guard is STRUCTURAL first, literal second, and the order matters. The literal patterns
 * below (`JPG|HEIC`, `MB\s*max`, `25MB|50MB|512MB`) only catch the wordings someone thought
 * to write down: "Videos up to 512 MB · PDF and images up to 25 MB" defeats all three at once
 * — a space before the unit dodges `512MB`, "up to" dodges `MB max`, and "PDF and images"
 * names no format either pattern lists. That exact line was re-added during review and this
 * file stayed green. So the load-bearing assertion is a COUNT: the drop zone contains exactly
 * one `<p>`, the drag copy. Any second line of caption fails it whatever it says, in whatever
 * unit, in whatever language. The literal assertions are kept because they document the
 * specific string Ran objected to, but they are not what makes a reworded hint fail.
 *
 * The drop copy itself is asserted present, so deleting the whole zone cannot make this pass.
 */
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import api from '@/lib/axios';
import { AttachmentSection } from '@/components/crm/AttachmentSection';

// @/lib/axios is globally mocked in src/__tests__/setup.ts

/**
 * The drop zone element, asserted unique so the selector itself cannot rot into matching
 * nothing — a `querySelector` that silently returns null would make the count assertion
 * below vacuous rather than red.
 */
function dropZone(container: HTMLElement): HTMLElement {
  const zones = container.querySelectorAll<HTMLElement>('.border-dashed');
  expect(zones).toHaveLength(1);
  return zones[0];
}

function renderSection() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AttachmentSection entityType="JOB" entityId="job-1" />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.mocked(api.get).mockResolvedValue({ data: { attachments: [] } });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the attachment drop zone has no pre-pick format or size hint', () => {
  it('still invites the drop — the zone itself is intact', async () => {
    const { container } = renderSection();

    expect(await screen.findByText(/Drag & drop files here/)).toBeInTheDocument();
    expect(screen.getByText('Browse')).toBeInTheDocument();
    expect(container.querySelector('input[type="file"]')).not.toBeNull();
  });

  it('contains exactly one <p> — the drag copy, and no caption of any wording', async () => {
    const { container } = renderSection();
    await screen.findByText(/Drag & drop files here/);

    const paragraphs = dropZone(container).querySelectorAll('p');

    // One paragraph, and it is the invitation. A subtitle is a second <p>, so this fails on
    // any re-added caption regardless of the words in it — which the pattern assertions
    // below demonstrably do not.
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0].textContent).toMatch(/Drag & drop files here, or Browse/);
  });

  it('names no file formats', async () => {
    const { container } = renderSection();
    await screen.findByText(/Drag & drop files here/);

    expect(screen.queryByText(/JPG, PNG, HEIC/)).not.toBeInTheDocument();
    // Read the whole subtree, not only whole text nodes: a re-added hint split across
    // elements would still be visible to the user while dodging a queryByText.
    expect(container.textContent).not.toMatch(/JPG|HEIC/i);
  });

  it('quotes no size cap', async () => {
    const { container } = renderSection();
    await screen.findByText(/Drag & drop files here/);

    expect(screen.queryByText(/MB\s*max/i)).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(/MB\s*max/i);
    // The specific numbers that used to be here, and the one that would replace them.
    expect(container.textContent).not.toMatch(/25MB|50MB|512MB/);
  });
});
