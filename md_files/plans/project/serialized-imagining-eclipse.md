# Plan: Send Approval Confirmation Email to Customer

## Context
When a customer approves an estimate on the public page, the internal sales rep gets notified via email — but the customer gets nothing beyond a green banner on the page. This creates a trust gap. We're adding a confirmation email to the customer with their approved estimate details and line items, so they have a written record and know what to expect next.

## Changes

### 1. Add `sendApprovalConfirmationToCustomer()` in `backend/src/lib/email.ts`
- New email function following the same pattern as the existing 3 functions
- **Recipient:** Customer email (from estimate → lead → customer)
- **Subject:** `Estimate {number} — Approved`
- **HTML body:**
  - Header: "Your Estimate Has Been Approved"
  - Estimate number + approval date
  - Line items table (description, qty, unit price, line total)
  - Subtotal, discount (if any), tax, **total**
  - Next steps message: "Our team will be in touch shortly to schedule your service."
  - "View Estimate" button linking to the public page
- **Plain text fallback** included
- Fire-and-forget (same pattern as existing notifications — no `await`, caught errors logged)

### 2. Call it from `approvePublic()` in `backend/src/controllers/estimate.controller.ts`
- After the existing `sendApprovedNotification()` call (~line 948)
- Fetch customer email from the estimate's lead → customer relationship (already available in the query)
- Only send if customer has an email address (it's nullable)

### 3. Add unit test in `backend/src/__tests__/estimates.test.ts`
- Test that `sendApprovalConfirmationToCustomer` is called with correct params when customer has email
- Test that it's skipped when customer email is null

## Files to Modify
- `backend/src/lib/email.ts` — add new function
- `backend/src/controllers/estimate.controller.ts` — call new function in `approvePublic`
- `backend/src/__tests__/estimates.test.ts` — add 2 tests

## Reuse
- Follow exact same HTML template structure as `sendEstimateEmail()` (already has line items table rendering)
- Same fire-and-forget pattern as `sendApprovedNotification()` / `sendDeclinedNotification()`
- Same Resend client instance from `email.ts`

## Verification
1. `npm test --workspace=backend` — all tests pass (existing 289 + 2 new)
2. Manual: approve an estimate on public page → check Resend dashboard for the customer email delivery
