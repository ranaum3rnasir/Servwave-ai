# P0-04 — Root Cause Analysis: DnD Snap-Back (WRONG ENDPOINT)

**Category:** Systemic — DnD Core
**Severity:** P0 (Core workflow broken)
**Date:** 2026-03-18
**Analyst:** Code analysis agent

---

## THE ROOT CAUSE

**The walkthrough reschedule mutation calls the WRONG API endpoint.**

### What happens:

1. User drags walkthrough to new time
2. `handleEventDrop` calls `walkthroughRescheduleMutation.mutate({ leadId, newStart })`
3. Mutation POSTs to: `POST /api/leads/:id/walkthrough` (SchedulePage.tsx line 953)
4. This hits `updateWalkthrough()` handler (lead.controller.ts lines 594-632)
5. That handler ONLY processes `walkthrough_notes` and `walkthrough_duration_minutes`
6. **It completely IGNORES `walkthrough_scheduled_at`**
7. Prisma update runs with `{ walkthrough_notes: undefined, walkthrough_duration_minutes: undefined }` — a NO-OP
8. Backend returns 200 with UNCHANGED lead data
9. `onSuccess` invalidates the query, refetch returns original data
10. Event snaps back to original position

### The CORRECT endpoint is:

`POST /api/leads/:id/walkthrough/schedule` (lead.routes.ts line 34)

This maps to `scheduleWalkthrough()` (lead.controller.ts lines 675-797) which DOES update `walkthrough_scheduled_at`.

### But the correct endpoint has its own problems:

1. **Status guard (line 681):** Only accepts leads in `CONTACTED` or `WALKTHROUGH_COMPLETED` status. A walkthrough being rescheduled is in `WALKTHROUGH_SCHEDULED` status → would get 400 rejected.

2. **Required fields (lines 187-193):** Schema requires `walkthrough_assigned_to` (UUID) + `walkthrough_scheduled_at`. The current mutation only sends `walkthrough_scheduled_at`.

---

## JOB DRAG SNAP-BACK

Jobs use `assignMutation` which calls `POST /api/jobs/:id/assign` — this IS the correct endpoint. But jobs snap back because:

1. Most test jobs reference INACTIVE technicians (`is_active: false`)
2. Backend rejects: "Cannot assign job to an inactive technician" (400 error)
3. The `onError` handler DOES call `setErrorToast()` — so an error toast should appear
4. If the user doesn't see it, the toast may be auto-dismissing too fast or positioned off-screen

**For jobs assigned to ACTIVE technicians** (like Mike Rodriguez), the drag SHOULD work. This needs manual verification.

---

## COMPLETE FIX REQUIRED

### Frontend (SchedulePage.tsx):

**Fix 1 — Change mutation endpoint (line 953):**
```
BEFORE: await api.post(`/api/leads/${payload.leadId}/walkthrough`, { ... })
AFTER:  await api.post(`/api/leads/${payload.leadId}/walkthrough/schedule`, { ... })
```

**Fix 2 — Send all required fields (line 953-955):**
```typescript
await api.post(`/api/leads/${payload.leadId}/walkthrough/schedule`, {
  walkthrough_scheduled_at: payload.newStart,
  walkthrough_assigned_to: payload.performerId,    // from event.raw
  walkthrough_duration_minutes: payload.duration,   // from event.raw
  send_email: false,
  force: true,
});
```

**Fix 3 — Pass performer ID and duration from drop handler (lines 1043-1044):**
```typescript
walkthroughRescheduleMutation.mutate({
  leadId: event.raw.id,
  newStart: startDate.toISOString(),
  performerId: (event.raw.walkthrough_assigned_to || event.raw.assigned_user?.id),
  duration: event.raw.walkthrough_duration_minutes || 60,
});
```

### Backend (lead.controller.ts):

**Fix 4 — Allow rescheduling from WALKTHROUGH_SCHEDULED status (line 681):**
```
BEFORE: if (existing.status !== 'CONTACTED' && existing.status !== 'WALKTHROUGH_COMPLETED')
AFTER:  if (!['CONTACTED', 'WALKTHROUGH_COMPLETED', 'WALKTHROUGH_SCHEDULED'].includes(existing.status))
```

---

## KEY FILE LOCATIONS

| File | Lines | What |
|------|-------|------|
| `frontend/src/pages/SchedulePage.tsx` | 946-979 | `walkthroughRescheduleMutation` — WRONG endpoint |
| `frontend/src/pages/SchedulePage.tsx` | 1006-1048 | `handleEventDrop` — calls mutation |
| `frontend/src/pages/SchedulePage.tsx` | 1050-1079 | `handleEventResize` — same issue |
| `backend/src/controllers/lead.controller.ts` | 594-632 | `updateWalkthrough` — WRONG handler (ignores scheduled_at) |
| `backend/src/controllers/lead.controller.ts` | 675-797 | `scheduleWalkthrough` — CORRECT handler |
| `backend/src/controllers/lead.controller.ts` | 681 | Status guard — needs WALKTHROUGH_SCHEDULED added |
| `backend/src/controllers/lead.controller.ts` | 187-193 | Validation schema — requires assigned_to |
| `backend/src/routes/lead.routes.ts` | 33-34 | Route definitions |

---

## WHY PLAYWRIGHT TESTS SHOWED IT WORKING

Playwright's mouse simulation triggers react-big-calendar's internal DnD system, which fires `onEventDrop` correctly. The mutation fires, the API returns 200 (because the wrong endpoint IS a valid endpoint — it just doesn't update the field). The optimistic update temporarily shows the event at the new position. The test takes a screenshot showing the conflict dialog (from a different event overlap) and declares PASS — without verifying the data actually persisted.

**Lesson: Always verify persistence (refresh + check position), not just visual state.**
