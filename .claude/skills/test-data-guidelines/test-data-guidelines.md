---
name: test-data-guidelines
description: Use when creating, modifying, or reviewing test data — fixtures, factories, seed functions, workflow builders, or E2E test scenarios. Triggers on flaky data, impossible states, unrealistic mock values, or missing audit trails in tests.
---

# Test Data Guidelines

## Overview

Centralized rules for creating consistent, realistic, state-valid test data across all CRM modules. Every mock object must reflect a real-world scenario — correct fields for its status, chronological timestamps, proper role attribution, and realistic values.

## When to Use

- Creating or modifying test fixtures in `backend/src/__tests__/helpers.ts`
- Writing new test files in `backend/src/__tests__/` or `frontend/e2e/`
- Creating workflow builders or seed functions
- Reviewing existing test data for correctness
- Generating mock data for any module

## Mandatory Process

Before creating any test data:

1. **Always read** `rules/global-rules.md` — timestamps, audit trails, roles, math, volumes
2. **Always read** `rules/sla-reference.md` — authoritative timing constraints (expiration, due dates, durations)
3. **Read the relevant module file(s)** from `rules/` for the entities being created
4. **If workflow/E2E test**, also read `rules/workflows.md`
5. **If creating personas or realistic volumes**, read `rules/personas.md`
6. **Apply rules by construction** — use builder patterns that enforce constraints

## Content Map

| File | Read When |
|------|-----------|
| `rules/global-rules.md` | Always — timestamps, audit trails, roles, math, volumes, external IDs |
| `rules/sla-reference.md` | Always — authoritative timing constraints from the codebase (expiration, due dates, durations) |
| `rules/personas.md` | Creating realistic customer or staff data, service requests, addresses, completion notes |
| `rules/customers.md` | Any Customer or ServiceLocation data |
| `rules/leads.md` | Any Lead data |
| `rules/estimates.md` | Any Estimate, EstimateLineItem, or Deposit data |
| `rules/jobs.md` | Any Job or JobCharge data |
| `rules/invoices.md` | Any Invoice or Payment data |
| `rules/walkthroughs.md` | Any walkthrough data (lead-level or job-level), scheduling, conflict detection |
| `rules/attachments.md` | Any Attachment data, file uploads, entity access control |
| `rules/workflows.md` | Multi-module flows or E2E tests |

## Known Violations (Do NOT Replicate)

These patterns exist in current test code and violate business rules:

| Violation | Location | Rule Broken |
|-----------|----------|-------------|
| APPROVED estimate with `signature_data: null` | `helpers.ts` ESTIMATE_APPROVED_FIXTURE | Customers must sign to approve |
| COMPLETED job with `assigned_to: null` | `helpers.ts` invoice job fixtures | Someone must do the work |
| Generic names ("Test Admin", "Test Sales") | `helpers.ts` TEST_USERS | Names should be realistic |
| Hardcoded `service_request: "E2E test ..."` | `workflow-builders.ts` | Service requests should describe real problems |

## Integration Points

| File | Role | Status |
|------|------|--------|
| `backend/src/__tests__/helpers.ts` | Backend unit test fixtures + auth mocking | Needs updating to comply |
| `backend/src/__tests__/setup.ts` | Vitest mock setup (Prisma, Supabase, Stripe) | Good pattern, keep |
| `frontend/e2e/helpers/workflow-builders.ts` | E2E compositional factories | Canonical E2E approach |
| `frontend/e2e/helpers/api-client.ts` | E2E API client (`suffix`, `futureDate()`, `testSignature`) | Good patterns to reference |
| `frontend/e2e/helpers/api-helpers.ts` | Legacy E2E helpers | Superseded by workflow-builders |

## Post-Implementation Evolution Review

This skill is a **living document**. After each worktree/feature branch is completed (at wrap-up), run this review:

**Trigger:** Feature branch finished and about to merge.

**Checklist:**

1. **New entities/statuses?** — Does the new module introduce models, statuses, or transitions not yet covered? → Add or update the relevant module rule file.
2. **New personas needed?** — Does the feature reveal customer or staff scenarios not covered? → Update `personas.md`.
3. **New business rules?** — New validation guards, required fields, or state constraints? → Update the relevant module's valid/invalid sections.
4. **New workflow paths?** — New end-to-end flows or branching points? → Update `workflows.md`.
5. **Date gaps?** — New transitions needing minimum time gap definitions? → Update `global-rules.md`.
6. **Role changes?** — Can new roles perform new actions? → Update role-aware table.
7. **External services?** — New Stripe flows, email triggers, third-party integrations? → Update external ID rules.

**Output:** Update affected rule files and summarize what changed.
