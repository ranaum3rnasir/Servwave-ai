import { PenLine } from 'lucide-react';

interface SignatureCardProps {
  signatureData?: string | null;
  signatureAt?: string | null;
}

/**
 * Customer signature for the bottom of the estimate workspace.
 *
 * Read-only: the ONE real signature source is the customer's public-approval capture
 * (`Estimate.signature_data`) — there's no staff-side "add signature" endpoint, so we don't
 * fake one (§C: no control that shows success without a real backend write).
 *
 * This was `AttachmentsSignaturesCard` until 2026-08-27, when attachments were removed from
 * the estimate: an attachment belongs to a lead or to a job, never to an estimate. The
 * estimate's 412 production attachments were re-pointed onto their leads by
 * `20260827120000_estimate_attachments_to_lead`, and the API no longer accepts `ESTIMATE` as
 * an attachment entity. The two-column grid collapsed to this single card with them.
 */
export function SignatureCard({ signatureData, signatureAt }: SignatureCardProps) {
  return (
    <div className="mt-4">
      <div className="rounded-card border border-border bg-surface-light p-6 shadow-card">
        <div className="mb-4 flex items-center justify-between border-b border-border pb-3">
          <h3 className="flex items-center gap-2 text-lg font-bold text-text-primary">
            <PenLine className="h-5 w-5" />
            Signature
          </h3>
        </div>
        {signatureData ? (
          <div className="rounded-lg border border-border bg-surface-light p-2">
            <img src={signatureData} alt="Customer signature" className="h-20 w-full object-contain" />
            {signatureAt && (
              <p className="mt-1 text-xs text-text-secondary">
                Signed {new Date(signatureAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}
              </p>
            )}
          </div>
        ) : (
          <p className="py-10 text-center text-sm text-text-secondary">No signature yet</p>
        )}
      </div>
    </div>
  );
}
