/**
 * The attachment caps the browser refuses at, and what the drop zones are allowed to say.
 *
 * `upload-limits-match-backend.test.ts` already pins the two trees to EACH OTHER. It cannot
 * pin them to the decision: lowering both sides together keeps it green. So the decided number
 * is asserted here as a literal, once.
 *
 * The other two things this file covers are the ones a constant change does not reach:
 *
 *  - THE PRE-PICK HINT IS GONE. Every attachment drop zone used to print
 *    "JPG, PNG, HEIC, PDF · 25MB max · MP4 · 500MB max" under "Drag & drop files here".
 *    Ran removed it on 2026-09-20: the drop zone says what to do, and nothing about formats
 *    or sizes until a pick is actually refused. The cases below are the regression guard —
 *    a reworded, shortened or relocated version of that line is the same defect.
 *  - THE SURFACES WITH THEIR OWN, SMALLER CAPS. `StageDetailDialog` shares the refusal COPY
 *    with the generic surfaces but passes its own cap into it. Drop that argument and the
 *    default takes over, which now means a stage video is refused at 512MB instead of 100MB —
 *    silently inheriting a number its own route will not carry.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';

import api from '@/lib/axios';
import { renderWithProviders, inventoryWriteAbility } from './helpers';
import {
  MAX_UPLOAD_BYTES,
  MAX_VIDEO_UPLOAD_BYTES,
  oversizeRefusalMessage,
} from '@/lib/uploadTypes';
import { AttachmentSection } from '@/components/crm/AttachmentSection';
import { StageDetailDialog } from '@/components/inventory/StageDetailDialog';
import { AttachmentsTabBody } from '@/components/jobs/AttachmentsTabBody';
import type { JobStage } from '@/lib/api/inventory';

vi.mock('@/components/ui/use-toast', () => ({
  toast: vi.fn(),
  useToast: () => ({ toast: vi.fn(), dismiss: vi.fn() }),
}));

const mockApi = vi.mocked(api);
const MB = 1024 * 1024;

/** The stage route's own video cap, which is NOT the generic one and must not become it. */
const STAGE_VIDEO_CAP = 100 * MB;

function sized(name: string, type: string, size: number): File {
  const f = new File(['x'], name, { type });
  Object.defineProperty(f, 'size', { value: size });
  return f;
}

// ─── 1. The decided number, on the client ────────────────

describe('the client refuses at the cap Ran decided', () => {
  it('refuses video above 512MB, not above 50MB', () => {
    expect(MAX_VIDEO_UPLOAD_BYTES).toBe(512 * MB);
  });

  it('leaves the non-video cap at 25MB', () => {
    expect(MAX_UPLOAD_BYTES).toBe(25 * MB);
  });

  it('accepts a video at exactly the cap and refuses the byte after it', () => {
    // Arithmetic against the constant. A fixture that says "512 * MB" as its own literal stops
    // testing the boundary the moment the boundary moves.
    expect(oversizeRefusalMessage(sized('clip.mp4', 'video/mp4', MAX_VIDEO_UPLOAD_BYTES))).toBeNull();
    expect(
      oversizeRefusalMessage(sized('clip.mp4', 'video/mp4', MAX_VIDEO_UPLOAD_BYTES + 1)),
    ).toContain(`${MAX_VIDEO_UPLOAD_BYTES / MB}MB limit`);
  });
});

// ─── 2. The pre-pick hint is gone from every drop zone ─────────────────

/**
 * Ran, 2026-09-20: "I don't want to mention the sizes and the different file types. Instead,
 * we should just leave the drag-and-drop files here - no subtitles."
 *
 * So the line that read "JPG, PNG, HEIC, PDF · 25MB max · MP4 · 500MB max" is out of the DOM
 * on every surface that carried it, and the shared constant behind it is deleted so it cannot
 * be reintroduced from one import.
 *
 * THESE CASES GUARD IN TWO WAYS, AND ONLY THE SECOND ONE IS GENERAL.
 *
 *  - `expectNoSizeHint` matches the two literal shapes the old line used — the format list and
 *    "<n>MB max". That is a record of the exact sentence Ran objected to, and nothing more.
 *    An earlier revision of this comment claimed those matchers were "SHAPE-based rather than
 *    string-based", so that "a reworded, shortened or relocated version of the same subtitle
 *    is the same defect". They are not, and it was not true: adding
 *    "Images and PDFs up to 25MB, video up to 512MB" to `AttachmentSection` left all twelve
 *    cases in this file green.
 *  - `expectDropZoneShape` is the guard that actually holds, and it counts ELEMENTS. The
 *    customer/lead drop zone carries exactly one `<p>` (the prompt); the empty job Attachments
 *    tab's drop zone carries exactly two (the prompt and the `Uploading… / No attachments yet`
 *    STATUS line); the populated job tab ends with the attachment grid and nothing after it.
 *    A subtitle fails those counts whatever it says, so rewording is not an escape.
 *
 * What is NOT removed, and must not be caught by these: `oversizeRefusalMessage`, the sentence
 * shown AFTER a pick is refused. Ran objected to being told a limit up front, not to being
 * told why a file bounced. Its own coverage is section 4 below, and it quotes "over the NMB
 * limit" rather than "NMB max", which is why these matchers do not reach it. It also renders
 * ABOVE the drop zone, in `UploadRefusalList`, so the element counts do not reach it either.
 */
describe('the drop zones say nothing about formats or sizes before a pick', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.get.mockResolvedValue({ data: { attachments: [] } });
    mockApi.post.mockResolvedValue({ data: {} });
  });

  const populatedTab = [
    {
      id: 'att-1',
      file_name: 'front-door.jpg',
      file_url: 'https://example.test/front-door.jpg',
      file_type: 'image/jpeg',
      display_name: 'front-door.jpg',
    },
  ];

  /**
   * The drop zone `prompt` sits in — the dashed-border box itself, found by walking up rather
   * than by index, so wrapping the prompt does not silently retarget the count.
   */
  function dropZoneAround(prompt: HTMLElement): HTMLElement {
    const zone = prompt.closest('[class*="border-dashed"]');
    expect(zone).not.toBeNull();
    return zone as HTMLElement;
  }

  /**
   * The structural guard: a drop zone holds exactly the elements it is supposed to hold.
   *
   * `paragraphs` counts every `<p>` in the zone and `children` counts its direct element
   * children, so a subtitle is caught whether it is a sibling of the prompt or tucked inside
   * a new wrapper, and whatever words it uses.
   */
  function expectDropZoneShape(
    zone: HTMLElement,
    expected: { paragraphs: number; children: number },
  ): void {
    expect(zone.querySelectorAll('p')).toHaveLength(expected.paragraphs);
    expect(zone.children).toHaveLength(expected.children);
  }

  /** No element anywhere in the document carries either shape. */
  function expectNoSizeHint(): void {
    expect(screen.queryAllByText(/JPG, PNG, HEIC/)).toHaveLength(0);
    expect(screen.queryAllByText(/MB\s*max/)).toHaveLength(0);
    // Belt and braces on the raw text, because a matcher only sees elements: a hint split
    // across two spans, or parked in a title/aria attribute, would slip past the queries.
    expect(document.body.textContent ?? '').not.toMatch(/JPG, PNG, HEIC/);
    expect(document.body.textContent ?? '').not.toMatch(/MB\s*max/);
  }

  it('leaves the customer/lead drop zone with the icon and one line', async () => {
    const view = renderWithProviders(<AttachmentSection entityType="CUSTOMER" entityId="c-1" />);
    const prompt = await view.findByText(/Drag & drop files here/);

    // The drop zone still says what to DO - that half was never the objection.
    expect(prompt).toBeInTheDocument();
    // ONE line, and it is that one. An icon, the prompt and the hidden input, nothing else.
    expectDropZoneShape(dropZoneAround(prompt), { paragraphs: 1, children: 3 });
    expectNoSizeHint();
    view.unmount();
  });

  it('leaves the empty job Attachments tab with its drop zone and status line only', async () => {
    const view = renderWithProviders(<AttachmentsTabBody jobId="job-1" attachments={[]} />);
    const prompt = await view.findByText(/Drag & drop files here/);

    expect(prompt).toBeInTheDocument();
    // The status line is a STATUS, not a size hint, and stays.
    const status = view.getByText('No attachments yet');
    expect(status).toBeInTheDocument();
    // TWO lines, and they are those two: the prompt and the status. Plus the hidden input and
    // the icon, which is what the fourth child is.
    const zone = dropZoneAround(prompt);
    expectDropZoneShape(zone, { paragraphs: 2, children: 4 });
    expect(zone).toContainElement(status);
    expectNoSizeHint();
    view.unmount();
  });

  it('leaves no footnote at the end of the populated job Attachments tab', async () => {
    // The populated state had no drop zone, so the same sentence rendered as a footnote at
    // the end of the card body. That site is gone too, which the empty-state case cannot see.
    const view = renderWithProviders(
      <AttachmentsTabBody jobId="job-1" attachments={populatedTab} />,
    );
    const photosLabel = await view.findByText(/^Photos \(1\)$/);
    const heading = view.getByRole('heading', { name: 'Attachments' });

    // `SectionCard` is a header band followed by the body, so the body is the card's last
    // child, and the footnote was the body's last child. The structural claim is that the
    // body now ENDS with the attachment grid: anything appended after it — a caption of any
    // tag, with any wording — makes this fail.
    const card = heading.parentElement!.parentElement!;
    const body = card.lastElementChild!;
    expect(body).not.toBe(heading.parentElement);
    expect(body).toContainElement(photosLabel);
    expect(body.lastElementChild).toContainElement(photosLabel);

    expectNoSizeHint();
    view.unmount();
  });

  it('leaves the card header as `SectionCard`\'s own, unmodified', async () => {
    // Not about the hint, and kept for that reason: the two attempts to caption the Upload
    // button from the header cost a `titleAlign` prop that clipped other cards' buttons, then
    // a `truncate` that painted their titles at 0px. Both were reverted, and the `h3` being a
    // DIRECT child of the band with no `truncate` is what says so.
    const view = renderWithProviders(
      <AttachmentsTabBody jobId="job-1" attachments={populatedTab} />,
    );
    const heading = await view.findByRole('heading', { name: 'Attachments' });
    const uploadButton = view.getByRole('button', { name: 'Upload' });

    expect(heading.parentElement).toContainElement(uploadButton);
    expect(heading.classList.contains('truncate')).toBe(false);
    view.unmount();
  });
});

// ─── 3. Surfaces with their own, smaller caps ────────────

describe('a surface with its own cap does not inherit the generic one', () => {
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

  function uploadInput(): HTMLInputElement {
    const inputs = document.querySelectorAll('input[type="file"]');
    return inputs[2] as HTMLInputElement;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.get.mockImplementation(((url: string) => {
      if (url === '/api/inventory/vendors') return Promise.resolve({ data: { vendors: [] } });
      if (url === '/api/inventory/techs') return Promise.resolve({ data: { techs: [] } });
      return Promise.resolve({ data: {} });
    }) as typeof mockApi.get);
    mockApi.post.mockResolvedValue({ data: { attachment: null } });
  });

  it('refuses a stage video at ITS cap, well under the generic one', async () => {
    renderWithProviders(
      <StageDetailDialog
        open
        onClose={vi.fn()}
        stage={makeStage()}
        locations={[]}
        onSave={vi.fn()}
        onReceiveOne={vi.fn()}
      />,
      { ability: inventoryWriteAbility() },
    );

    // Comfortably inside the 512MB generic cap and comfortably outside the stage route's own.
    const clip = sized('walkthrough.mp4', 'video/mp4', STAGE_VIDEO_CAP + MB);
    fireEvent.change(uploadInput(), { target: { files: [clip] } });

    // The limit named is the stage route's, which is the claim: the message the user gets must
    // be about the gate that actually stopped them.
    expect(
      await screen.findByText(new RegExp(`over the ${STAGE_VIDEO_CAP / MB}MB limit`)),
    ).toBeInTheDocument();
    await waitFor(() => expect(mockApi.post).not.toHaveBeenCalled());
  });

  it('does not quote the generic video cap on the stage surface', () => {
    // Direct on the seam as well as through the DOM above: passing a cap must beat the
    // default, and the default is now five times the stage route's ceiling.
    const clip = sized('walkthrough.mp4', 'video/mp4', STAGE_VIDEO_CAP + MB);
    const refusal = oversizeRefusalMessage(clip, STAGE_VIDEO_CAP);

    expect(refusal).toContain(`${STAGE_VIDEO_CAP / MB}MB limit`);
    expect(refusal).not.toContain(`${MAX_VIDEO_UPLOAD_BYTES / MB}MB limit`);
  });
});

// ─── 4. One unit style for a cap, wherever a cap is quoted ───────────────────

/**
 * The header caption and the refusal that answered it were read minutes apart on the same
 * card and they disagreed: `25MB max` in the header, "over the 25 MB limit" in the refusal.
 * The header caption is gone now, but the unit style it settled outlives it and still binds
 * the refusal, which is the only copy left that quotes a cap.
 *
 * Unspaced is the one kept, and not on taste. It is what the SERVER already says:
 * `sizeLimitLabel` in `backend/src/middleware/multerErrors.ts` renders every cap it quotes as
 * `25MB` / `512MB` / `1GB`, so the refusal the client shows before the request and the one
 * the API shows after it read alike.
 *
 * SAID OUT LOUD, because it is still inconsistent: per-FILE sizes in the attachment grid come
 * from `formatSize` in `AttachmentsPanel.tsx` and still read "1.2 MB", spaced and to one
 * decimal. That is a measured size rather than a cap, it is a shared helper with callers on
 * other surfaces, and it was outside this change. It deserves its own pass.
 */
describe('a cap is quoted the same way wherever it is quoted', () => {
  it('quotes the cap in the refusal unspaced, the way the server does', () => {
    const refusal = oversizeRefusalMessage(
      sized('spec.pdf', 'application/pdf', MAX_UPLOAD_BYTES + MB),
    )!;

    expect(refusal).toContain(`${MAX_UPLOAD_BYTES / MB}MB limit`);
  });

  it('quotes the file its own size the same way', () => {
    expect(oversizeRefusalMessage(sized('a.mp4', 'video/mp4', 513 * MB))).toContain('is 513MB');
  });

  it('leaves no spaced megabyte in the refusal', () => {
    const refusal = oversizeRefusalMessage(
      sized('clip.mp4', 'video/mp4', MAX_VIDEO_UPLOAD_BYTES + MB),
    )!;

    expect(refusal).not.toMatch(/\d MB/);
  });
});
