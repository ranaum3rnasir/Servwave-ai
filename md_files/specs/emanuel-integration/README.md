# Emanuel Integration — PRD Reference Package

This folder is the **intent documentation** for the two modules Emanuel Dahan
prototyped and we ported into ALPHA CRM (Inventory + Price Book + Purchase
Orders, and the Phone + AI Communication module). It was extracted from the
`emanuel` branch's `price_book_prd_for_crm/` prototype project — **only the PRD
files were kept**; the prototype source (already ported), its committed
`node_modules`, and the explainer-video renders were left behind.

Use these docs to understand *what Emanuel intended* before we wire the ported
UI to real backends.

## Contents

### PRDs (the core)
- **`inventory-price-book-po-PRD.md`** — Inventory + Price Book + Purchase
  Orders PRD. v1.1 Draft (rev 2026-05-26). Synthesized from 9-agent research +
  an Emanuel interview; the v1.1 section is "UX Increment Locked from
  Prototype" (binding on the build). ~4,600 lines. Sections marked
  `[PROTOTYPE v1.1]` are locked from the interactive prototype we ported.
- **`phone-communication-PRD.md`** — Phone System + AI Communication PRD.
  Draft for build, Phase 1 MVP (rev 2026-05-30). Every requirement traces to a
  research report (R01–R08) or a locked decision row (F/D/I/E) in
  `phone-working/decisions-log.md`.

### Phone working docs (`phone-working/`)
The trail the Phone PRD cites inline:
- `decisions-log.md` — the F/D/I/E decision rows referenced as `[F3]`, `[D1]`, etc.
- `gap-log.md` — known gaps / unresolved items
- `interview-transcript.md` — source interview
- `open-questions.md` — outstanding questions
- `synthesis-notes.md` — research synthesis

### Research (`research-inventory/`, `research-phone/`)
The 19 background research PDFs the PRDs were synthesized from (competitor
teardowns, voice-of-customer, integrations, mobile UX, pricing, telephony &
compliance, AI call intelligence, SMS, WhatsApp, etc.). Reference/evidence only.

> **Note — two stray PDFs.** `research-phone/` contains two files that appear
> unrelated to the phone module and were almost certainly misfiled in Emanuel's
> source folder: *"Pilot Plan for a Digital Mental Health Intervention for Adults
> With Moderate Depression.pdf"* and *"Product Management Transition Program
> Plan.pdf"*. Ignore them — they are not phone-system research.

## What was deliberately NOT brought over
- `price_book_prd_for_crm/dashboard/` — the React prototype (already ported into
  ALPHA's Inventory + Communication modules on `feat/emanuel-design-system`)
- `price_book_prd_for_crm/viewer/` — a standalone PRD viewer app
- `price_book_prd_for_crm/video/` — Remotion explainer-video project + renders
- the committed `node_modules/` (~43k files)
