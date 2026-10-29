# Invoice Send: Email Honesty + Decoupled Payment Link

Date: 2026-07-23
Module: invoices
Type: bug fix (misleading success) + small feature (payment link without email)
Branch: worktree off `origin/main`, PR into `staging` first.

## Problem (reported)

"Send invoice" shows a green "Invoice sent" toast, but no email is delivered and
Resend's logs are empty.

## Root cause (verified against the live staging DB)

Two independent defects stack:

1. Config state (the immediate cause): the reporter's org "Alpha Doors & Security"
   (`d40afcec-0ddf-471f-b99d-8e5f23cbdadf`) has `email_sending_enabled = false`. That
   flag is the org-wide kill switch checked in `dispatchEmail` (`backend/src/lib/email.ts:41`)
   BEFORE any Resend call, so the send returns `{status:'skipped', reason:'org_disabled'}`
   and no request ever reaches Resend. This affects every business email for the org
   (invoices, estimates, receipts, POs), not just invoices. Confirmed: "ServWave Test"
   is also off; B&G Cabinet, Talon, and the e2e orgs are on.

2. Code defect (why it is silent and misleading):
   - `invoice.controller.ts` `send()` fires `sendInvoiceEmail(...)` fire-and-forget
     (line ~1163) and then unconditionally returns `res.json({ invoice })` (line ~1199).
     The success toast fires on that 200 regardless of what happened to the email.
   - `sendInvoiceEmail` (`email.ts:1798`) awaits `dispatchEmail` but DISCARDS its
     `{status}` result, then logs `"Invoice email sent"` (line ~1868) and persists a
     `persistTransactionalEmail` communication-history record even when the dispatch was
     skipped/failed. So even the backend log and the comm history lie.

The estimate send path (`estimate.controller.ts` `send()` + `mapEmailFailure` at line 1742)
and the PO send path already handle this correctly (they await the result, return
409/502 when not actually sent, and do not flip status). The invoice path is the lone
outlier. The core-pipeline QA gate doc even lists `POST /api/invoices/:id/send` as
expected to honor the toggle; it currently does not.

## Decisions locked (with Ran)

- Leave the org email toggle OFF (still in dual-run validation). We are not flipping it.
- When email is off or fails: the invoice must NOT transition DRAFT -> SENT. Block the
  send and return a clear error. Consistent with estimates and POs.
- Notification style: reactive only (surface the message when the user attempts to Send).
  No proactive banner, no disabled Send button. (Estimate-dialog style, not PO-dialog style.)
- Notification content: make clear the toggle is org-wide, it affects ALL outgoing email,
  and an admin must turn it back on in Settings -> Company Profile.
- The public/pay link must be available even when no email is sent. Ran chose a PAYABLE
  link, accepting that generating it marks the invoice as issued (status -> SENT), because
  a payable link inherently requires the invoice to be issued (see feasibility note).

## Feasibility note: view vs pay on the public link

- `getPublic` (`invoice.controller.ts:1714`) requires only a valid `public_token`; there
  is no status check, so a DRAFT with a token is viewable.
- `createPublicCheckout` (`invoice.controller.ts:1859`) requires `status IN (SENT, PARTIAL)`;
  a DRAFT is intentionally "not payable" because a DRAFT is still editable (its amount can
  change). This guard stays.
- Therefore a PAYABLE link requires the invoice to be issued, and "issued" is the SENT
  status in this system. To honor "a blocked email must not flip to SENT" AND "the link
  must be payable", the link gets its own explicit, un-gated action distinct from the
  email send. Generating the link is a deliberate publish, not a side effect of a failed
  email.

## Implementation

### Backend

1. `backend/src/lib/email.ts` - `sendInvoiceEmail`
   - Change return type `Promise<void>` -> `Promise<EmailDispatchResult>`.
   - `const result = await dispatchEmail(...)`.
   - Gate the `logger.info('Invoice email sent ...')` AND the `persistTransactionalEmail`
     call on `result.status === 'sent'`.
   - `return result`; in the `catch`, `return { status:'failed', error }`.
   - This mirrors `sendEstimateEmail` exactly and fixes the false log + phantom comm record.

2. `backend/src/controllers/invoice.controller.ts` - `send()` (3-phase, mirror estimate)
   - PREP: resolve `to` (keep the existing hard 400 when absent). Compute `dueDate`. Mint
     `publicToken`. Derive customer/name/totals from the already-fetched `invoice` row.
     Do NOT mutate status yet.
   - EMAIL: `const emailResult = await sendInvoiceEmail(...)`. Build `publicUrl` from
     `invoice.id` + `publicToken`.
   - If `emailResult.status !== 'sent'`: `mapInvoiceEmailFailure(emailResult)` -> return
     409/502. No status flip, no timeline event, no audit, no automation dispatch.
   - COMMIT: `$transaction` -> status SENT, `sent_at`, `public_token`, `due_date` +
     INVOICE_SENT timeline. After commit: `logAudit` + `dispatchAutomationEvent`.
     `res.json({ invoice })`.

3. `backend/src/controllers/invoice.controller.ts` - `resend()`
   - Same shape: `await` the email first; if not `'sent'`, return 409/502 without updating
     `sent_at` or writing the INVOICE_RESENT timeline. Token already exists; reuse it.

4. `backend/src/controllers/invoice.controller.ts` - new helper `mapInvoiceEmailFailure`
   (mirror `estimate.controller.ts:1742`). Accept a flag for send vs resend wording.
   - `org_disabled` -> 409:
     "Email is turned off for your whole organization, so no invoice email was sent. This
      affects all outgoing email - an admin can turn it back on in Settings -> Company
      Profile. The invoice was not marked as sent." (resend variant: "was not resent.")
   - `no_api_key` -> 502: "Email is not configured, so the invoice was not sent."
   - `failed` -> 502: "The invoice could not be emailed to the customer, so it was not
     marked as sent. Please try again."

5. NEW action: issue-without-email -> payment link
   - Route (`backend/src/routes/invoice.routes.ts`):
     `router.post('/:id/payment-link', canDo('send','Invoice'), invoiceController.createPaymentLink);`
     (No body; same permission as send. NOT gated by the email toggle.)
   - Controller `createPaymentLink`:
     - Load invoice (`invoiceDetailSelect`); `canAccessRow` check like `send`.
     - VOIDED -> 400 "Cannot create a payment link for a voided invoice."
     - If `public_token` already set (SENT/PARTIAL/PAID): return the existing
       `{ invoice, url }` (idempotent, no re-transition, no new timeline/automation).
     - If DRAFT: compute `dueDate`, `$transaction` -> status SENT, `sent_at`,
       `public_token` (mint), `due_date` + timeline "Payment link created (invoice issued)".
       After commit: `logAudit` + `dispatchAutomationEvent(INVOICE_SENT)` (consistent with
       send, since the invoice is now issued to the customer). Return `{ invoice, url }`.
   - `url` = `${FRONTEND_URL}/p/invoices/${invoice.id}?token=${public_token}` (frontend can
     also rebuild from the returned token, matching the existing copy-link handler).

### Frontend

6. `frontend/src/pages/InvoiceDetailPage.tsx` - "Copy payment link" always available
   - Show a "Copy payment link" menu item for any non-voided invoice (today it is gated on
     `canCopyLink = !!invoice.public_token`, so it never appears pre-send).
   - Handler:
     - If `invoice.public_token` present: copy the URL as today.
     - Else: `await api.post('/api/invoices/:id/payment-link')`, invalidate the invoice
       query (status flips to Sent, token now present), then copy the URL from the
       response token.
   - Toast: "Payment link created and copied - the invoice is now marked as Sent."
   - Clipboard robustness: attempt `navigator.clipboard.writeText` immediately after the
     mutation resolves; if it fails, the menu now shows the plain copy item (token present)
     as a fallback.
   - Add a matching client call in `frontend/src/lib/api/invoices.ts`
     (`createInvoicePaymentLink(id)` -> `api.post(/api/invoices/${id}/payment-link)`), and a
     small mutation/hook consistent with the file's existing patterns.

7. `frontend/src/components/invoices/SendInvoiceDialog.tsx` - NO code change
   - The existing `onError` toast (destructive, `duration: Infinity`, shows
     `err.response.data.error`) already surfaces the backend 409 message. It was simply
     never reached because the backend always returned 200. The 200-only-on-real-send
     backend change makes `onSuccess` (green toast) fire only for real sends and `onError`
     fire for skipped/failed.

## Tests (backend, TDD-first)

Add to `backend/src/__tests__/invoices.test.ts` (mirror how it mocks email dispatch;
cross-check `email-dispatch.test.ts` for the mock shape):

- `send`, org email OFF -> 409, invoice remains DRAFT (status unchanged, `public_token`
  null, no INVOICE_SENT timeline event, no automation dispatch).
- `send`, email dispatched -> 200, status SENT, `public_token` set.
- `resend`, org email OFF -> 409, `sent_at` unchanged, no INVOICE_RESENT timeline.
- `payment-link` on a DRAFT with org email OFF -> 200, status SENT, `public_token` minted
  (proves the link path is NOT gated by the toggle).
- `payment-link` on an already-SENT invoice -> 200, returns the existing token, no second
  transition (idempotent).

Optional unit coverage in `email-dispatch.test.ts`: `sendInvoiceEmail` returns the
dispatch result and does not log "sent" / does not persist a comm record when the dispatch
is skipped.

## Out of scope / notes

- We are not flipping `email_sending_enabled`; the org stays off by choice.
- Estimate and PO paths already behave correctly and are unchanged.
- The `send`/`resend` email is HTML-only (no PDF attachment), so awaiting the dispatch adds
  a negligible round trip - acceptable, and matches how estimate send already awaits.

## Rollout

- Bug-fix flow (CLAUDE.md): worktree off `origin/main` under `../alpha_crm-worktrees/`.
- One PR into `staging`; PR body: `Fixes #<n>` once an issue is filed via `/to-issues`.
- No DB migration required (`public_token`, `email_sending_enabled`, statuses already exist).
