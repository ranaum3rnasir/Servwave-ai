# ServWave - Project Rules

## Boundaries (IMPORTANT - hold on every task)

### No vendor or customer names in anything a user can see

Third-party vendors (CTM / CallTrackingMetrics, Supabase, Render, and the like) and real company
names (Alpha Doors and Security, and the like) must never appear in rendered copy, page titles,
toasts, tooltips, empty states, badges, placeholders, API error messages that surface to the UI,
the DOM, or user-visible URLs. Every capability is presented as ServWave's own: it is the ServWave
phone service, not a connected CTM sub-account.

Vendor names remain legitimate in: backend integration code, env vars, DB column names, internal
route paths, webhook handlers, SDK imports, and code comments that explain an integration. Those
are how the system actually talks to the vendor, and stripping them makes the integration
unmaintainable.

Real customer names are banned everywhere in the repo, code comments included. Use the org id or a
neutral placeholder.

Practical consequences:
- Never render a vendor account identifier. If a screen needs to prove a connection, show a status
  ("Active"), never an ID.
- Never tell the customer that something is configured in a vendor's dashboard. Point them at
  ServWave support instead, or say nothing.
- An error thrown in the backend that reaches the UI through `extractApiError` is user-visible copy.
  De-brand the throw site, not just the component.

### No passwords in the repo, EVER (CRUCIAL)

A seed script once committed four real customer passwords in plaintext, and they reached an
outside team's copy of this repo. Therefore:
- Never write a password, token or key as a literal anywhere in the repo: code, scripts, seeds,
  tests that create real accounts, docs or fixtures. Read it from the environment and fail when it
  is unset, or generate a random one at run time (see `backend/src/lib/e2e-org.ts`).
- Never seed, import or provision a REAL user with a password we choose. Real users get an invite
  or a password-reset email and set their own.
- The `hardcoded-password` rule in `.gitleaks.toml` fails CI on any password literal outside
  automated tests. Never allowlist a real password to make it pass.

### No company-specific files (CRUCIAL)

No file in any repo may exist for one customer company: no `seed-<company>.ts`, no
`<company>-import/` script folder, no onboarding doc named after a customer. Onboarding,
imports and provisioning are generic tools driven by input data that stays outside the repo.

### Accounting integrations read ONLY what ServWave created (CRUCIAL - a published promise)

ServWave's public privacy policy promises customers that the QuickBooks (and any future accounting)
integration reads back only: the company name and preferences, the chart of accounts, items, payment
methods, terms, and the ids/version numbers of records ServWave itself created. It promises we never
read bank transactions, payroll, vendor bills, or any customer, invoice, payment or other record that
ServWave did not create, and that accounting data is used solely to run the integration (no
analytics, no model training, no sharing).

Therefore, in every piece of integration code:
- Every read of a transaction or customer record from the accounting provider must be filtered to
  ids present in `quickbooks_mappings` for that org. The nightly change sweep (the Change Data
  Capture call that asks "what changed since last night") is filtered to mapped ids before anything
  is stored or acted on; unmapped entities in the response are discarded, never logged with content.
- Never query by name, never list a customer's transactions, never call report endpoints, never
  fetch an entity ServWave did not create, even to "help" matching. The one exception is the
  first-connect match review, which reads customer and item NAMES only, with the user's consent
  screen in front of it.
- Reference data reads are limited to the list above. No Bill, Purchase, Deposit-not-ours,
  JournalEntry, Employee, Vendor, TimeActivity or report reads.
- Accounting data is never fed into analytics, copilots, prompts, exports or cross-org aggregates.
- Tokens are encrypted at rest with the key outside the database, never rendered, never logged.
- Disconnect revokes at the provider and deletes tokens immediately; mapping ids stay only to
  prevent duplicates on reconnect and must be purgeable per org on request.

A PR that widens what the integration reads is a privacy-policy change first and a code change
second: stop and raise it with Ran before writing it.

## Servy (the AI copilot) is NOT working

**Servy does not work at all.** No user reaches it. Every "BUILT / SHIPPED / all gates green" claim
about Servy in the memory files or the git history is historical, not current.

**Therefore:** never file issues, write specs, or raise findings about copilot internals -
`backend/src/services/copilot/*` (including `capability-registry.ts` and `persona.ts`), the voice
transport, or the tool bridge - as though they were live user-facing defects. A stale, wrong, or
dead entry in the capability registry is not a bug worth a ticket, because nothing user-facing
consumes it.

If Servy work is genuinely needed, ask Ran first whether the copilot is being revived.

## Bugs: check the Obsidian vault first

Before diagnosing a bug, search the Obsidian vault (`/Users/ranroffe/ALPHA_CRM/Vault/ALPHA_CRM_VAULT`,
via `mcp__obsidian__search_notes`, or `grep -ril` on the path when the MCP is unavailable) for the
symptom, error text, module and service involved. Look first in `Learnings/` (known traps and misleading
signals), then `Decisions/`, `Architecture/` and `Modules/<Module>.md`. Many "new" bugs repeat a recorded
lesson, and a recorded Decision can make the reported behaviour intended. Cite any note that shaped the
diagnosis; a note is a lead to verify against the code, not proof.

## Heavy test runs

Before running test suites, typechecks, builds or verifier runs, read the vault note
`Workflows/Remote-Test-Runner/Remote-Test-Runner.md` and follow it.

## Agent skills

### Issue tracker

GitHub issues on `ranro1/ALPHA_CRM`, via the `gh` CLI; every issue gets one priority and one module label. Feature ideas stay in Linear. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical labels are used as-is (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` (glossary) and `docs/adr/` at the repo root, kept short. See `docs/agents/domain.md`.
