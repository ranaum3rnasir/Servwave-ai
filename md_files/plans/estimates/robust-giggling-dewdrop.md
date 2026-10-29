# Fix: Edit Lead Form Not Pre-Populating Select Fields

## Context
When editing a lead, the "Job Type" and "Job Source" dropdowns show placeholders ("Select type...", "Select source...") instead of the existing values (e.g., "Plumbing", "Referral"). The detail page shows the correct data, but the edit form doesn't pre-populate it.

**Root cause:** `EditLeadForm` mounts before the lead data loads. `useForm` is initialized with no `defaultValues`. The Radix UI `Select` component (used by shadcn/ui) renders first with `value=""`, and when `form.reset()` later pushes the real value, the `Select` doesn't visually update its displayed label — a known Radix controlled-value timing issue.

**Affected fields:**
- `job_type` — `Select` component, **broken**
- `job_source` — `Select` component, **broken**
- `service_address_line1` — `AddressAutocomplete` with `form.watch()`, **potentially broken** (same pattern)
- All other fields use `form.register()` directly and work fine

## Fix

**File:** `frontend/src/pages/LeadFormPage.tsx`

### Change 1: Don't render `EditLeadForm` until data is loaded (lines 123-133)

Move the loading/error guard into `LeadFormPage` so `EditLeadForm` only mounts once `lead` is available:

```tsx
if (isEdit) {
  if (isLoading) return <div className="p-8 text-center text-muted-foreground">Loading...</div>;
  if (!lead) return <div className="p-8 text-center text-muted-foreground">Lead not found</div>;
  return (
    <EditLeadForm
      lead={lead}
      leadId={id!}
      navigate={navigate}
      queryClient={queryClient}
    />
  );
}
```

### Change 2: Initialize `useForm` with `defaultValues` (lines 478-500)

Since `lead` is now guaranteed to exist when `EditLeadForm` mounts, initialize the form directly:

```tsx
const form = useForm<EditFormData>({
  resolver: zodResolver(editSchema),
  defaultValues: {
    service_request: lead.service_request as string,
    notes: (lead.notes as string) || '',
    job_type: (lead.job_type as string) || '',
    job_source: (lead.job_source as string) || '',
    scheduled_date: extractDate(lead.scheduled_start as string | null),
    scheduled_time: extractTime(lead.scheduled_start as string | null),
    scheduled_end_date: extractDate(lead.scheduled_end as string | null),
    scheduled_end_time: extractTime(lead.scheduled_end as string | null),
    service_address_line1: (lead.service_address_line1 as string) || '',
    service_address_line2: (lead.service_address_line2 as string) || '',
    service_city: (lead.service_city as string) || '',
    service_state: (lead.service_state as string) || '',
    service_zip: (lead.service_zip as string) || '',
  },
});
```

Remove the `useEffect` + `form.reset()` block entirely (lines 482-500) — no longer needed.

### Change 3: Update `EditLeadForm` props type

Remove `isLoading` from the props since it's no longer passed:

```tsx
function EditLeadForm({
  lead,
  leadId,
  navigate,
  queryClient,
}: {
  lead: Record<string, unknown>;  // no longer optional
  leadId: string;
  navigate: ...;
  queryClient: ...;
}) {
```

### Change 4: Remove loading/not-found guards inside EditLeadForm

If `EditLeadForm` has its own `isLoading` / `!lead` checks, remove them — they're now handled by the parent.

## Verification
1. Navigate to a lead with job_type and job_source set → click Edit → both dropdowns should show the correct values
2. Navigate to a lead without job_type/job_source → click Edit → dropdowns should show placeholders
3. Edit and save → verify values persist
4. Check address field also pre-populates correctly
