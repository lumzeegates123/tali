# Product Principles

These principles guide product and engineering decisions. When two options conflict, the principle listed
earlier generally wins.

## 1. Trust before convenience

Owners must be able to trust every number Tali shows. A slower flow that is correct beats a fast flow that is
sometimes wrong. We never trade financial correctness, auditability or privacy for speed of delivery.

## 2. AI proposes, people and rules decide

AI removes typing, not judgement. AI interprets, extracts, classifies, summarizes, recommends and proposes.
Anything that changes money, stock, obligations or commitments to third parties is confirmed by an authorized
person and recorded by deterministic software. AI never confirms or settles. Automatic confirmation by
deterministic rules is not part of the MVP and requires a later accepted ADR after measured validation.
AI authority is defined in `.cursor/rules/40-ai-safety.mdc`.

## 3. Meet businesses where they already work

Owners already use their phone, WhatsApp, voice notes and photos. Tali should accept input from those
channels and turn it into structured records, rather than forcing people into complex forms.

## 4. Simple language, rigorous core

Users see plain language ("You sold 12 items today", "Ada owes you 5,000"). Underneath, Tali keeps a proper
double-entry ledger, movement-based inventory and a full audit trail. Complexity is hidden, never skipped.

## 5. Every number is explainable

For any balance, stock level or report figure, a user should be able to drill down to the transactions,
the evidence (receipt, message, bank line) and who confirmed it.

## 6. Mistakes are corrected, not erased

Users make mistakes. Tali makes correction easy through reversals and adjustments, while preserving history.
Nothing financial disappears silently.

## 7. Each business's data belongs to that business

Strict isolation between businesses. Staff see only what their role allows. Data is not shared with third
parties (including AI providers and financial partners) without a clear purpose, minimization and consent where
required.

## 8. Show confidence and ask when unsure

When AI or matching logic is uncertain (unclear amount, ambiguous customer, payment that could match two
invoices), Tali says so and asks. It never guesses silently on financial facts.

## 9. Works in real conditions

Design for small screens, intermittent connectivity, shared devices, multiple languages and users with varying
literacy and digital experience. Performance and clarity on low-end Android phones matter.

Trading must not stop when the network drops. Permitted everyday operations work offline, and the app is always
honest about where a record stands: **saved locally**, **synced to Tali**, **needs attention**, or **externally
verified**. Tali never presents a locally saved record as synced, or a synced record as verified. A sale that
really happened offline is never lost because the catalog changed in the meantime.

## 10. Small, useful, reliable increments

Ship a narrow, reliable core first and widen it. Every feature should reduce real work for the owner or
increase their confidence in their numbers.

## 11. Partners for regulated services

Payments, lending, savings and insurance are delivered with licensed partners, behind clear interfaces, with
explicit consent and full auditability. Tali does not act as a regulated institution unless and until an
explicit decision is made to do so.
