/**
 * The lead's Attachments tab is the lead's ONE attachment list.
 *
 * Two defects shipped together and are guarded together here:
 *
 *  1. The lead page mounted `IconRail` without `panels`, taking the default that
 *     includes the attachments panel. That gave a lead a SECOND list, and that
 *     panel still offered "Upload to Site Visit" - writing context=WALKTHROUGH,
 *     the very split the single-list change retired.
 *  2. `AttachmentSection` badged every tile from the `context` PROP, so a mixed
 *     list badged every row "OTHER". The badge was removed outright rather than
 *     corrected.
 *
 * `context` has since been retired entirely. The rows below therefore carry no
 * context at all - what they still test is that NO surface filters a lead's
 * files back down to a subset, which is the defect both halves above produced.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi } from 'vitest';
import api from '@/lib/axios';
import { AttachmentSection } from '@/components/crm/AttachmentSection';
import { AttachmentsPanel } from '@/components/crm/AttachmentsPanel';
import { AttachmentsTabBody } from '@/components/jobs/AttachmentsTabBody';

// @/lib/axios is globally mocked in src/__tests__/setup.ts

const LEAD_ID = 'lead-1';

/** Uploaded under the retired walkthrough split - still on the lead, still must show. */
const WALKTHROUGH_ROW = {
  id: 'att-wt',
  file_name: 'site.png',
  file_url: 'https://files.test/site.png',
  file_type: 'image/png',
  file_size: 1024,
  display_name: 'Site visit photo',
  description: '',
  created_at: new Date().toISOString(),
  uploader: { id: 'u1', first_name: 'A', last_name: 'B' },
};

/** Uploaded from the lead's own Attachments tab. */
const OTHER_ROW = {
  ...WALKTHROUGH_ROW,
  id: 'att-other',
  file_name: 'contract.pdf',
  file_url: 'https://files.test/contract.pdf',
  file_type: 'application/pdf',
  display_name: 'Signed contract',
};

/**
 * Read a source file for the structural guard below.
 *
 * `import.meta.url` is not a file: URL under the jsdom environment, so the
 * `fileURLToPath` idiom used by the node-environment design-system guards is
 * unavailable here. Resolve from the vitest root instead, and throw rather than
 * skip if the file is not where expected - a guard that silently stops reading
 * anything is worse than no guard.
 */
function readSource(relativeToSrc: string): string {
  const candidates = [
    resolve(process.cwd(), 'src', relativeToSrc),
    resolve(process.cwd(), 'frontend/src', relativeToSrc),
  ];
  const hit = candidates.find(existsSync);
  if (!hit) throw new Error(`could not locate src/${relativeToSrc} from ${process.cwd()}`);
  return readFileSync(hit, 'utf-8');
}

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.mocked(api.get).mockResolvedValue({
    data: { attachments: [WALKTHROUGH_ROW, OTHER_ROW] },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the lead has exactly one attachment list', () => {
  it('does not mount the IconRail attachments panel on the lead page', () => {
    const source = readSource('pages/v2/leads/LeadDetailPage.tsx');
    // The panel is opt-OUT: IconRail's default includes 'attachments', so omitting
    // the prop silently re-adds the duplicate list and the WALKTHROUGH upload target.
    expect(source).toContain("<IconRail entityType=\"LEAD\" entityId={id!} panels={['activity']}>");
  });
});

describe('AttachmentSection lists the whole entity', () => {
  it('lists every file on the entity, whatever it was historically stamped with', async () => {
    renderWithClient(<AttachmentSection entityType="LEAD" entityId={LEAD_ID} />);

    expect(await screen.findByText('Site visit photo')).toBeInTheDocument();
    expect(screen.getByText('Signed contract')).toBeInTheDocument();
  });

  it('renders no context badge at all', async () => {
    renderWithClient(<AttachmentSection entityType="LEAD" entityId={LEAD_ID} />);

    // The badge briefly read the section PROP, so a mixed list badged every tile "OTHER".
    // Rather than fix what it displayed, the badge is gone - and the value behind it is now
    // retired outright. Neither the stale label nor a corrected one may come back.
    expect(await screen.findByText('Site visit photo')).toBeInTheDocument();
    expect(screen.queryByText('WALKTHROUGH')).not.toBeInTheDocument();
    expect(screen.queryByText('OTHER')).not.toBeInTheDocument();
  });
});

describe('the rail panel lists the whole entity too', () => {
  /**
   * Replaces the guard that used to assert `key: 'WALKTHROUGH'` still existed in
   * AttachmentsPanel. Its concern was that retiring context must not take historical rows
   * off the surfaces that still mount the panel - the panel bucketed by context, so an
   * unrecognised value could have been dropped. It no longer buckets at all, which is a
   * stronger answer to the same worry, and this asserts the outcome rather than the shape.
   */
  it('renders every row returned for the entity, with no bucketing', async () => {
    renderWithClient(<AttachmentsPanel entityType="INVOICE" entityId="inv-1" />);

    expect(await screen.findByText('Site visit photo')).toBeInTheDocument();
    expect(screen.getByText('Signed contract')).toBeInTheDocument();
    expect(screen.getByText('2 attachments')).toBeInTheDocument();
  });
});

describe('the job groups forwarded lead files under their own label', () => {
  it('renders a "From lead" section for source=LEAD rows', () => {
    renderWithClient(
      <AttachmentsTabBody
        jobId="job-1"
        attachments={[
          { ...WALKTHROUGH_ROW, source: 'LEAD' },
          { ...OTHER_ROW, source: 'LEAD' },
          // `source` is the only discriminator - a job-owned file is identical but for it.
          { ...OTHER_ROW, id: 'att-job', display_name: 'Job doc', source: null },
        ]}
      />
    );

    expect(screen.getByText('From lead (2)')).toBeInTheDocument();
    expect(screen.getByText('Documents (1)')).toBeInTheDocument();
  });
});
