# RAN-03 — Walkthrough Snap-Back: Position Unchanged After Refresh

**Tester:** Ran
**Date:** 2026-03-18
**Severity:** P0 (Data not persisting despite 200 response)

## Test Performed
1. Dragged a walkthrough event to a new time in standard calendar view
2. Event visually snapped back to original position
3. Waited, then refreshed the page (F5)
4. After refresh: walkthrough is at the ORIGINAL position, not the new position

## What This Means
The API returned 200 (success) but the data did NOT persist. Two possible explanations:

1. **The 200 response is from the wrong endpoint.** The walkthrough reschedule may be calling an endpoint that returns 200 but doesn't actually update the `walkthrough_scheduled_at` field. Check if the mutation URL and payload are correct.

2. **The mutation sends wrong data.** The `walkthroughRescheduleMutation` sends `{ leadId, newStart }` but the API may require additional fields (e.g., `walkthrough_assigned_to`, `walkthrough_duration_minutes`) and silently ignores partial updates.

3. **The 200 was a different API call.** The Network tab showed two calls: `walkthrough` (200) and `leads?walkthrough_after=...` (304). The 200 may have been a GET refetch, not the POST mutation. Need to verify the HTTP method of the 200 response.

## Impact
CRITICAL. If drag-to-reschedule doesn't actually save, the entire DnD workflow is broken at the data layer — not just the UI layer. Dispatchers would think they rescheduled a walkthrough but it stays at the old time.

## For Dev Team
1. Add `console.log` to `walkthroughRescheduleMutation.mutationFn` to verify the exact URL, method, and payload being sent
2. Check the backend endpoint — does it actually update `walkthrough_scheduled_at`?
3. Verify the 200 response body contains the updated walkthrough data
