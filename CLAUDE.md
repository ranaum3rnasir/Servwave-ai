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

## Frontend tests: where a test belongs

The suite grew by about 12 files a day and dozens of files mount the job detail page, each with its own fake
server. A brake in `npm run test:ci` now fails the check on growth (`docs/ci.md`), so write tests like this:

1. **Find before you write.** Search for the module's existing test file and add cases to it. A new test
   file needs a reason you can state in one line.
2. **One harness per page.** A page has one shared test harness (render, fake server, providers); do not
   build another per file. Harnesses live in `frontend/src/__tests__/harness/` (the routed job detail page's is
   `jobDetailPage.tsx`); import it, state only what differs, and keep the API client files import-free of each
   other (shared pieces go in `frontend/src/lib/api/shared/`, guard: `api-clients-import-alone.guard.test.ts`).
3. **One mount per state.** Mount a page once per state it can be in and assert everything about that
   state there, not one mount per assertion.
4. **Lowest level that can fail.** Test a rule at the pure function or hook that owns it; mount the page
   only for what only the page can break.
5. **No real timer over 100 ms and no absence proof by a rejected `findBy`.** Use fake timers; to prove
   something is absent, wait for the thing that replaces it, not for a `findBy` to time out.
6. **Scale with the smallest number that crosses the threshold.** To test "more than 50 rows" use the
   fewest rows that cross the line (or lower the threshold through the module's own parameter).
7. **The budget.** The check judges what your change does, not totals. A test over 2 s, or a file over 10 s of
   body time, in a file you added or changed fails. A page fails its ceiling in `frontend/test-page-ceilings.json`
   only if you add test files mounting it and it is then over (a new page starts at 3). `maxTestFiles` in
   `frontend/test-file-count.json` moves with your file count in the same diff: add k test files, raise it by k;
   delete, lower it. That is bookkeeping, not a raise, and it lives in its own file so that moving it does not
   force a full Frontend run. What Ran reviews are the raises in `frontend/test-budget.json` (CPU-seconds,
   minutes), a page ceiling, the over-the-line list. Do not raise those to get green. (CPU over budget only warns while
   `cpuEnforcement` is `"warn"`.)

A builder's report carries one line: `tests added to: <file>` or `new file because: <reason>`; the
verifier checks it.

## Agent skills

### Every PR carries a video proof

Ran reviews a PR by watching it work, not by reading the diff. Every PR that changes something a person can see
or do in the app gets a recorded run of the change in the real app, with a check per scenario, posted as a PR
comment: see the `pr-video-proof` skill. Record only on a deploy of the PR's own code, so today that means
staging right after the merge (the PR body says the video follows the merge). The promotion PR to `main` links
each change's video. A PR with nothing to show says "No video: <reason>" in its body.

### Issue tracker

GitHub issues on `ranro1/ALPHA_CRM`, via the `gh` CLI; every issue gets one priority and one module label. Feature ideas stay in Linear. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical labels are used as-is (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` (glossary) and `docs/adr/` at the repo root, kept short. See `docs/agents/domain.md`.
