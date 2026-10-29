# If Option B (LO-to-billing bridge) is chosen: shape of the card to cut

Reference: `docs/adr/0004-inventory-billing-bridge.md`, "The one open question: build Option B?" and
"If the answer is B" sections. This file holds the card-body content that does not belong in the ADR
itself - sizing, TDD discipline and a back-compat note. Paste this into the Linear card when the answer
is B; verify the file:line references still hold at that time.

**(c) Backend TDD is mandatory.** The first test asserts that returning a processed LO removes or
reverses the generated billing line, and it must be red before the write exists.

**(d) Sizing is XL, not L.** A migration adding `logistic_order_line_id` to `job_line_items` plus an
org-setting column; a write inside the LO process transaction; and mirrored handling in both reversal
paths.

**(e) Compat sample.** 3 fossil stock movements on staging still carry a billing-line id from the
pre-LO-4 sync-stock era, which is a real migration and back-compat sample for whoever builds this.
