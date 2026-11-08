import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { AlertTriangle, Mail, Phone, MapPin, ArrowRight, Pencil, Loader2 } from 'lucide-react';
import { formatPhone } from '@/lib/utils';

/** The full `existing` customer payload from the backend's 409 `duplicate` response (spec §4.4) —
 * sent when the requester may read the matched row. */
export interface FullExistingCustomer {
  id: string;
  customer_number: string;
  first_name: string | null;
  last_name: string | null;
  company_name: string | null;
  email: string | null;
  phone: string | null;
  is_active: boolean;
  archived_at: string | null;
  primary_address: { line1: string; city: string; state: string } | null;
  /**
   * The exact value(s) that collided. Because the guard is relation-aware, the match
   * may be a SECONDARY phones[]/extra_emails[] entry — not the primary email/phone —
   * so this drives both the highlight and the displayed value (the value the user
   * actually typed). `null` for a field that didn't match.
   */
  matched?: { email: string | null; phone: string | null };
}

/** The redacted `existing` payload (#1996): sent when the requester may NOT read the matched
 * row. Carries no PII — only the id (so a dispatcher/admin can still link it) and which field(s)
 * collided. `matched`'s keys are optional on the wire (the frozen fixture omits the field that
 * didn't collide), always booleans, never the stored value. */
export interface RedactedExistingCustomer {
  id: string;
  matched: { email?: boolean; phone?: boolean };
  redacted: true;
}

/** The `existing` customer payload from the backend's 409 `duplicate` response (spec §4.4). */
export type ExistingCustomer = FullExistingCustomer | RedactedExistingCustomer;

export function isRedactedMatch(e: ExistingCustomer): e is RedactedExistingCustomer {
  return (e as RedactedExistingCustomer).redacted === true;
}

export interface DuplicateCustomerDialogProps {
  open: boolean;
  /** The existing customer that collided (null while closed). */
  existing: ExistingCustomer | null;
  /**
   * Legacy fallback for which field(s) collided. When the backend's relation-aware
   * `existing.matched` is present (now always), it takes precedence over this.
   */
  matchedFields?: { email: boolean; phone: boolean };
  /**
   * "This is the same person." Parent decides what this means: the standalone
   * customer form navigates to /customers/:id; the lead form swaps the draft to
   * the existing customer in place (preserving the lead draft).
   */
  onOpenExisting: () => void;
  /** Close the dialog and focus the offending input. */
  onEditField: (field: 'email' | 'phone') => void;
  /** Resubmit the create with `override` (parent owns the payload). */
  onCreateAnyway: () => void;
  /** Dismiss the dialog without acting. */
  onClose: () => void;
  /** Drives the spinner on "Create anyway" while the override request is in flight. */
  isOverriding?: boolean;
}

function displayName(c: FullExistingCustomer): string {
  const person = [c.first_name, c.last_name].filter(Boolean).join(' ').trim();
  return c.company_name || person || 'Existing customer';
}

/**
 * Duplicate-customer guard modal (spec §5.1, #42). Mirrors
 * `DuplicateEstimateDialog` for visual + structural consistency, but is purely
 * presentational + delegating: it owns no navigation or resubmit logic, because
 * the two call sites (customer form vs lead form) diverge on "Open existing."
 *
 * Introduces the existing customer, highlights the matched field(s), shows the
 * primary address and active/archived status, and steers the user toward
 * resolution. "Create anyway" is deliberately de-emphasized behind a one-tap
 * confirm.
 */
export function DuplicateCustomerDialog({
  open,
  existing,
  matchedFields,
  onOpenExisting,
  onEditField,
  onCreateAnyway,
  onClose,
  isOverriding = false,
}: DuplicateCustomerDialogProps) {
  if (!existing) return null;

  // #1996 — the requester may not read the matched row. Branch BEFORE deriving
  // matchedEmail/matchedPhone below: this fixture's `matched` values are booleans, and
  // `false != null` is `true`, so the un-branched derivation would highlight a field that
  // never collided.
  if (isRedactedMatch(existing)) {
    // A well-formed wire payload always carries `matched` (duplicateConflictBody always sets
    // it), but a malformed/future one might not — guard with optional chaining rather than
    // trusting the (required-key) type at runtime.
    const matchedEmail = Boolean(existing.matched?.email);
    const matchedPhone = Boolean(existing.matched?.phone);
    const collided =
      matchedEmail && matchedPhone ? 'phone or email' : matchedEmail ? 'email' : matchedPhone ? 'phone' : null;

    return (
      <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-warning" />
              Possible Duplicate Customer
            </DialogTitle>
            <DialogDescription>
              {collided
                ? <>A customer with this {collided} already exists. Ask an admin or dispatcher to link it.</>
                : 'A customer with these details already exists. Ask an admin or dispatcher to link it.'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              {matchedEmail && (
                <Button
                  variant="outline"
                  className="w-full justify-start"
                  onClick={() => onEditField('email')}
                >
                  <Pencil className="mr-2 h-4 w-4" />
                  Edit email
                </Button>
              )}
              {matchedPhone && (
                <Button
                  variant="outline"
                  className="w-full justify-start"
                  onClick={() => onEditField('phone')}
                >
                  <Pencil className="mr-2 h-4 w-4" />
                  Edit phone
                </Button>
              )}
            </div>

            <div className="border-t border-border pt-3">
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  className="text-xs text-text-secondary underline-offset-2 hover:underline"
                  onClick={onClose}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="inline-flex items-center text-xs text-text-secondary underline-offset-2 hover:text-text-primary hover:underline disabled:opacity-50"
                  onClick={onCreateAnyway}
                  disabled={isOverriding}
                >
                  {isOverriding && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
                  Create anyway
                </button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  const archived = !existing.is_active || Boolean(existing.archived_at);
  const addr = existing.primary_address;

  // Prefer the backend's relation-aware match info (`existing.matched`): it knows when a
  // SECONDARY phones[]/extra_emails[] entry matched (which the primary-only `matchedFields`
  // fallback cannot) and carries the exact value that collided, so we highlight/show the
  // value the user actually typed — not the customer's primary.
  const matchedEmail = existing.matched ? existing.matched.email != null : Boolean(matchedFields?.email);
  const matchedPhone = existing.matched ? existing.matched.phone != null : Boolean(matchedFields?.phone);
  const emailShown = existing.matched?.email ?? existing.email;
  const phoneShown = existing.matched?.phone ?? existing.phone;

  const matchedRow =
    'flex items-center gap-2 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-sm';
  const plainRow = 'flex items-center gap-2 px-3 py-2 text-sm text-text-secondary';

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-warning" />
            Possible Duplicate Customer
          </DialogTitle>
          <DialogDescription>
            A customer with the same{' '}
            {matchedEmail && matchedPhone
              ? 'email and phone'
              : matchedEmail
                ? 'email'
                : 'phone'}{' '}
            already exists in your organization.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Existing customer card */}
          <div className="rounded-lg border border-border bg-background-light/50 p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate font-medium text-text-primary">{displayName(existing)}</p>
                <p className="text-xs text-text-secondary">{existing.customer_number}</p>
              </div>
              <span
                className={
                  'shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium ' +
                  (archived
                    ? 'border-neutral-border bg-neutral-surface text-neutral-text'
                    : 'border-success/20 bg-success/10 text-success')
                }
              >
                {archived ? 'Archived' : 'Active'}
              </span>
            </div>

            <div className="mt-2 space-y-1">
              {emailShown && (
                <div className={matchedEmail ? matchedRow : plainRow}>
                  <Mail
                    className={
                      'h-4 w-4 shrink-0 ' + (matchedEmail ? 'text-danger' : 'text-text-secondary')
                    }
                  />
                  <span
                    className={
                      'truncate ' +
                      (matchedEmail ? 'font-medium text-danger' : 'text-text-secondary')
                    }
                  >
                    {emailShown}
                  </span>
                  {matchedEmail && (
                    <span className="ml-auto shrink-0 text-xs font-medium text-danger">matches</span>
                  )}
                </div>
              )}

              {phoneShown && (
                <div className={matchedPhone ? matchedRow : plainRow}>
                  <Phone
                    className={
                      'h-4 w-4 shrink-0 ' + (matchedPhone ? 'text-danger' : 'text-text-secondary')
                    }
                  />
                  <span
                    className={
                      'truncate ' +
                      (matchedPhone ? 'font-medium text-danger' : 'text-text-secondary')
                    }
                  >
                    {formatPhone(phoneShown ?? '')}
                  </span>
                  {matchedPhone && (
                    <span className="ml-auto shrink-0 text-xs font-medium text-danger">matches</span>
                  )}
                </div>
              )}

              {addr && (
                <div className={plainRow}>
                  <MapPin className="h-4 w-4 shrink-0 text-text-secondary" />
                  <span className="truncate">
                    {[addr.line1, addr.city, addr.state].filter(Boolean).join(', ')}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Primary actions */}
          <div className="space-y-2">
            <Button className="w-full justify-between" onClick={onOpenExisting}>
              <span className="flex items-center gap-2">
                <ArrowRight className="h-4 w-4" />
                Open existing customer
              </span>
            </Button>

            {matchedEmail && (
              <Button
                variant="outline"
                className="w-full justify-start"
                onClick={() => onEditField('email')}
              >
                <Pencil className="mr-2 h-4 w-4" />
                Edit email
              </Button>
            )}
            {matchedPhone && (
              <Button
                variant="outline"
                className="w-full justify-start"
                onClick={() => onEditField('phone')}
              >
                <Pencil className="mr-2 h-4 w-4" />
                Edit phone
              </Button>
            )}
          </div>

          {/* De-emphasized override — single click */}
          <div className="border-t border-border pt-3">
            <div className="flex items-center justify-between">
              {/* Deliberately de-emphasized pair: idle text-text-secondary with an
                  underline-on-hover - no minted link/brand or ghost cell reproduces
                  that exact combination (link/brand's idle colour is text-primary,
                  ghost/subtle has no underline). Deferred. */}
              <button
                type="button"
                className="text-xs text-text-secondary underline-offset-2 hover:underline"
                onClick={onClose}
              >
                Cancel
              </button>
              <button
                type="button"
                className="inline-flex items-center text-xs text-text-secondary underline-offset-2 hover:text-text-primary hover:underline disabled:opacity-50"
                onClick={onCreateAnyway}
                disabled={isOverriding}
              >
                {isOverriding && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
                Create anyway
              </button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
