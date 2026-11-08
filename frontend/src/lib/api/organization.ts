import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';
import { toast } from '@/components/ui/use-toast';
import { extractApiError } from '@/lib/utils';
// R5b (2026-07-22) — re-exported (not re-declared) so this and types/entities.ts's PaymentMethod
// can never drift apart the way they did before D3's +4 values surfaced the duplication.
import type { PaymentMethod } from '@/types/entities';
export type { PaymentMethod };

export interface Organization {
  id: string;
  name: string;
  legal_name: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  logo_url: string | null;
  brand_color: string | null;
  estimate_template: string | null;
  estimate_terms: string | null;
  estimate_notes: string | null;
  estimate_payment_terms: string | null;
  invoice_terms: string | null;
  invoice_notes: string | null;
  invoice_payment_terms: string | null;
  stripe_account_id: string | null;
  stripe_charges_enabled: boolean;
  stripe_payouts_enabled: boolean;
  stripe_details_submitted: boolean;
  stripe_requirements_due: string[];
  stripe_disabled_reason: string | null;
  platform_fee_bps: number;
  accepted_payment_methods: PaymentMethod[];
  source_options: string[];
  job_type_options: string[];
  billing_terms_options: string[];
  // Numbering scheme fields
  lead_prefix: string | null;
  estimate_prefix: string | null;
  job_prefix: string | null;
  invoice_prefix: string | null;
  number_padding: number | null;
  lead_next_number: number | null;
  estimate_next_number: number | null;
  job_next_number: number | null;
  invoice_next_number: number | null;
  lead_first_issued_at: string | null;
  estimate_first_issued_at: string | null;
  job_first_issued_at: string | null;
  invoice_first_issued_at: string | null;
  customer_prefix: string | null;
  customer_next_number: number | null;
  customer_first_issued_at: string | null;
  service_plan_prefix: string | null;
  service_plan_next_number: number | null;
  service_plan_first_issued_at: string | null;
  // Org Settings — extended company profile
  display_name: string | null;
  tax_id: string | null;
  business_type: string | null;
  industry: string[];
  support_email: string | null;
  billing_email: string | null;
  timezone: string | null;
  currency: string | null;
  date_format: string | null;
  mailing_same_as_hq: boolean;
  mailing_address_line1: string | null;
  mailing_address_line2: string | null;
  mailing_city: string | null;
  mailing_state: string | null;
  mailing_postal_code: string | null;
  mailing_country: string | null;
  mfa_sms_enabled: boolean;
  mfa_email_enabled: boolean;
  // Org-wide kill switch for outgoing business email (invoices, estimates, job updates, etc.).
  // Default true; login/account-security email is never affected.
  email_sending_enabled: boolean;
  // Org-wide kill switch for outgoing SMS/text (manual Communication replies + Automation
  // Center SEND_TEXT steps, both routed through the same CTM send path). Default true.
  sms_sending_enabled: boolean;
  // Scheduler redesign — org scheduling defaults (Settings UI is PR B).
  default_job_duration_min: number | null;
  default_walkthrough_duration_min: number | null;
  default_schedule_start_time: string | null;
  // Per-org board colours. PARTIAL by design - a missing key means "follow the design system",
  // which is what lets the tokens keep moving under an org that never customised. Resolved by
  // frontend/src/lib/schedule/eventColors.ts; keys mirror EventType in scheduleModel.ts.
  schedule_event_colors: Partial<
    Record<'job' | 'walkthrough' | 'service-plan' | 'calendar-entry', string>
  >;
  // Deposit default (#61)
  deposit_default_type: 'PERCENTAGE' | 'FIXED';
  deposit_default_percentage: number;
  deposit_default_fixed_amount: number;
  // Estimate workspace redesign (§A3a) — org-wide lock-on-send policy, default OFF.
  lock_on_send: boolean;
  // R3 (2026-07-21) cost model (D2/D8) — staff-only, present ONLY for a requester who can see
  // pricing (backend gates these behind canSeePricing, separate from the always-safe base
  // select). Optional here because every other role's GET /api/organization simply omits them.
  labor_rate?: number;
  overhead_mode?: 'PERCENTAGE' | 'FIXED';
  overhead_value?: number;
  // Phone service — read-only connection state (set via connect/disconnect
  // endpoints, never through the settings form). The server computes
  // `phone_connected`; this response never carries the phone account id (only
  // the softphone token payload from POST /communication/phone-access still
  // can, passed through whole to the phone component). Read both through
  // `isPhoneConnected` (lib/api/phoneConnected.ts). Optional only because an
  // old backend does not send it. sms_ready = texting approved.
  phone_connected?: boolean;
  /**
   * @deprecated Do not read directly - use `isPhoneConnected`. The new backend
   * sends `true`/`null` here (never the account id) for one ship, for browsers
   * still on an old bundle. `isPhoneConnected` falls back to it only when
   * `phone_connected` is absent, i.e. this bundle landed before the backend did
   * (the two deploy minutes apart, in no fixed order); an old backend still
   * sends the id string here. TODO(phone-account-id cleanup): drop the key and
   * the fallback once the server stops sending it.
   */
  ctm_account_id?: string | true | null;
  /** Texting approved. Read it through `isSmsReady` (lib/api/phoneConnected.ts).
   *  Optional only because an old backend does not send it. */
  sms_ready?: boolean;
  /**
   * @deprecated Do not read directly - use `isSmsReady`. The old name of
   * `sms_ready`, sent with the same value for one more release.
   * TODO(phone-api-neutral-names): drop with the backend alias.
   */
  ctm_sms_ready?: boolean;
  // Inventory P1 — stock policy (Settings → Inventory).
  default_inventory_location_id: string | null;
  block_negative_stock: boolean;
}

export type OrgFormValues = Omit<
  Organization,
  | 'id'
  | 'logo_url'
  | 'stripe_account_id'
  | 'stripe_charges_enabled'
  | 'stripe_payouts_enabled'
  | 'stripe_details_submitted'
  | 'stripe_requirements_due'
  | 'stripe_disabled_reason'
  | 'platform_fee_bps'
  | 'lead_first_issued_at'
  | 'estimate_first_issued_at'
  | 'job_first_issued_at'
  | 'invoice_first_issued_at'
  | 'customer_first_issued_at'
  | 'service_plan_first_issued_at'
  | 'phone_connected'
  | 'ctm_account_id'
  | 'sms_ready'
  | 'ctm_sms_ready'
>;

export function useOrganization() {
  return useQuery<Organization>({
    queryKey: ['organization'],
    queryFn: () => api.get('/api/organization').then((r) => r.data),
    // Org-level settings (e.g. CTM connection) can change in another admin's
    // session; force a refetch on refocus regardless of the 5min staleTime
    // default so other logged-in admins see it without a manual reload.
    refetchOnWindowFocus: 'always',
  });
}

export function useUpdateOrganization() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<OrgFormValues>) =>
      api.patch('/api/organization', data).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['organization'] }),
    onError: (err) =>
      toast({
        title: 'Save failed',
        description: extractApiError(err, 'Could not save organization settings'),
        variant: 'destructive',
      }),
  });
}

export function useUploadLogo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData();
      fd.append('file', file);
      return api
        .post('/api/organization/logo', fd, {
          headers: { 'Content-Type': 'multipart/form-data' },
        })
        .then((r) => r.data);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['organization'] }),
    onError: (err) =>
      toast({
        title: 'Logo upload failed',
        description: extractApiError(err, 'Could not upload logo'),
        variant: 'destructive',
      }),
  });
}

export interface StripeStatus {
  stripe_account_id: string | null;
  stripe_charges_enabled: boolean;
  stripe_payouts_enabled: boolean;
  stripe_details_submitted: boolean;
  stripe_requirements_due: string[];
  stripe_disabled_reason: string | null;
  platform_fee_bps: number;
  collected_awaiting_payout: number; // §6.6 deferred-bank nudge $X (0 unless charges live + payouts pending)
}

export function useStripeStatus() {
  return useQuery<StripeStatus>({
    queryKey: ['organization', 'stripe-status'],
    queryFn: () => api.get('/api/organization/stripe/status').then((r) => r.data),
    refetchOnWindowFocus: 'always',
  });
}

export function useConnectStripe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post('/api/organization/stripe/connect').then((r) => r.data as { stripe_account_id: string }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['organization'] }),
    onError: (err) =>
      toast({
        variant: 'destructive',
        title: "Couldn't start payments setup",
        description: extractApiError(err, 'Try again.'),
      }),
  });
}

export function useStripeAccountSession() {
  // Returns { client_secret } OR throws with code PAYMENTS_TERMS_ACCEPTANCE_REQUIRED (403).
  return useMutation({
    mutationFn: () =>
      api.post('/api/organization/stripe/account-session').then((r) => r.data as { client_secret: string }),
  });
}

export function useAcceptPaymentsTerms() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api
        .post('/api/organization/stripe/accept-terms', { accepted: true, authority_attested: true })
        .then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['organization'] }),
  });
}

export function useStripeAccountLink() {
  // Hosted Account Link fallback (drawer's second-failure path).
  return useMutation({
    mutationFn: () => api.post('/api/organization/stripe/account-link').then((r) => r.data as { url: string }),
  });
}
