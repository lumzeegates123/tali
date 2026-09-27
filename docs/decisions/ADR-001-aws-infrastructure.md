# ADR-001. AWS-native infrastructure

- Status: ACCEPTED (2026-09-27)
- Date: 2026-09-27
- Deciders: Tali maintainers (human approval given 2026-09-27)
- Related: `AGENTS.md`, `docs/product/mvp-scope.md` (Infrastructure direction), `docs/architecture/architecture-principles.md`
  (sections 4 and 11), `.cursor/rules/00-architecture.mdc`, `.cursor/rules/70-security.mdc`

## 1. Context

Tali records other businesses' money, stock and books for many tenants in one system. The approved product scope
(`docs/product/mvp-scope.md`) requires an Android-first React Native / Expo mobile app, a secondary web app, a
narrow WhatsApp adapter, offline-captured commands synchronized idempotently, and one backend/domain application
(modular monolith) that is the system of record.

The governance documents already require:

- one deployable backend/domain application, with business logic in application/domain services only;
- a relational, ACID-compliant database for financial data;
- every external dependency behind a port with adapters in `infrastructure/`;
- a transactional outbox and idempotent workers for side effects;
- least privilege, no secrets in source, encryption in transit and at rest, and tenant-scoped storage.

A managed backend-as-a-service (Supabase) had been considered as the infrastructure foundation. A human
maintainer has approved a different direction on 2026-09-27: Tali builds and owns its application backend and
runs it on AWS-native infrastructure. This ADR records that direction, its reasoning and its limits. Exact
network topology and several operational details are deferred to a later foundation infrastructure ADR
(section 12).

The repository currently contains governance and documentation only. This ADR does not create code, packages,
schemas, CDK files or AWS resources, and accepting it does not by itself authorize AWS provisioning (see the
provisioning gate in section 11).

## 2. Decision

### 2.1 Application ownership

- The authoritative backend is a **NestJS + TypeScript** application (the modular monolith), owned by Tali.
- **AWS provides infrastructure only.** Tali domain/business logic never lives in AWS services (for example:
  no business rules in Cognito triggers, database triggers/procedures used as business logic, SQS routing
  configuration, S3 event handlers, or serverless functions outside the NestJS/domain application).
- Mobile and web communicate with **Tali's API**. Clients never directly mutate authoritative financial or
  inventory records through AWS services (no direct database access, no client writes to queues, no client-side
  AWS credentials).
- The background worker is a separate **process of the same backend codebase** (permitted by
  `architecture-principles.md` section 1), not an independent service.

### 2.2 Initial planned AWS services

| Concern | Service | Notes |
|---------|---------|-------|
| Database | Amazon RDS for PostgreSQL | System of record. Not publicly exposed in production. |
| Authentication | Amazon Cognito | Authentication (identity proof) only. Business membership, roles, permissions and devices remain in Tali's `identity` module and database. |
| Object storage | Amazon S3 | Private by default; tenant-scoped key prefixes for organization and provenance (not an authorization boundary by themselves); access via short-lived signed URLs issued by the API. |
| Backend API compute | Amazon ECS on AWS Fargate | Runs the NestJS API process. |
| Background worker compute | Amazon ECS on AWS Fargate | Runs the worker process of the same codebase (outbox relay, async jobs). |
| Container registry | Amazon ECR | Images for API and worker. |
| Asynchronous messaging | Amazon SQS | Transport only. The transactional outbox in PostgreSQL remains the source of truth for pending side effects; consumers are idempotent. |
| Secrets | AWS Secrets Manager | Retrieved server-side only. |
| Encryption keys | AWS KMS | AWS-managed or Tali-managed keys as appropriate. |
| Logs, metrics, alerts | Amazon CloudWatch | Structured logs with correlation IDs; no secrets or sensitive personal data. |
| Infrastructure as code | AWS CDK (TypeScript) | Future location `infrastructure/cdk/`. All infrastructure changes are version controlled. |
| CI/CD | GitHub Actions with AWS OIDC federation | No long-lived AWS access keys in CI. |
| Web hosting | AWS Amplify Hosting (preferred initial candidate for the Next.js web app) | Subject to confirmation in the foundation infrastructure ADR. |
| DNS | Amazon Route 53 | |
| TLS certificates | AWS Certificate Manager | HTTPS for all external traffic. |

Not introduced initially:

- **Redis / Amazon ElastiCache**: only when a concrete requirement exists, via a new ADR (a cache is never a
  source of truth for financial or inventory data).
- **Amazon SES**: may be introduced when email workflows are required, behind an email port.
- **LocalStack**: not part of the initial foundation unless a concrete requirement is later demonstrated.

### 2.3 Environments

Tali is architected for isolated **local**, **development**, **staging** and **production** environments.
Development, staging and production never share authoritative databases. The design must support long-term
separation into distinct AWS accounts per environment. No AWS accounts or resources are provisioned by this ADR.

## 3. Why AWS-native infrastructure was chosen

- **Ownership of the system of record.** Tali's correctness rules (balanced postings, append-only financial
  records, audit in the same transaction, idempotent sync, server-side tenant authorization) must be enforced by
  Tali's own domain services. A self-owned NestJS backend on general-purpose infrastructure keeps every
  authoritative write path inside that application.
- **Mature primitives for a financial workload.** Managed PostgreSQL with automated backups and encryption,
  fine-grained IAM, KMS, Secrets Manager, private networking and audit logging are available as first-class,
  well-documented services.
- **One provider for infrastructure concerns.** Database, identity, storage, compute, messaging, secrets,
  keys, observability, DNS and certificates are covered by one cloud with one IAM model, reducing integration
  surface and credential sprawl.
- **Infrastructure as code in the application language.** AWS CDK in TypeScript keeps infrastructure reviewable
  in the same language and repository as the application.
- **Credential-free CI.** GitHub Actions can deploy through AWS OIDC federation without storing long-lived keys.
- **Room to grow without re-platforming.** Queues, additional workers, account separation and later services
  (email, cache) can be added incrementally, each behind Tali ports.

## 4. Why Supabase was rejected for this project

Supabase is a capable platform; it was rejected for Tali's specific constraints, not on general merit:

- **Its default model encourages clients to talk to the database.** Supabase's client libraries and
  auto-generated APIs make direct client reads/writes (guarded by row-level security) the natural path. Tali
  requires that clients never mutate authoritative financial or inventory records directly and that all
  mutations pass through deterministic domain services with audit, idempotency and ledger posting. Using
  Supabase safely would mean disabling or bypassing much of what makes it attractive.
- **Row-level security as a primary control conflicts with the governance rules.** `10-database.mdc` allows RLS
  only as defense in depth, never as the only control. Tali's authorization lives in application services.
- **Risk of business logic drifting into platform features** (database functions, triggers, edge functions,
  storage policies) outside the modular monolith, contrary to `00-architecture.mdc`.
- **Tali would still need its own backend and workers** (NestJS API, outbox relay, sync processing, provider
  adapters), so Supabase would largely reduce to managed PostgreSQL, auth and storage while adding a second
  platform to secure, operate and reason about.
- **Operational control.** Network isolation, IAM granularity, key management, account-per-environment
  separation and deployment topology are more directly controllable on AWS for a system holding financial records.

## 5. Benefits

- Single, self-owned write path for all authoritative records.
- Managed PostgreSQL satisfying the relational, ACID requirement.
- Strong security primitives: IAM least privilege, KMS, Secrets Manager, private networking, TLS via ACM.
- Container-based compute (Fargate) runs the same image locally and in the cloud, with no servers to patch.
- Reproducible, reviewable infrastructure via CDK in TypeScript.
- No long-lived AWS keys in CI.
- Clear path to per-environment account isolation.

## 6. Tradeoffs

- **More to build and operate** than a backend-as-a-service: API, auth integration, storage access, networking,
  deployment pipelines and observability are Tali's responsibility.
- **AWS complexity and learning curve** (IAM, VPC, ECS, CDK). Misconfiguration is a real security risk and needs
  review discipline.
- **Cost visibility.** Several services (for example NAT gateways, RDS instances, Fargate tasks, CloudWatch
  ingestion) have baseline costs even at pilot scale; cost controls and budgets are required.
- **Cognito constraints.** Cognito's user model, customization limits and phone/SMS sign-in characteristics
  (cost and deliverability, including in Nigeria) must be validated against Tali's needs (shared devices,
  separate staff sessions, device registration). Tali keeps authorization in its own database partly to limit
  this coupling.
- **Vendor coupling.** Some coupling to AWS is accepted at the infrastructure layer; it is contained by ports and
  adapters (section 7) but not eliminated.
- **Region and data residency.** There is no full AWS Region in Nigeria; region choice has latency and legal
  implications (section 12).

## 7. Portability approach

- **AWS SDK calls are confined to infrastructure adapters.** Domain and application services never import AWS
  SDKs or AWS types; they depend on ports defined in Tali's terms.
- Infrastructure ports introduced by this decision (names indicative):
  - `ObjectStorageProvider` (S3 adapter; local/test adapter)
  - `IdentityProvider` (Cognito adapter for token verification and user lifecycle; local/test adapter)
  - `QueueProvider` (SQS adapter; local/test adapter)
- Future provider ports continue to follow the same pattern: `PaymentProvider`, `BankingProvider`,
  `MessagingProvider`, `SpeechProvider`, `DocumentProvider`, `AIProvider` (and an email port when SES is added).
- AWS implementations live in `infrastructure/` adapters of the owning module (or a shared infrastructure
  package if the repository ADR chooses one).
- **Tali's own identifiers are authoritative.** Tali users have Tali UUIDs; the Cognito subject is stored as an
  external identity reference, so the identity provider can be replaced without rewriting business records.
- **Standard interfaces where possible**: PostgreSQL (not proprietary database features as business logic),
  OCI container images, OIDC/JWT tokens, S3-compatible object semantics.
- Configuration and secrets are read through a config module, so the source (environment variables locally,
  Secrets Manager in deployed environments) is swappable.

## 8. Security implications

Planned direction (exact controls are finalized in the foundation infrastructure ADR):

- **RDS is not publicly exposed in production**; it is reachable only from Tali workloads and approved
  administrative paths.
- **ECS tasks use least-privilege IAM task roles**, separate for API and worker, granting only the specific
  resources each needs.
- **S3 buckets are private by default** (public access blocked); objects use tenant-scoped keys and are served
  through short-lived signed URLs issued by the API after authorization.
- **Tenant-scoped S3 key prefixes are organizational structure and provenance, not an authorization boundary by
  themselves.** A key containing a `businessId` grants nothing. Access to objects is enforced through Tali API
  authorization (server-resolved `BusinessContext` and permission checks), IAM policy, and approved signed-URL
  behavior (issued only after authorization, scoped to a single object and operation, short-lived).
- **Secrets are retrieved through approved server-side mechanisms** (Secrets Manager via task role); never
  embedded in images, source, CI configuration or client apps.
- **Encryption at rest** for RDS, S3, SQS and secrets using AWS-managed or Tali-managed KMS keys as appropriate;
  **HTTPS/TLS** for all external traffic, with certificates from ACM.
- **No AWS credentials in mobile or web applications.** Clients authenticate with Cognito and call Tali's API
  with tokens; the API verifies tokens and resolves `BusinessContext` server-side from Tali's database.
- **Cognito identity is not tenant authorization.** Cognito proves who the user is; business membership, roles,
  permissions and device status are checked by Tali on every request and on every synced command.
- **No long-lived AWS access keys in GitHub CI**; deployments assume narrowly scoped roles via OIDC, restricted by
  repository, branch/environment and workflow.
- **Environment isolation**: separate databases per environment; long-term separate AWS accounts; production
  data never copied to lower environments without an approved, anonymized process.
- **Logging**: CloudWatch logs follow `70-security.mdc` (no secrets, tokens, OTPs or full account numbers).

## 9. Local-development implications

- AWS is the deployed infrastructure; **local development does not require every request to reach AWS**.
- The local foundation is expected to run: the NestJS API locally, the Next.js web app locally, the Expo mobile
  app locally, and **PostgreSQL in Docker**.
- Cloud-dependent infrastructure has **development/test adapters where practical** (for example a local
  filesystem or in-memory `ObjectStorageProvider`, an in-process or database-backed `QueueProvider`, and a
  local/test `IdentityProvider`).
- Development/test adapters that weaken security (for example a local identity adapter that issues test tokens)
  must be impossible to enable in deployed environments, enforced by configuration validation at startup.
- Automated tests run without AWS credentials and without network calls to AWS, faking providers at the port
  boundary (`60-testing.mdc`).
- LocalStack is not introduced initially.

## 10. Alternatives considered

- **Supabase (managed PostgreSQL, Supabase Auth, Supabase Storage, edge functions).** Fast to start and
  developer-friendly. Rejected for the reasons in section 4: its default client-to-database model and reliance
  on row-level security conflict with Tali's server-authoritative, audited write path, and Tali would still need
  its own backend and workers.
- **Other managed platforms (for example Firebase, or PaaS hosting such as Render, Railway, Fly.io or Heroku with
  a managed Postgres).** Simpler operations but weaker control over networking, IAM, key management and
  account-level environment isolation; Firebase's primary datastore is not relational/ACID in the way the
  governance rules require. Not chosen.
- **Another major cloud (Google Cloud or Microsoft Azure).** Comparable capabilities. Not chosen; the direction
  approved on 2026-09-27 standardizes on AWS. The port/adapter approach keeps a later move possible at the
  infrastructure layer.
- **Serverless-first backend on AWS (AWS Lambda + API Gateway).** Low idle cost, but encourages splitting logic
  into many functions, complicates long-running sync and outbox processing and database connection management,
  and risks business logic drifting outside the modular monolith. Not chosen; containers on Fargate keep one
  deployable application.
- **Self-managed compute (Amazon EC2 or Kubernetes/EKS).** More control, but more operational burden than a small
  team needs at pilot stage. Not chosen.

## 11. Consequences

- Positive:
  - All authoritative writes go through Tali's NestJS domain services; AWS holds infrastructure only.
  - Security controls (IAM, KMS, private networking, OIDC CI) are available from the start.
  - Infrastructure is reviewable code in TypeScript.
- Negative / risks:
  - Higher initial setup and ongoing operational effort; AWS misconfiguration risk.
  - Baseline cloud costs at pilot scale; budgets and alerts are required.
  - Cognito fit (phone sign-in, shared devices, staff sessions) must be validated early.
- Impact on financial integrity, tenancy, audit, idempotency, AI safety and security:
  - Financial integrity and audit: unchanged rules; PostgreSQL transactions carry mutation, postings, movements
    and audit together.
  - Tenancy: `BusinessContext` is resolved from Tali's database, never from Cognito claims alone; S3 keys and
    SQS messages carry `businessId` and are re-validated on consumption.
  - Idempotency: SQS delivers at least once; consumers must be idempotent; the outbox remains in PostgreSQL.
  - AI safety: unchanged; AI providers remain behind `AIProvider` ports and may only propose.
  - Security: see section 8.
- Governance updates made alongside this ADR: `AGENTS.md`, `docs/product/mvp-scope.md`,
  `docs/architecture/architecture-principles.md`, `docs/decisions/README.md`, `.cursor/rules/00-architecture.mdc`,
  `.cursor/rules/10-database.mdc`, `.cursor/rules/60-testing.mdc`, `.cursor/rules/70-security.mdc`,
  `.cursor/BUGBOT.md`.
- Migration / rollout / rollback: nothing is deployed yet.
- **Provisioning gate.** Infrastructure implementation (CDK code, AWS accounts, AWS resource provisioning) begins
  only after **both** this ADR **and** the future foundation infrastructure ADR have status **Accepted**. A
  foundation infrastructure ADR that is only written, drafted or proposed does not authorize provisioning, and
  acceptance of this ADR alone does not authorize provisioning. If this ADR is rejected, the governance updates
  above are reverted in the same change that records the rejection.

## 12. Items intentionally deferred

To the **foundation infrastructure ADR** (or a dedicated ADR where noted):

- Exact VPC and network topology (subnets, NAT versus VPC endpoints, load balancer, administrative database access path).
- AWS Region(s), taking into account latency to Nigeria and Nigerian data-protection requirements (legal review).
- AWS account structure (AWS Organizations, per-environment accounts, when separation happens) and IAM Identity Center use.
- Confirmation of AWS Amplify Hosting for the Next.js web app versus alternatives.
- RDS configuration: instance class, Multi-AZ, storage, backup retention, point-in-time recovery, restore testing,
  connection management (for example RDS Proxy), and database roles.
- Cognito configuration: sign-in methods (phone/email, OTP), SMS delivery for Nigeria, token lifetimes, how
  shared-device staff sessions and device registration map onto Cognito, and hosted UI versus custom UI.
- SQS details: standard versus FIFO queues, dead-letter queues, retry policy, and the outbox relay design
  (idempotency and outbox ADR).
- Media upload path: whether clients upload directly to S3 via API-issued pre-signed URLs or through the API, and
  media validation/scanning.
- KMS key strategy (AWS-managed versus customer-managed keys per data class) and key rotation.
- Observability details: log retention, metrics, alarms, tracing, on-call/alert routing, and whether AWS X-Ray
  or OpenTelemetry is used.
- CI/CD details: GitHub environments, OIDC role trust policies, deployment approvals, image scanning.
- Cost budgets and alerts.
- Disaster recovery objectives (RPO/RTO).
- Data access layer/ORM, runtime versions and repository layout (separate ADRs).
- Introduction of Amazon SES, Amazon ElastiCache or LocalStack (each only on a concrete requirement, via ADR).
