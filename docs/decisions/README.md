# Architecture Decision Records (ADRs)

This directory records significant technical and architectural decisions for Tali, so that current and future
engineers and AI agents understand **what** was decided, **why**, and **what alternatives were rejected**.

## When an ADR is required

Write an ADR before implementing any of the following:

- Creating a microservice, separately deployed service, or splitting the modular monolith.
- Adding a datastore (database, cache used as source of truth, search engine, vector store, queue/broker).
- Choosing or changing core technology: web framework, ORM/query layer, database engine, validation library,
  authentication provider, hosting/cloud provider, frontend/mobile framework.
- Choosing the money/decimal abstraction or changing how money is represented.
- Choosing inventory valuation method or chart-of-accounts approach.
- Adding an external provider: payment provider, bank feed, WhatsApp/messaging provider, AI/LLM, speech, OCR, storage.
- Partnering with a regulated financial institution or launching any embedded financial service.
- Allowing any automated confirmation, auto-reconciliation rule, or AI autonomy beyond proposing.
- Introducing a language other than TypeScript for application code.
- Changing or relaxing any architecture rule in `AGENTS.md` or `.cursor/rules/` (product-scope changes may instead be
  authorized by an explicitly APPROVED product decision in `docs/product/mvp-scope.md`; see `AGENTS.md` section 4).
- Enabling any automatic deterministic financial confirmation (only after measured validation; AI may never confirm).
- Breaking changes to public APIs or data contracts.
- Target market decisions that affect data or compliance (currencies, tax, data residency).

If unsure, write one. ADRs are short.

## Process

1. Copy the template below into a new file `NNNN-short-title.md` (next sequential number, zero-padded to 4 digits,
   kebab-case title), e.g. `0001-record-architecture-decisions.md`.
2. Set status to `Proposed`. Open a PR containing only the ADR (or the ADR plus a spike).
3. A human maintainer reviews and approves. AI agents may draft ADRs but **may not mark them `Accepted`**.
4. On approval, set status to `Accepted` with the date. Implementation may begin.
5. ADRs are immutable once accepted. To change a decision, write a new ADR that supersedes it, and update the old
   one's status to `Superseded by NNNN`.

Statuses: `Proposed`, `Accepted`, `Rejected`, `Deprecated`, `Superseded by NNNN`.

## Template

```markdown
# NNNN. Title

- Status: Proposed
- Date: YYYY-MM-DD
- Deciders: <names/roles>
- Related: <links to ADRs, docs, issues>

## Context

What problem are we solving? What constraints apply (financial integrity, tenancy, security, AI safety, cost,
team, regulation)? What is true today?

## Decision

What we will do, stated clearly and specifically.

## Alternatives considered

- Option A: summary, pros, cons, why not chosen
- Option B: ...

## Consequences

- Positive:
- Negative / risks:
- Impact on financial integrity, tenancy, audit, idempotency, AI safety and security:
- Migration / rollout / rollback plan:

## Compliance with governance rules

List any rule in `AGENTS.md` or `.cursor/rules/` this decision touches, and how it is satisfied (or, if it changes
a rule, which rule and why).
```

## Anticipated early ADRs

These decisions are expected before or during the first build phase. They are listed for planning only; none has
been made yet.

- 0001 Record architecture decisions (adopt this process)
- Monorepo tooling and repository layout
- Backend framework and runtime
- Database engine (relational, ACID) and data access layer
- Money and decimal representation
- Authentication and authorization model (roles, permissions, offline permissions)
- Ledger design and default chart of accounts (requires accounting review)
- Configurable tax treatment model (requires accounting review; no hardcoded jurisdiction rules)
- Inventory valuation method
- Audit log design
- Idempotency and outbox design
- Offline command queue, local storage, sync lifecycle and conflict (NEEDS_ATTENTION) protocol for the mobile app
- Offline human receipt number format (business/device-scoped; UUID remains the transaction identity)
- Device registration, revocation and local data retention
- Daily close policy (reopening, late-synced records)
- AI model provider(s), speech-to-text and document extraction providers, and data handling terms
- First payment provider
- WhatsApp Business provider and pilot flows

Product decisions already APPROVED (2026-09-27) live in `docs/product/mvp-scope.md`. Architecture-level
implementations of them (e.g. sync protocol, location model schema, posting rules) are recorded as ADRs when the
implementation decisions are made.

## Index

| ADR | Title | Status |
|-----|-------|--------|
| _none yet_ | | |
