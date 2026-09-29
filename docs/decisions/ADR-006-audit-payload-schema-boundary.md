# ADR-006. Audit payload schema boundary

- Status: ACCEPTED (2026-09-29)
- Date: 2026-09-29
- Deciders: Tali maintainers (decision proposed and approved by the human maintainer on 2026-09-29; drafted by an AI
  agent, accepted by the human maintainer)
- Supersedes: **only** the Zod-specific implementation wording of ADR-004 section 8.3 (partial supersession; ADR-004
  remains ACCEPTED)
- Related: `docs/decisions/ADR-002-application-foundation.md` (accepted; sections 6 and 16),
  `docs/decisions/ADR-004-mutation-protocol.md` (accepted; sections 8 and 13),
  `docs/plans/003-build-1-identity-tenancy.md` (Slice 1), `.cursor/rules/00-architecture.mdc`,
  `.cursor/rules/70-security.mdc`, `.dependency-cruiser.cjs` (rule `application-framework-free`)

## 1. Context

Two accepted decisions conflict when `defineAuditAction` is implemented:

- **ADR-004 section 8.3** says: "Each action registers a bounded, purpose-specific Zod schema
  (`defineAuditAction(name, payloadSchema)`)". The action registry and the audit recorder that validates payloads
  belong to the application layer, because use cases build audit payloads there.
- **ADR-002 section 6** says `packages/application` may depend on `packages/domain` only. The same table lists Zod
  explicitly for `shared` and `config`, and not for `application`. The dependency-cruiser rule
  `application-framework-free` enforces this by rejecting every npm package in application source.

Following ADR-004 literally means adding a runtime dependency to `packages/application`, which breaks ADR-002 and
its enforced boundary. Following ADR-002 means not using Zod, which departs from ADR-004's wording. The conflict was
found at the start of Build 1 Slice 1, and Slice 1 was stopped before any code was written.

What ADR-004 section 8.3 requires in substance is independent of the library:

- every audit action is registered with a bounded, purpose-specific payload schema;
- the writer rejects unregistered actions and invalid payloads, and a rejection fails the mutation;
- payloads are built explicitly from changed fields, never by serializing entities;
- a registry test rejects field names matching a secret pattern (`token`, `secret`, `credential`, `password`, `hash`,
  `jwt`);
- the payload size is capped (8 KiB, ADR-004 section 13).

## 2. Decision

1. **`packages/application` stays dependency-free.** Zod is not added to `packages/application`, and the
   `application-framework-free` boundary is unchanged.
2. **Scope of supersession.** This ADR supersedes **only** the Zod-specific implementation wording of ADR-004
   section 8.3 ("Zod schema" in `defineAuditAction(name, payloadSchema)`). Every other ADR-004 audit requirement is
   unchanged, including:
   - the two audit tables and the single `AuditWriter` port (section 8.1);
   - the envelope fields (section 8.2);
   - the payload-safety rules, the secret-pattern registry test and the per-action redaction tests (section 8.3);
   - writing audit inside the mutation's transaction (section 9);
   - the initial limits (section 13).
3. **Replacement mechanism.** Audit payload schemas are defined with a small, application-owned, dependency-free
   payload definition and validation mechanism, specified in section 3. `defineAuditAction(name, payloadDefinition)`
   keeps its role and name.
4. **Zod elsewhere is unchanged.** Zod remains the validation library for transport, configuration and wire schemas
   outside the framework-free application layer (`shared`, `config`, and transport code in apps), per ADR-002
   section 16.

## 3. Audit payload definition mechanism

### 3.1 Capabilities

The mechanism supports only what audit events need:

- **Required and optional fields.** An optional field may be absent. `null` is accepted only where a field is
  declared nullable.
- **Bounded strings**, each with a declared maximum length. Strings containing lone surrogates are rejected.
- **Identifiers:** UUIDs in lowercase canonical form, as the domain's typed IDs already produce them.
- **Booleans.**
- **Enumerations:** a declared, closed list of literal string values (for example roles and statuses).
- **Exact integers:** JavaScript safe integers, or canonical base-10 integer strings where a value may exceed the
  safe-integer range. Floating-point numbers, `NaN`, infinities and `-0` are rejected.
- **Timestamps**, only where an action needs one: ISO 8601 UTC with millisecond precision and a `Z` suffix.
- **Small bounded arrays**, only where an action explicitly needs them: a declared element kind and a declared
  maximum number of items.

Payloads are flat records of these field kinds. Nested objects are not supported. Adding a nested or new field kind
is a change to this mechanism, reviewed with the action that needs it.

### 3.2 Required behavior

- **Unknown fields are rejected.** A payload may contain only the fields its action declares.
- **Per-field bounds are enforced:** string length, array length, enumeration membership, integer form and
  identifier form.
- **Total payload bound.** The 8 KiB cap from ADR-004 section 13 is enforced:
  - at definition time: `defineAuditAction` rejects a definition whose worst-case encoded size can exceed the cap;
  - at runtime: validation checks the payload against its declared bounds.

  The application layer computes these bounds from declared sizes. It does not encode bytes itself, so it adds no
  UTF-8 encoder. The persistence adapter may check the actual stored size again as defense in depth.
- **Validation happens at runtime**, in the audit recorder, before the `AuditWriter` port is called. An invalid
  payload throws, so the mutation fails and nothing is written.
- **Unregistered actions are rejected.** Actions come from an explicit code-defined registry. Duplicate action names
  are rejected when the registry is built. The recorder accepts only registered action definitions.
- **Sensitive field names are rejected.** A field name matching the ADR-004 secret pattern is rejected when the
  action is defined, and the ADR-004 registry test covers every registered action.
- **Deterministic:** the same payload and definition always give the same result. There is no clock, randomness or
  I/O.
- **No silent transformations.** Validation accepts or rejects values exactly as given. It does not trim, change
  case, normalize Unicode, coerce types, fill in defaults or drop fields. Where a field's own domain contract
  normalizes a value (for example business names under ADR-005), the domain does that before the payload is built.
- Each action keeps a `payload_schema_version` (ADR-004 section 8.2).

### 3.3 Limits of the mechanism

The mechanism must not become:

- a general-purpose schema-validation framework;
- a reimplementation of Zod or a similar library (no parsers, refinements, transforms, unions or schema
  composition beyond section 3.1);
- a business-rule engine: payload definitions check shape and bounds only, and domain and application services
  still hold the rules;
- a transport validation library: HTTP, webhook, queue and configuration input stays with Zod at the transport
  boundary.

It lives in `packages/application` next to the audit recorder and the action registry, and is used only for audit
payloads. Reusing it for another purpose needs its own decision.

## 4. Alternatives considered

- **Add Zod to `packages/application`.** It follows ADR-004 literally and gives a mature, familiar library. But it
  breaks ADR-002 section 6 and the enforced `application-framework-free` boundary. It would add the first runtime
  dependency to the layer that holds authoritative logic, and it would invite Zod to spread through use cases.
  Rejected by the human maintainer.
- **Validate audit payloads with Zod only in the persistence adapter (`packages/database`).** This keeps
  application dependency-free, but validation would move away from the code that defines each action. Unit tests
  with in-memory fakes would no longer exercise payload validation. Invalid payloads would only be caught in
  integration tests. Rejected.
- **Share Zod schemas from `packages/shared`.** `shared` holds wire contracts only, and application may not depend on
  it (ADR-002 section 6). Rejected.
- **TypeScript types only, with no runtime validation.** Types disappear at runtime and cannot enforce bounds or
  reject unknown fields, which ADR-004 section 8.3 requires. Rejected.

## 5. Consequences

- Positive:
  - `packages/application` keeps its dependency-free boundary, and no boundary rule changes.
  - Audit payload validation runs in application unit tests with in-memory fakes.
  - The field vocabulary is closed and small, so payloads stay bounded and easy to review.
- Negative / risks:
  - Tali owns a small amount of validation code, and it needs thorough tests: unknown fields, every bound, the
    definition-time size check, sensitive names and unregistered actions.
  - A new field kind is a reviewed change rather than a library feature.
  - The mechanism could grow into a general framework over time. Section 3.3 forbids that, and reviews enforce it.
- Impact:
  - **Financial integrity:** none. No financial behavior changes. Future financial audit actions use the same
    mechanism.
  - **Tenancy:** none. Audit scope and routing are unchanged from ADR-004 section 8.1.
  - **Audit:** same guarantees as ADR-004 section 8.3, implemented without a library.
  - **Idempotency:** none.
  - **AI safety:** none.
  - **Security:** the secret-name rule and the size caps stay enforced at runtime and in tests.
- Rollout: implemented in Build 1 Slice 1. Rollback: write a superseding ADR.

## 6. Compliance with governance rules

- **ADR-002 section 6** (application depends only on domain) and the `application-framework-free` dependency-cruiser
  rule: preserved.
- **ADR-002 section 16** (Zod at transport boundaries): unchanged.
- **ADR-004 section 8.3:** its Zod-specific wording is superseded by this ADR. All other ADR-004 requirements,
  including the rest of section 8.3, remain in force.
- **`00-architecture.mdc`:** no new dependency, datastore or service.
- **`70-security.mdc`:** no secrets in audit payloads, and redaction is enforced by tests.
- ADR-004's text and status are not edited. ADR-004 remains ACCEPTED. The partial supersession is recorded in this
  ADR's header and in the index in `docs/decisions/README.md`, following the partial-supersession convention described
  there.

## 7. Human approval record

Accepted by the human maintainer on 2026-09-29. The following decisions were explicitly approved:

- `packages/application` remains free of runtime dependencies;
- Zod is not introduced into `packages/application`;
- the small, bounded audit payload definition mechanism in section 3 replaces **only** the Zod-specific
  implementation wording of ADR-004 section 8.3;
- every other ADR-004 audit requirement remains in force;
- ADR-004 keeps its ACCEPTED status. This is a partial supersession, not a lifecycle change to ADR-004 as a whole.
