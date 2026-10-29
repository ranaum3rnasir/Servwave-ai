# Plan: Add Lead Edit Dialog

## Context
The lead detail page currently displays lead information as read-only text. The user wants to be able to edit a lead after it was created. We need an "Edit" button on the lead detail page header that opens a dialog to edit lead fields.

## Approach
Create a new `EditLeadDialog` component (simpler than the create dialog — no customer search needed, just edit the lead's own fields). Add an "Edit" button to the LeadDetailPage header.

### New file: `frontend/src/components/leads/EditLeadDialog.tsx`

A dialog form with these editable fields (matching what `PATCH /api/leads/:id` accepts via `updateLeadSchema`):
- **Service Request** (textarea, required)
- **Notes** (textarea, optional)
- **Job Type** (select dropdown — same options as create form)
- **Job Source** (select dropdown — same options as create form)
- **Schedule:** Start date/time, End date/time
- **Service Address:** address_line1, address_line2, city, state, zip

Props: `{ open, onOpenChange, lead }` where `lead` is the full lead object from the detail query.

On open, populate all fields from `lead`. On save, `PATCH /api/leads/:id` with changed fields. On success, invalidate `['lead', id]`.

Reuse the same `JOB_TYPES` and `JOB_SOURCES` arrays from `LeadFormDialog.tsx` — extract or duplicate (duplicate is simpler for 2 small arrays).

### Modified file: `frontend/src/pages/LeadDetailPage.tsx`

- Import `EditLeadDialog`
- Add `editOpen` state + `Pencil` icon import
- Add "Edit" button in the header actions (next to Assign/Mark Lost), visible for ADMIN, DISPATCHER, SALES (same roles that can access lead PATCH)
- Render `<EditLeadDialog>` at bottom with the dialogs

### No backend changes needed
`PATCH /api/leads/:id` already handles all these fields via `updateLeadSchema`.

## Verification
1. Click Edit on lead detail → dialog opens with current values populated
2. Change service request + notes → save → detail page reflects changes
3. Change schedule/service address → save → updated
4. SALES can only edit own leads (backend enforces this)
5. `npx tsc --noEmit` from frontend — clean
6. `npm test` from backend — all 92 tests pass
