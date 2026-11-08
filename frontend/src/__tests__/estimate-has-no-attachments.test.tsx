/**
 * An estimate has no attachment list.
 *
 * Attachments belong to a lead or to a job. The estimate workspace used to mount the generic
 * `AttachmentsPanel` with `entityType="ESTIMATE"`, which offered an upload control for every
 * context it knows ("Site Visit", "Job Documentation", "Estimate", "Other") regardless of the
 * entity it was on — the same root cause as the lead defect fixed in #1834. That surface is
 * gone, its 412 production rows were re-pointed onto their leads by
 * `20260827120000_estimate_attachments_to_lead`, and the API no longer accepts `ESTIMATE` as
 * an attachment entity at all.
 *
 * The source assertions below follow `lead-single-attachment-list.test.tsx`'s convention: the
 * defect being guarded is a MOUNT, and a mount is only observable in the source. A render test
 * would pass just as happily against a page that mounts the panel behind a collapsed tab.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import { SignatureCard } from '@/features/estimate-workspace/components/SignatureCard';

// There is now ONE estimate workspace. This file used to assert two: `/estimates/:id` routes to
// the v2 page, while a dead v1 copy at `pages/EstimateWorkspacePage.tsx` was still imported by
// nine test suites — the same v1/v2 fork as /settings/roles — so the attachments removal was
// very nearly shipped against the page users never load. The nine suites were repointed at the
// live page and the v1 copy deleted, so the second assertion has nothing left to guard.
//
// The DEAD_WORKSPACE constant is deliberately not replaced by a "the v1 file stays deleted"
// check: the import graph is the real guard now, and `existsSync` below already fails loudly
// if the live page moves.
const LIVE_WORKSPACE = resolve(__dirname, '../pages/v2/estimates/EstimateWorkspacePage.tsx');
const CARD = resolve(__dirname, '../features/estimate-workspace/components/SignatureCard.tsx');

describe('the live estimate workspace has no attachment surface', () => {
  it('does not mount AttachmentsPanel, AttachmentSection, or an IconRail', () => {
    const source = readFileSync(LIVE_WORKSPACE, 'utf8');
    expect(source).not.toContain('AttachmentsPanel');
    expect(source).not.toContain('AttachmentSection');
    // No IconRail either — its default `panels` include the attachments panel, which is how
    // the lead grew a second list (#1834). The estimate must not acquire one the same way.
    expect(source).not.toContain('IconRail');
    expect(source).not.toContain('/api/attachments');
  });

  // Narrow on purpose: `entityType="ESTIMATE"` is still correct on this page for TagInput.
  // Tags belong to an estimate; files do not. Asserting on the bare string would forbid both.
  it('still tags the estimate — this change is about files, not every entity-scoped widget', () => {
    const source = readFileSync(LIVE_WORKSPACE, 'utf8');
    expect(source).toContain('<TagInput entityType="ESTIMATE"');
  });
});

describe('the signature card', () => {

  it('the signature card carries no attachment surface of its own', () => {
    const source = readFileSync(CARD, 'utf8');
    expect(source).not.toContain('AttachmentsPanel');
    expect(source).not.toContain('AttachmentSection');
    expect(source).not.toContain('/api/attachments');
  });

  it('the old AttachmentsSignaturesCard is deleted, not merely unreferenced', () => {
    const old = resolve(__dirname, '../features/estimate-workspace/components/AttachmentsSignaturesCard.tsx');
    expect(existsSync(old)).toBe(false);
  });
});

describe('SignatureCard still renders the customer signature', () => {
  it('shows the captured signature and its timestamp', () => {
    render(<SignatureCard signatureData="data:image/png;base64,AAA" signatureAt="2026-08-20T15:04:00.000Z" />);
    expect(screen.getByAltText('Customer signature')).toBeInTheDocument();
    expect(screen.getByText(/^Signed /)).toBeInTheDocument();
  });

  it('shows the empty state when nothing has been signed', () => {
    render(<SignatureCard signatureData={null} signatureAt={null} />);
    expect(screen.getByText('No signature yet')).toBeInTheDocument();
    expect(screen.queryByAltText('Customer signature')).not.toBeInTheDocument();
  });
});
