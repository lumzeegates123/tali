# ADR-003. AWS foundation topology

- Status: ACCEPTED (2026-09-30)
- Date: 2026-09-30
- Deciders: Tali maintainers (human approval given 2026-09-30; drafted by an AI agent, accepted by the human
  maintainer). Acceptance record in section 40.
- Revision: 2026-09-30, revised before acceptance with maintainer direction on region, accounts, Cognito sign-in and
  tokens, Cognito email, WAF, SNS, production KMS, web hosting and RDS monitoring (section 2). The ADR was then
  accepted as written.
- Supersedes: nothing. This is the foundation infrastructure ADR that ADR-001 section 12 and ADR-002 section 25 defer
  to.
- Related: `docs/decisions/ADR-001-aws-infrastructure.md` (accepted), `docs/decisions/ADR-002-application-foundation.md`
  (accepted), `docs/decisions/ADR-004-mutation-protocol.md` (accepted), `docs/decisions/ADR-005-identity-tenancy-authorization.md`
  (accepted), `docs/decisions/ADR-006-audit-payload-schema-boundary.md` (accepted), `docs/plans/001-foundation-plan.md`,
  `docs/plans/003-build-1-identity-tenancy.md`, `docs/audits/build-1-slice-3.md`, `docs/audits/build-1-slice-4.md`,
  `docs/audits/build-1-slice-5.md`, `.cursor/rules/00-architecture.mdc`, `.cursor/rules/30-multitenancy.mdc`,
  `.cursor/rules/70-security.mdc`

## 1. Context

ADR-001 (accepted 2026-09-27) chose AWS-native infrastructure for Tali's own NestJS + TypeScript backend and listed
the planned services. It deferred the exact topology to this ADR, and it made provisioning conditional on **both**
ADR-001 and this ADR being accepted. ADR-002 fixed the application foundation (local development without AWS, the
separate API and worker processes, Prisma inside `packages/database`, the server/public configuration split, no RLS
yet). ADR-005 fixed the identity boundary: Cognito authenticates, Tali authorizes; Tali checks User status, Business
Membership and Device status on every request.

This ADR turns that direction into a deployable topology for a **private pilot** with Nigerian merchants. It aims for:
simple now, safe now, and a clear scaling path later. It does not design for hypothetical large scale.

Facts in the repository that this ADR depends on (inspected 2026-09-30, not changed):

- `packages/config/src/server/server-config.ts` rejects `local`/`memory` object storage and the `memory` queue in
  deployed environments. The **first deployed environment therefore needs an S3 bucket and an SQS queue**, even though
  Build 1 does not yet use them.
- `IDENTITY_PROVIDER=cognito` requires `COGNITO_REGION`, `COGNITO_USER_POOL_ID` and `COGNITO_CLIENT_IDS`, and currently
  fails at startup as not implemented (Slice 3 audit). The server config reads one `SQS_QUEUE_URL`.
- `DATABASE_URL` is one URL containing the password. `MIGRATION_DATABASE_URL` is used only by the Prisma CLI.
- The Prisma driver-adapter pool defaults to `max: 10` connections per process
  (`packages/database/src/client/prisma-client.ts`).
- Database roles: `tali_owner` (owner/migrations) and `tali_app` (runtime, no DDL, no DELETE grants, `NOBYPASSRLS`),
  created by `packages/database/sql/bootstrap-roles.sql`.
- The API exposes `/health/live` and `/health/ready`. The worker writes a heartbeat file (`WORKER_HEARTBEAT_FILE`).
  `SHUTDOWN_GRACE_PERIOD_MS` defaults to 10 seconds.
- The web app pins **Next.js 16.3.6**. It uses the App Router with no route handlers, server actions or middleware, and
  holds tokens in memory only (Slice 4 and 5 audits). `next.config.ts` runs a build-time public-configuration guard.
- The mobile app stores the device credential with `expo-secure-store` (Slice 5).
- CI (`.github/workflows/ci.yml`) has `permissions: contents: read`, no `id-token: write`, pinned action SHAs, and no
  deployment.

This ADR creates no CDK code, AWS resources, Cognito resources, workflows or application code.

## 2. Maintainer direction recorded before acceptance (2026-09-30)

The human maintainer gave the following direction on the first draft. It is written into the sections below. The ADR
as a whole was accepted on 2026-09-30 (section 40).

| # | Topic | Direction |
|---|-------|-----------|
| 1 | Region | eu-west-1 is the engineering-default primary Region; eu-west-2 is the fallback. Latency measurement from Nigerian mobile networks is required before the production infrastructure commitment, not before Slice 6 adapter work. Nigerian legal/data-transfer review remains a production deployment condition and is not resolved. |
| 2 | Accounts | Management account, a non-production workload account containing isolated development and staging environments, and a production workload account. AWS Organizations and IAM Identity Center. |
| 3 | Cognito sign-in | Email + password; phone/SMS deferred; custom in-app UI; self sign-up enabled for the private pilot; Cognito authentication only; Tali roles, memberships and devices stay outside Cognito. Staff without email is a product gap to resolve before broad rollout. |
| 4 | Cognito tokens | Access 15 minutes; ID 15 minutes; web refresh 12 hours in memory only; mobile refresh 7 days in SecureStore; refresh-token rotation enabled with a small retry grace period (10 seconds recommended). Auth-flow wording corrected (section 14.4). |
| 5 | Cognito email | The default Cognito email configuration (50 emails per day account quota) is acceptable for the private pilot only. SES remains deferred. |
| 6 | WAF | Production AWS WAF on the ALB, with managed common rules and a deliberately generous IP rate limit (CGNAT). |
| 7 | SNS | One SNS topic per environment for CloudWatch alarm notification. Infrastructure alert delivery only. |
| 8 | Production KMS | Customer-managed keys for production RDS/snapshots and production media S3. Non-production uses AWS-managed keys unless an implementation requirement says otherwise. |
| 9 | Web hosting | Amplify Hosting is **not** confirmed. It remains the preferred candidate; final selection is deferred to an implementation spike (section 24). It does not block Slice 6. |
| 10 | RDS monitoring | Database Insights Standard as the baseline; paid database observability only after need is demonstrated. |

## 3. Decision summary

- **Region:** eu-west-1 (Ireland) primary, eu-west-2 (London) fallback. Single Region. Production deployment is
  conditional on legal review and a latency measurement (section 4).
- **Accounts:** AWS Organizations with a management account, one non-production workload account (development and
  staging, isolated from each other) and one production workload account. Human access through IAM Identity Center.
- **Network:** one VPC per environment across two AZs; public subnets (ALB, NAT), private application subnets (ECS),
  isolated database subnets (RDS). No public database, no SSH, no bastion.
- **Entry:** Route 53, then an ACM certificate on an Application Load Balancer (HTTPS only), then ECS/Fargate API tasks.
  AWS WAF on the production ALB.
- **Database:** RDS for PostgreSQL 18, Multi-AZ DB instance in production, Single-AZ elsewhere; gp3; PITR; no Aurora;
  no RDS Proxy initially.
- **Compute:** separate ECS services for the API and the worker; migrations as an explicit one-off ECS task using the
  migration role.
- **Identity:** one Cognito user pool per environment; public web and mobile app clients; email + password via SRP in a
  custom in-app UI; short access tokens; refresh-token rotation.
- **Storage:** one private media bucket per environment; direct-to-S3 upload with API-issued presigned POST after Tali
  authorization.
- **Async:** SQS Standard queue plus DLQ as transport; PostgreSQL outbox remains the source of truth; worker-owned
  database-backed scheduler.
- **Secrets and keys:** Secrets Manager for credentials only; AWS-managed keys by default; customer-managed keys for
  production RDS and production media.
- **Observability:** CloudWatch logs, metrics and alarms, alarm delivery via SNS; tracing deferred.
- **CI/CD:** GitHub Actions with AWS OIDC, per-environment roles, protected production environment, immutable image
  digests.
- **Web hosting:** Amplify Hosting is the preferred candidate, subject to an implementation spike on Next.js 16.
- **DR:** production RPO about 5 minutes and RTO up to 4 hours within the Region; no multi-Region DR.

## 4. AWS Region and data residency

### 4.1 Engineering recommendation

| Candidate | Assessment |
|-----------|------------|
| **eu-west-1 (Ireland)** | **Primary (engineering default).** Mature Region; every approved service is available (RDS PostgreSQL, ECS/Fargate, ECR, Cognito, S3, SQS, KMS, Secrets Manager, CloudWatch, Route 53/ACM global or regional as applicable, Amplify Hosting, AWS WAF); among the lower-cost Regions in Europe; typically early for new features; good routes from Lagos through European submarine cables and peering. |
| **eu-west-2 (London)** | **Fallback.** Same service coverage; strong Nigeria-to-London connectivity and peering; typically somewhat higher prices than eu-west-1. |
| af-south-1 (Cape Town) | Considered, not chosen. In Africa but not in Nigeria; opt-in Region; generally higher prices; some features arrive later; routing from Lagos is not reliably lower-latency than to Europe. Revisit if legal review favors an African Region. |
| AWS Local Zone in Lagos | Considered, not chosen. Its service set does not include the managed services Tali needs (managed RDS, Cognito); it would still depend on a parent Region. |
| Multi-Region active-active | Rejected. Not needed for a private pilot, and it multiplies cost and consistency risk for financial data. |

Only one Region is used. There is no AWS Region in Nigeria, so any choice transfers personal data outside Nigeria.

### 4.2 Conditions (not resolved by engineering)

- **Latency measurement** from Lagos (and other pilot cities) on the major Nigerian mobile networks to eu-west-1 and
  eu-west-2 is required **before the production infrastructure commitment**. It is not required before the Slice 6
  adapter work, which needs no AWS.
- **Service and feature availability** in eu-west-1 is re-checked against the AWS Regional Services List at
  implementation time, including the Cognito feature plan needed for refresh-token rotation (section 14.4), the RDS
  PostgreSQL 18 minor version, and the chosen web host.
- **Legal and data-transfer review** (Nigeria Data Protection Act 2023 cross-border transfer rules and any regulator
  expectations) is a **production deployment condition**. This ADR does not claim legal compliance. See section 35 C.

## 5. AWS accounts and human access

### 5.1 Options

| Option | Summary | Assessment |
|--------|---------|------------|
| A. One account, isolated environments | All environments in one account, separated by naming, VPCs and IAM | Rejected. A lower-environment mistake or credential can reach production; IAM policies get complex; weak blast-radius control for a fintech. |
| **B. Management + non-production + production** | Organizations management account (no workloads); non-production account holding development and staging; production account | **Chosen.** Strong production isolation at the smallest account count. |
| C. Management + development + staging + production | One account per environment | Upgrade path. Staging moves to its own account when staging needs production-grade access control or when team size grows. Each environment already has its own VPC and resources, so the move is a redeploy, not a redesign. |

### 5.2 Decision

- **AWS Organizations**, created in a dedicated **management account** that holds billing, Organizations, IAM Identity
  Center and the organization CloudTrail trail. No workloads run there.
- **Non-production workload account**: `development` and `staging`, each with its own VPC, RDS instance, Cognito user
  pool, bucket, queues, secrets, log groups and ECS cluster. They share no authoritative resources.
- **Production workload account**: `production` only.
- A separate log-archive or security-tooling account is deferred until the team or compliance needs justify it.
- Service control policies (initial, minimal): deny leaving the organization, deny disabling CloudTrail, deny actions
  outside the approved Regions (primary and fallback, plus global services), deny root-user actions in workload accounts.

### 5.3 Human access (IAM Identity Center)

- All human access goes through **IAM Identity Center** with MFA. No IAM users for humans. The root user of every account
  has MFA and no access keys, and is used only for tasks that require it.
- Initial permission sets:
  - `ReadOnly`: all accounts;
  - `NonProdDeveloper`: non-production account, broad but no IAM administration outside CDK-managed roles;
  - `ProdOperator`: production account; ECS, CloudWatch and deployment inspection; no data-plane access to RDS, S3
    objects or secrets;
  - `BreakGlassAdmin`: production account; time-bound assignment, MFA, used only during a recorded incident; all use
    is visible in CloudTrail;
  - `Billing`: management account.
- Staff role changes in AWS are infrastructure access, separate from Tali business roles, and are reviewed.

## 6. Environments

`local` remains completely AWS-independent (ADR-002 section 20). AWS-hosted environments:

| Concern | development | staging | production |
|---------|-------------|---------|------------|
| Account | non-production | non-production | production |
| Resource prefix | `tali-dev-` | `tali-stg-` | `tali-prod-` |
| DNS | `*.dev.<root-domain>` | `*.staging.<root-domain>` | `*.<root-domain>` |
| VPC | own | own | own |
| RDS instance | own | own | own |
| Cognito user pool | own | own | own |
| S3 media bucket | own | own | own |
| SQS queue + DLQ | own | own | own |
| Secrets | `tali/dev/...` | `tali/stg/...` | `tali/prod/...` |
| KMS | AWS-managed | AWS-managed | customer-managed for RDS and media (section 21) |
| Log groups | `/tali/dev/...` | `/tali/stg/...` | `/tali/prod/...` |
| `TALI_ENV` | `development` | `staging` | `production` |

- Staging and production never share authoritative infrastructure (database, user pool, bucket, queue, secrets, keys).
- Production data is never copied to development or staging without an approved, anonymized process (ADR-001, ADR-002).
- `<root-domain>` is a placeholder. The repository does not yet own a domain (section 25).

## 7. VPC and network

- **Two Availability Zones** per environment.
- Subnets per AZ:
  - **public**: ALB and NAT Gateway only;
  - **private application**: ECS tasks (API, worker, migration and admin tasks), no public IPs;
  - **isolated database**: RDS only, no route to the internet.
- **Outbound access.** ECS tasks need outbound HTTPS for Cognito JWKS, AWS APIs and, later, external providers. A NAT
  Gateway provides it:
  - production: one NAT Gateway per AZ (no cross-AZ egress dependency);
  - non-production: one NAT Gateway per VPC (accepted single point of failure; section 33).
- **VPC endpoints:**
  - S3 gateway endpoint in every VPC (no hourly charge; keeps S3 traffic off the NAT);
  - interface endpoints (ECR, Secrets Manager, CloudWatch Logs, SQS, KMS) are **deferred**. Each has an hourly
    per-AZ charge, and a NAT is still required for Cognito and future providers. Revisit when NAT data-processing cost
    or a security requirement justifies them.
- **Security groups:**
  - ALB: inbound 443 and 80 from the internet;
  - API: inbound on the API port from the ALB security group only;
  - worker: no inbound;
  - migration and admin tasks: no inbound;
  - RDS: inbound 5432 from the API, worker, migration and admin security groups only.
- **No SSH, no bastion hosts, no public IPs on tasks.** RDS is never publicly accessible in any AWS environment.
- VPC DNS resolution and hostnames enabled. VPC flow logs to CloudWatch in production (rejected-traffic only initially,
  to control cost); deferred in non-production.

## 8. API entry point

```
Internet -> Route 53 (api.<env-prefix><root-domain>) -> ACM TLS on ALB :443 -> target group -> ECS/Fargate API tasks
```

- **Listeners:** port 80 redirects to 443; port 443 uses an ACM certificate and a TLS policy that allows TLS 1.2 and
  1.3 only.
- **Health check:** `GET /health/ready`, with a healthy/unhealthy threshold and interval tuned so a restarting task is
  not killed during startup (ECS health-check grace period).
- **ALB settings:** drop invalid header fields; idle timeout 60 seconds; deregistration delay shorter than the ECS stop
  timeout (section 11.5); HTTP/2 enabled.
- **Request limits:** body size and request timeouts are enforced by the API (NestJS body limits and Zod bounds). The
  ALB does not replace them.
- **AWS WAF on the production ALB** (maintainer direction):
  - AWS managed common rule set and known-bad-inputs rule set;
  - one **deliberately generous per-IP rate-based rule**. Nigerian mobile carriers use carrier-grade NAT, so many
    legitimate users share one IP address; aggressive per-IP limits would block real merchants. The rule is a
    flood guard, not a per-user limit;
  - rules start in count mode, are reviewed against real traffic, then move to block;
  - WAF in development and staging is optional and off by default (cost).
- In-process API limiters remain local safeguards only and are never described as globally effective (ADR-005 section
  18). No Redis.
- **No business authorization in ALB or WAF rules.** Authentication and `BusinessContext` resolution stay in the API.
- The API sets `Strict-Transport-Security` on responses.
- ALB access logs: deferred (section 35 B).

## 9. RDS for PostgreSQL

### 9.1 Configuration by environment

| Setting | development | staging | production |
|---------|-------------|---------|------------|
| Engine | PostgreSQL 18 | PostgreSQL 18 | PostgreSQL 18 |
| Deployment | Single-AZ | Single-AZ | **Multi-AZ DB instance** (one standby) |
| Instance class | small burstable (Graviton) | small burstable (Graviton) | sized from measurement; start with the smallest class that keeps CPU credits and memory healthy under pilot load |
| Storage | gp3, autoscaling with a maximum | gp3, autoscaling with a maximum | gp3, autoscaling with a maximum |
| Encryption at rest | AWS-managed key | AWS-managed key | **customer-managed key** (section 21) |
| Backup retention | 1-3 days | 7 days | 35 days |
| PITR | on | on | on |
| Deletion protection | off | on | on |
| Final snapshot on delete | optional | yes | yes |
| Public access | no | no | no |

- **Version policy:** major version 18, matching CI (`postgres:18.6-alpine`). Minor versions are pinned in CDK and
  upgraded deliberately (automatic minor upgrade off), after CI passes on the new minor version. Major upgrades need a
  planned change with a pre-upgrade snapshot.
- **Aurora is not used.** No demonstrated requirement (read scaling, fast failover beyond Multi-AZ, storage scale)
  justifies its cost at pilot scale.
- **Parameter group** (custom, per environment): `rds.force_ssl = 1`; `idle_in_transaction_session_timeout` set;
  `log_min_duration_statement` for slow queries **without** parameter values in logs; `log_statement = none`;
  `pg_stat_statements` enabled. No setting that logs row data.
- **Maintenance window** outside Nigerian trading hours (for example early morning West Africa Time); backup window
  separate from the maintenance window.
- **Monitoring:** **Database Insights Standard** as the initial baseline, plus CloudWatch RDS metrics and RDS event
  notifications (section 22). Paid database observability (Database Insights Advanced, Enhanced Monitoring at fine
  granularity) is added only after a need is demonstrated.
- **Database roles** (already established; unchanged):
  - the RDS master user: created by RDS with an RDS-managed Secrets Manager secret; used only by the bootstrap task
    to create roles and the database; never used by the API, worker or migrations;
  - `tali_owner`: owns the database objects; used only by the migration task;
  - `tali_app`: runtime role for the API and worker; privileges granted by migrations only.
  - A read-only operator role for incident diagnosis may be proposed later; it is not part of this ADR.

### 9.2 Connection management: RDS Proxy

**Decision: RDS Proxy is not used initially; it is an optional later addition.**

- The API and worker are long-running Fargate processes with bounded pools (10 connections per process by default).
  Connection count is predictable: `(API tasks + worker tasks) x pool size + migration + admin`. Production at the
  initial maximum (for example 4 API + 2 worker tasks) needs about 60 connections, within the capacity of small
  instances.
- RDS Proxy adds cost and another component, and brings its own constraints (session pinning with some driver
  behaviors). It solves connection storms from short-lived compute, which Tali does not have.
- Pool size per process is configured explicitly per environment and documented next to the instance class.
- Revisit when: connections regularly exceed 70% of `max_connections`; autoscaling maxima grow materially; short-lived
  compute is introduced; or failover time needs improving beyond Multi-AZ.

## 10. Database administration and migrations

### 10.1 Migrations

- Migrations run as an **explicit one-off ECS/Fargate task** (`tali-<env>-migrate`), started by the deployment workflow
  and awaited. It runs `prisma migrate deploy` followed by the schema verification (`verify-schema`) from the same
  commit as the images being deployed.
- It uses the **migration role** (`tali_owner`) credentials from Secrets Manager. The API and worker task definitions
  never receive migration credentials.
- **Migrations never run on API or worker start**, and never concurrently. The deployment workflow allows one
  deployment per environment at a time.
- **Expand/contract discipline:** each migration must be compatible with the application version that is running
  when it is applied, because migrations run before the new code is deployed. Destructive changes are split across
  releases.
- Migrations remain forward-only (ADR-002 section 12). A failed migration stops the deployment; the fix is a new
  migration.
- Image: the migration task uses the same build as the API with a different command, unless the Prisma CLI footprint
  justifies a separate migrator image built from the same commit (implementation decision, section 35 B).

### 10.2 Environment bootstrap of the database

- A one-off **bootstrap task** runs `bootstrap-roles.sql` semantics once per environment using the RDS master secret.
  It generates the `tali_owner` and `tali_app` passwords inside AWS and stores them directly in Secrets Manager. The
  passwords never pass through a laptop, CI logs or the repository.

### 10.3 Emergency and operator access

| Option | Assessment |
|--------|------------|
| **ECS one-off admin task with ECS Exec** | **Chosen.** A dedicated admin task definition (PostgreSQL client tools only) in the private subnets, started on demand by `BreakGlassAdmin`, reached through ECS Exec (Session Manager channel). No inbound ports, no standing host. CloudTrail records who started it. |
| SSM Session Manager port forwarding through an EC2 instance | Deferred. Requires a managed instance to patch and monitor. |
| Client VPN | Deferred. Justified only if routine interactive database access becomes necessary. |
| Public RDS endpoint with IP allowlist | Rejected. |

- ECS Exec is **disabled** on the API and worker services. It is enabled only on the admin task definition.
- Emergency access is separate from application runtime: separate task definition, separate security group, separate
  credentials (initially the migration role for schema work; data corrections are never made by ad hoc SQL but through
  audited application actions, as ADR-005 requires).
- Each use is linked to an incident record.

## 11. ECS/Fargate

### 11.1 Services and task definitions

- One ECS cluster per environment.
- Services: `api` (behind the ALB) and `worker` (no load balancer). Separate task definitions, task roles, security
  groups, log groups and scaling policies.
- One-off task definitions: `migrate`, `db-bootstrap`, `admin`.
- The modular monolith is not split. The API and worker are two processes of the same codebase (ADR-001, ADR-002).

### 11.2 Task counts

| Service | development | staging | production |
|---------|-------------|---------|------------|
| API | 1 (may scale to 0 outside working hours) | 1 | **minimum 2, spread across both AZs** |
| Worker | 1 (may scale to 0 outside working hours) | 1 | 1 initially; 2 when the outbox relay exists (it claims with `SKIP LOCKED`, so parallel workers are safe) |

### 11.3 Sizing, scaling and health

- **Sizing:** start small (for example 0.5 vCPU / 1 GB for the API) and adjust from CloudWatch metrics. CPU
  architecture is x86_64 until arm64 images are verified with the Prisma driver adapter and all native dependencies
  (section 35 B).
- **API autoscaling:** target tracking on average CPU and ALB requests per target; production minimum 2, a modest
  maximum (for example 4) that fits the connection budget (section 9.2).
- **Worker scaling** is independent of API scaling. Initially a fixed count. Later signals: SQS backlog per task and
  age of the oldest message; outbox pending age.
- **Health:** the API uses the ALB health check on `/health/ready` plus a container health check on `/health/live`. The
  worker uses a container health check on heartbeat freshness (the existing heartbeat file). ECS replaces unhealthy
  tasks.

### 11.4 Deployment strategy

- Rolling deployment with minimum healthy 100% and maximum 200% for the API in production.
- **ECS deployment circuit breaker with automatic rollback** on all services.
- Blue/green deployment is deferred until rolling deployment proves insufficient.

### 11.5 Graceful shutdown

- `SHUTDOWN_GRACE_PERIOD_MS` (application) < ALB deregistration delay < ECS `stopTimeout`, set consistently (for
  example 10 s, 20 s and 30 s). The API stops accepting new requests and drains; the worker stops claiming and finishes
  or releases in-flight work.

### 11.6 Configuration, secrets and logs

- Non-secret configuration (`TALI_ENV`, Cognito region, pool ID and client IDs, bucket name, queue URL, CORS origins,
  log level) is passed as plain task environment values from CDK outputs.
- Secrets are injected through the ECS task definition `secrets` field from Secrets Manager (section 20).
- Logs go to CloudWatch Logs with the `awslogs` driver, one log group per environment and service.
- Task roles: the API role may presign S3 operations on its bucket and send nothing to SQS (only the relay publishes;
  see section 18); the worker role may send, receive and delete on its queue and read/write its bucket. No wildcard
  resources.

## 12. Worker

- The worker is a separate process of the same repository and backend (`apps/worker`), scaled on its own. API replica
  count never determines worker replica count, and vice versa.
- It will host, as they are implemented:
  - the **outbox relay** (ADR-004 section 10);
  - **SQS consumers** (idempotent via `processed_messages`);
  - **scheduled jobs** (section 18).
- SQS is never the source of truth. If SQS is unavailable, work stays in the PostgreSQL outbox and is published later.

## 13. ECR

- Repositories per workload account: `tali/api` and `tali/worker`. The migration and admin tasks use the API image with
  a different command unless a separate image is justified (section 10.1).
- **Tag immutability enabled.** Images are tagged with the full git commit SHA. Deployments reference the **image
  digest**. No mutable `latest` tag is used as a deployment identity.
- **Build once, promote the same digest:** CI builds the image once, pushes it to the non-production registry, and on
  promotion copies the same digest to the production registry. Production never pulls from the non-production account.
- **Scanning:** ECR basic scanning on push in every account. A CRITICAL finding blocks deployment unless a documented,
  time-limited exception is recorded. Enhanced scanning (Amazon Inspector) is deferred (section 35 B).
- **Lifecycle:** untagged images expire after 7 days; keep the most recent N SHA-tagged images (for example 30) and any
  image currently referenced by a task definition in use.

## 14. Amazon Cognito

### 14.1 User pools

- **One user pool per AWS environment** (development, staging, production), in that environment's account. Deletion
  protection on staging and production pools.
- Sign-in attribute: **email** (case-insensitive). Required attribute: email, verified. No other standard attributes are
  collected.
- **No Tali roles, memberships, business IDs, device IDs or permissions** are stored in Cognito. No custom attributes or
  groups are used for authorization. **No Cognito triggers** (Lambda) are configured, because triggers would place
  logic outside the NestJS application (ADR-001).
- User existence errors are prevented (generic errors on sign-in and recovery).
- Password policy: minimum length 10, no forced composition rules beyond what Cognito requires; recovery by verified
  email only.
- MFA: optional, TOTP only (no SMS MFA). Step-up re-authentication remains deferred (ADR-005); `authTime` is available
  for it.
- Feature plan: the lowest Cognito feature plan that supports refresh-token rotation and the settings above (Essentials
  at the time of writing; re-check at implementation). Advanced threat protection features of higher plans are not
  adopted initially.

### 14.2 App clients

| App client | Type | Client secret | Auth flows | Refresh token |
|------------|------|---------------|------------|---------------|
| `tali-<env>-web` | public | none | `ALLOW_USER_SRP_AUTH` | 12 hours, rotation on |
| `tali-<env>-mobile` | public | none | `ALLOW_USER_SRP_AUTH` | 7 days, rotation on |

- Browser and mobile apps cannot keep a client secret, so both clients are public and have none.
- `ALLOW_USER_PASSWORD_AUTH`, `ALLOW_ADMIN_USER_PASSWORD_AUTH` and `ALLOW_CUSTOM_AUTH` are **not** enabled.
- `ALLOW_REFRESH_TOKEN_AUTH` is **not** enabled, because refresh-token rotation is enabled (section 14.4).
- Token revocation is enabled on both clients.
- Hosted UI / Managed Login and OAuth flows are not enabled initially (custom UI; section 14.3).
- The API's `COGNITO_CLIENT_IDS` allowlist contains exactly these two client IDs for its environment.

### 14.3 Sign-in methods and UX (private pilot)

- **Email + password** is the pilot sign-in method. Most Android users already have an email (Google) account, and it
  avoids SMS cost, sender-ID registration and deliverability risk in Nigeria.
- **Phone/SMS sign-in is deferred.** It would require SMS delivery through Amazon SNS, Nigerian sender-ID handling and a
  deliverability trial. It needs a later decision.
- **Custom in-app UI** in the web and mobile apps (sign up, confirm code, sign in, forgot password, sign out). The
  Cognito client library is isolated in each app's `src/lib/auth` (ADR-002 section 6) and is a dependency reviewed in
  the client sign-in slice. Clients never use AWS service SDKs or hold AWS credentials.
- Managed Login (hosted UI) with authorization code + PKCE was considered. Not chosen now: browser redirects are
  clumsy on shared shop devices, and branding and language control are limited. It remains a later option.
- **Self sign-up is enabled for the private pilot.** Any pilot gating, if required, is enforced by Tali application
  logic, never by Cognito triggers.
- **Product gap: staff without email.** Every staff member needs their own Cognito identity with an email address.
  Staff who have no email address cannot sign in under this design. This is a **product gap that must be resolved
  before broad rollout** (for example phone sign-in after an SMS trial, or another approved design). It is not resolved
  by this ADR.

### 14.4 Tokens, refresh and sign-out

| Token | Lifetime | Where held |
|-------|----------|------------|
| Access token | 15 minutes | web: memory; mobile: memory |
| ID token | 15 minutes | not sent to the API; the API accepts access tokens only |
| Refresh token, web | 12 hours | memory only (lost on reload; matches the current in-memory web posture) |
| Refresh token, mobile | 7 days | `expo-secure-store` (Android Keystore), partitioned by user |

- **Initial authentication** uses `USER_SRP_AUTH` (the password is never sent to Cognito in clear form).
- **Refresh-token rotation is enabled** on both app clients, with a **retry grace period of 10 seconds** so a client
  that loses a refresh response on a poor network can retry once without being signed out.
- With rotation enabled, `REFRESH_TOKEN_AUTH` is **not** enabled or used. Clients refresh with
  **`GetTokensFromRefreshToken`** (or its vetted SDK equivalent), which returns a new refresh token; the client
  replaces the stored one.
- **Sign-out:** the client calls `RevokeToken` for its refresh token and deletes all local tokens. "Sign out on all
  devices" uses `GlobalSignOut`.
- **Residual validity window.** The API verifies access tokens locally against the JWKS. `RevokeToken` and
  `GlobalSignOut` cannot make an already-issued JWT stop verifying offline. The **15-minute access-token lifetime is
  therefore the maximum residual token-validity window**. Within it, Tali's independent checks still apply on every
  request: User status (DISABLED), Business Membership status and Device status (ADR-005). Disabling a user,
  suspending a membership or revoking a device takes effect on the next request regardless of token lifetime.
- Offline mobile use: queued commands do not need a valid token while offline. On reconnect the app refreshes; if the
  refresh token has expired, the same user signs in again and the queue (partitioned by business and user) syncs. The
  sync ADR decides the rest.

### 14.5 Shared physical devices

- Each staff member signs in with their own Cognito identity; actions are attributed to the signed-in user
  (`70-security.mdc`, ADR-005 section 15).
- **One active staff session per device at a time.** Switching staff is sign-out (revoke and wipe) followed by the next
  person's sign-in. The app does not keep several staff members' refresh tokens at once in the pilot.
- **Tali Device registration is independent of Cognito.** The device credential (ADR-005 section 15) identifies the
  device to Tali and never authenticates a user. Cognito knows nothing about Tali devices.

### 14.6 Provisioning after authentication

1. The user signs up in the custom UI; Cognito sends a verification code to the email; the user confirms.
2. The user signs in (SRP) and receives tokens.
3. The client calls `GET /v1/me`. If the result is `403 USER_NOT_REGISTERED`, the client shows registration and calls
   `POST /v1/me/registration` with a display name (ADR-005 section 11).
4. The API maps Cognito `sub` to `external_identities.provider_subject` with `provider = COGNITO`.
- Tali does **not** copy the email into its database (ADR-005: no email or phone columns in Build 1). Users are never
  matched or merged by email.
- Invitations remain bearer invitations (ADR-005 section 14), unchanged by Cognito.

### 14.7 Cognito email

- Verification and recovery emails use **Cognito's default email configuration**. It currently has a quota of
  **50 emails per day** for the account. That is acceptable **only for the private pilot**.
- The default sender is **not suitable for broader rollout** (quota, sender identity and deliverability).
- **Amazon SES remains deferred** (ADR-001). Moving Cognito email to SES requires its own decision before broad rollout.
- Operators monitor the quota; exhaustion blocks sign-ups and password recovery, not sign-in of existing users.

## 15. Cognito adapter verification contract (Build 1 Slice 6)

This records the contract the Slice 6 adapter must meet. It needs no AWS account and makes no AWS network calls in CI.

- Location: `packages/integrations/src/aws/cognito`, implementing the existing `IdentityProvider` port.
- **JWKS:** fetched from `https://cognito-idp.<COGNITO_REGION>.amazonaws.com/<COGNITO_USER_POOL_ID>/.well-known/jwks.json`,
  built from **configuration only**, never from the token's `iss` or any header (SSRF protection). Cached in memory.
  On an unknown `kid`, the cache is refreshed, with refreshes rate-limited (for example at most once per 60 seconds).
  Fetches have a timeout. If no usable key is available, verification fails closed.
- **Algorithm:** RS256 only. Tokens with `alg: none`, any other algorithm, or no `kid` are rejected. `jku`, `x5u` and
  embedded keys are ignored.
- **Issuer:** exact match with `https://cognito-idp.<region>.amazonaws.com/<userPoolId>`.
- **`token_use`** must equal `access`. ID tokens are rejected.
- **`client_id`** must be in the `COGNITO_CLIENT_IDS` allowlist.
- **`exp`** must be in the future and **`iat`** must not be in the future, both using the server `Clock` with an accepted
  clock skew of **at most 60 seconds (30 seconds recommended)**.
- **`sub`** becomes `providerSubject`. **`auth_time`** becomes `authTime`.
- **No authorization from claims.** `cognito:groups`, `scope`, custom claims and `username` are never used for
  authorization.
- **Tali User `DISABLED`** is enforced independently on every request by the context resolver (ADR-005), whatever the
  token's validity.
- A valid token whose subject has no external identity leads to `USER_NOT_REGISTERED`.
- Tokens, full subjects and claims are never logged (subjects masked to the last 4 characters).
- **Tests** use locally generated RSA keys and local JWKS fixtures: valid token, wrong issuer, wrong `token_use`,
  unknown client, expired, `iat` in the future, skew boundary, unknown `kid` with refresh, refresh rate limit, wrong
  algorithm, missing `kid`, JWKS fetch failure. No AWS calls in CI.

## 16. Amazon S3

### 16.1 Upload architecture

| Option | Assessment |
|--------|------------|
| A. Client -> API -> S3 | Rejected as the default. Large media on slow mobile networks would tie up API tasks, memory and timeouts, and increase cost. |
| **B. Client -> API (authorize, presign) -> direct upload to S3** | **Chosen.** Authorization stays in Tali; Fargate does not proxy large media. |

Flow:

1. The client asks the API for an upload for a specific purpose. The API resolves `BusinessContext`, checks permission,
   validates the declared type and size, and generates the object key.
2. The API returns a **presigned POST** scoped to that one key, with `content-length-range` and `Content-Type`
   conditions, valid for a short time (the existing `SIGNED_URL_TTL_SECONDS`, 300 seconds by default).
3. The client uploads directly to S3.
4. The client confirms the upload through the API. The object stays `pending` until the worker validates the content
   (magic bytes, size, format) and the application records it.
5. Downloads use API-issued presigned GET URLs for one object, short-lived, with `Content-Disposition: attachment`.

### 16.2 Bucket and objects

- One private **media bucket per environment**. Block Public Access on at bucket and account level. Bucket policy
  denies non-TLS requests. ACLs disabled (bucket owner enforced).
- Keys are generated by the server: `pending/businesses/<businessId>/<purpose>/<uuid>` until validated, then
  `businesses/<businessId>/<purpose>/<uuid>`. Prefixes are organization and provenance, **not** an authorization boundary
  (ADR-001 section 8).
- Object metadata: content type, upload ID and correlation ID only. No personal data in metadata or keys beyond the
  business UUID.
- Encryption: production uses SSE-KMS with the production media customer-managed key and an S3 Bucket Key; non-
  production uses SSE-S3.
- CORS: only the environment's web origins, only the methods the presigned flow needs.
- Clients never receive AWS credentials; they receive only single-object, single-operation presigned requests.
- Uploaded content is never rendered as trusted HTML or script.

### 16.3 Lifecycle, retention and scanning

- Abort incomplete multipart uploads after 1 day.
- Expire objects under `pending/` after 2 days.
- Production: versioning on, non-current versions expire after 30 days. Non-production: versioning off.
- **No retention period for confirmed media is set** until the retention policy is decided (open decision 14; legal).
  No S3 Object Lock initially. Deletion of confirmed media follows the future retention and erasure policy, never an
  ad hoc cleanup.
- **Malware and media validation boundary:** the worker validates structure and type before an object leaves
  `pending`. Malware scanning (for example GuardDuty Malware Protection for S3) is deferred until uploads exist and the
  threat model requires it. S3 event notifications never carry business logic.
- The bucket is created with the first deployed environment because deployed configuration requires `s3` (section 1).

## 17. Amazon SQS

- **Queue type: Standard, not FIFO.** Tali's correctness does not depend on queue ordering: state lives in PostgreSQL,
  state machines reject invalid transitions, and consumers are idempotent through `processed_messages` (ADR-004). FIFO
  would add throughput limits and message-group design without removing the need for idempotency.
- **Initial queues per environment:** one `tali-<env>-jobs` queue and one `tali-<env>-jobs-dlq`. This matches the
  single `SQS_QUEUE_URL` in configuration. Queues are split by workload class (for example slow document extraction)
  when a real workload needs it.
- **Settings:**
  - long polling, 20 seconds;
  - visibility timeout longer than the longest handler run, with visibility extension for long jobs;
  - `maxReceiveCount` 5, then the message moves to the DLQ;
  - retention 4 days on the main queue, 14 days on the DLQ;
  - SSE-SQS encryption.
- **Messages:** an envelope with message type, schema version, message ID, `businessId`, actor reference, correlation ID
  and dedupe key; payloads are IDs and references, target under 16 KiB (hard limit 256 KiB). **No secrets, tokens or
  personal data in messages.**
- **Retries and redrive:** SQS redelivers until `maxReceiveCount`; DLQ messages raise an alarm; redrive to the main
  queue is an operator action after the cause is fixed. Consumers must tolerate redelivery.
- The queue is created with the first deployed environment because deployed configuration requires `sqs` (section 1).

## 18. Transactional outbox deployment

```
API use case -> PostgreSQL transaction (business change + audit + outbox_messages row)
             -> worker relay claims rows (FOR UPDATE SKIP LOCKED, short lease)
             -> publishes to SQS -> marks PUBLISHED
             -> worker consumer receives -> processed_messages dedupe + effects in one transaction -> deletes message
```

- The **outbox in PostgreSQL is the source of truth** for pending side effects. SQS is transport only.
- Relay failures back off; after bounded attempts a row is marked `FAILED` for operator attention (ADR-004 section 10).
  Outbox `FAILED` and the SQS DLQ are separate signals, both alarmed.
- Consumers rebuild and re-validate `BusinessContext` from the database before invoking a use case.
- Transaction correctness never moves into SQS. Nothing is implemented by this ADR.

## 19. Scheduler

| Option | Assessment |
|--------|------------|
| **Worker-owned, database-backed schedule** | **Chosen.** Scheduled jobs are rows with a next-run time, claimed by any worker with a lease (`FOR UPDATE SKIP LOCKED`), so they run once even with several workers. No new AWS service. Same claiming pattern as the outbox. |
| EventBridge Scheduler -> SQS -> worker | Not chosen now. Adds a service and IAM; useful mainly if the worker scales to zero in production. Revisit then. |
| Cron inside API replicas | Rejected. Every replica would fire; mixes background work into HTTP scaling. |

- Scheduled work runs as Tali application use cases in the worker. The scheduler holds no business logic.
- Not implemented by this ADR.

## 20. AWS Secrets Manager

- **In Secrets Manager:**
  - the RDS master secret (RDS-managed; bootstrap only);
  - `tali/<env>/database/app` (`tali_app` credentials);
  - `tali/<env>/database/migration` (`tali_owner` credentials);
  - future provider credentials (payment provider, WhatsApp provider, AI provider keys).
- **Not in Secrets Manager** (plain configuration from CDK): public API URL, Cognito region, pool ID and client IDs,
  bucket name, queue URL, environment name, CORS origins.
- **Injection:** the ECS task definition `secrets` field. The **task execution role** has `GetSecretValue` only on the
  exact secret ARNs for that task. The API and worker receive only the app secret; only the migration task receives the
  migration secret; only the bootstrap task receives the master secret. Task roles have no Secrets Manager access unless
  a later runtime need is approved.
- The current configuration takes a full `DATABASE_URL`. Whether the secret stores a composed URL or the configuration
  composes it from parts is an implementation decision for the infrastructure slice (section 35 B).
- **Rotation:** the RDS master secret uses RDS-managed rotation. App and migration secrets are rotated manually with a
  rolling restart until automated rotation (with restart coordination) is designed.
- Secrets are never baked into images, CDK source, CI configuration or client bundles.

## 21. AWS KMS

- **Default: AWS-managed encryption** (RDS, S3 SSE-S3, SQS SSE-SQS, Secrets Manager, CloudWatch Logs, ECR) in all
  environments.
- **Customer-managed keys, production only:**
  - `tali-prod-database`: production RDS storage and snapshots. Chosen now because an RDS instance's key cannot be
    changed without a snapshot restore, and a customer-managed key keeps later cross-account or cross-Region backup
    copies possible;
  - `tali-prod-media`: production media bucket (with an S3 Bucket Key to reduce request cost).
- Non-production uses AWS-managed keys unless an implementation requirement says otherwise.
- **No keys per tenant or per table.**
- Key policy: separate key administrators (CDK deploy role, `BreakGlassAdmin`) and key users (the RDS service, the
  specific task roles for media). No wildcard principals. Annual automatic rotation on. 30-day deletion waiting period.
  Key use is visible in CloudTrail.

## 22. Observability

- **Log groups:** `/tali/<env>/api`, `/tali/<env>/worker`, `/tali/<env>/migrate`, `/tali/<env>/admin`.
- **Retention:** development 14 days, staging 30 days, production 90 days (pending legal review of retention; section 35
  C). Application logs are not the audit trail; audit records live in PostgreSQL (ADR-004).
- **Structured JSON logs** with correlation IDs, using the existing logger redaction. No secrets, tokens, OTPs,
  passwords, full identifiers, display names or contact details (`70-security.mdc`).
- **Alarm delivery:** one **SNS topic per environment** for CloudWatch alarm notification, with email subscribers for
  the maintainers. This is infrastructure alert delivery only, not application email or SMS messaging.
- **Alarms (production; a reduced set in staging):**
  - ALB 5xx, target 5xx rate, p95 target response time, unhealthy host count;
  - ECS running task count below desired (API and worker), repeated task stops;
  - RDS CPU, free storage space, database connections, freeable memory; RDS events for failover, backup failure and
    storage issues;
  - SQS visible messages and age of oldest message; **DLQ visible messages > 0**;
  - outbox pending age and `FAILED` count (worker-published metrics, once the outbox exists);
  - WAF blocked-request spikes;
  - Cognito sign-up/recovery email quota approaching (operator check until a metric is available).
- **Dashboard:** one per environment with the metrics above.
- **Container Insights:** production only.
- **Tracing: deferred.** One modular monolith plus a worker is diagnosable with correlation IDs in logs. When a concrete
  need appears (multi-hop async flows, external providers), OpenTelemetry is the preferred path. AWS X-Ray SDK
  instrumentation is not adopted.

## 23. CI/CD (GitHub Actions with AWS OIDC)

### 23.1 Trust

- A GitHub OIDC identity provider in each workload account.
- Roles per environment, each trusting only `token.actions.githubusercontent.com` with `aud = sts.amazonaws.com` and a
  `sub` of `repo:<org>/<repo>:environment:<env>`:
  - `tali-<env>-image-push`: push to that account's ECR repositories only;
  - `tali-<env>-deploy`: register task definitions, update the environment's ECS services, run its migration task,
    `iam:PassRole` only for that environment's named task and execution roles;
  - `tali-<env>-cdk-deploy`: assume the CDK bootstrap deployment roles; used by the infrastructure workflow only.
- **No static AWS access keys** anywhere. Pull requests and forks never receive `id-token: write` or any AWS role.
- GitHub Environments: `development`, `staging`, `production`. **Production requires protected-environment approval**
  (required reviewers) and deploys only from `main`.

### 23.2 Sequence (conceptual; not implemented here)

1. **Verify:** the existing CI checks pass.
2. **Build** the API and worker images once from the commit.
3. **Scan** the images; CRITICAL findings stop the pipeline (section 13).
4. **Push** with the commit SHA tag; record the digest.
5. **Run the migration task** with that digest; wait; non-zero exit stops the deployment.
6. **Deploy** new task definition revisions referencing the digest to the API and worker; wait for service stability.
7. **Smoke check** `/health/ready` through the public endpoint and confirm the worker heartbeat.

Development deploys automatically from `main`. Staging deploys the same digest after development succeeds. Production
deploys the same digest after staging succeeds and approval is given.

### 23.3 Safe failure

- Migration failure: stop; no service is updated; fix forward with a new migration.
- Deployment or smoke failure: the ECS circuit breaker (or the workflow) rolls back to the previous task definition.
  The expand/contract rule (section 10.1) keeps the previous version compatible with the migrated schema.
- Migrations are never rolled back automatically.
- One deployment per environment at a time; an in-progress deployment is never cancelled by a newer run.
- Infrastructure (CDK) changes use a separate workflow with a reviewed diff and the same environment approvals.

## 24. Web hosting

**Decision: AWS Amplify Hosting remains the preferred candidate but is not confirmed by this ADR.**

- The repository pins **Next.js 16.3.6**. At the time of writing, AWS Amplify Hosting documentation officially lists
  Next.js support only through version 15.
- **Final web-host selection is deferred to an infrastructure implementation spike.** The spike must prove that the
  candidate supports the repository's exact pinned Next.js version and the features the app uses (App Router build,
  the build-time public-configuration guard in `next.config.ts`, public-only `NEXT_PUBLIC_*` environment variables per
  environment, custom domains with TLS, security headers).
- If Amplify fails the spike, the **smallest suitable alternative** is evaluated and recorded (for example a static
  export served from a private S3 bucket through Amazon CloudFront, if the app remains client-only, or the web app as an
  additional ECS service behind the existing ALB). Any new service needs its own approval.
- Constraints on whichever host is chosen:
  - the web app is **not another authoritative backend**: it renders and calls Tali's API, holds no server secrets, no
    database access and no business rules (ADR-002 section 9);
  - only public configuration is supplied to the build;
  - preview deployments only in non-production, pointing only at the development API; never production data;
  - the API's CORS allowlist lists exactly the environment's web origins.
- **This decision does not block Build 1 Slice 6.**

## 25. DNS and TLS

- The repository does not own a domain yet. `<root-domain>` is a placeholder until a domain is chosen.
- Hosted zones:
  - `<root-domain>` in the production account;
  - `dev.<root-domain>` and `staging.<root-domain>` delegated to hosted zones in the non-production account.
- Names:
  - API: `api.<root-domain>`, `api.staging.<root-domain>`, `api.dev.<root-domain>`;
  - web: `app.<root-domain>`, `app.staging.<root-domain>`, `app.dev.<root-domain>`.
- ACM public certificates, DNS-validated, in the ALB's Region. The web host's certificate follows the chosen host
  (section 24).
- HTTPS only for all external traffic. HTTP is redirected to HTTPS at the ALB.
- If no domain is available when the first development environment is deployed, it may temporarily use the ALB's
  AWS-provided DNS name only if TLS can still be enforced; otherwise the first deployment waits for the domain.

## 26. Backup, RPO and RTO

| Environment | RPO | RTO | Mechanism |
|-------------|-----|-----|-----------|
| production, AZ failure | about 0 (synchronous standby) | minutes (Multi-AZ failover); target under 1 hour end-to-end | Multi-AZ DB instance, 2 API tasks across AZs |
| production, data corruption or operator error | about 5 minutes | up to 4 hours | PITR restore to a new instance, then cut-over |
| staging | 24 hours | 1 business day | automated backups |
| development | best effort | 1 business day | rebuild from migrations and synthetic seeds |

- **Automated backups and PITR** as in section 9.1. **Manual snapshots** before releases that contain migrations.
- **Restore testing:** quarterly, **inside the production account**, into a temporary isolated instance that is
  checked (migrations status, `verify-schema`, row counts, ledger balance checks once the ledger exists) and then
  deleted. Production data never goes to a lower environment for this.
- **S3:** relies on S3's regional durability; production versioning protects against overwrite and accidental deletion
  within the non-current retention window.
- **Infrastructure** is recreated from CDK; nothing in AWS is configured by hand beyond account bootstrap (section 30).
- **Not built:** multi-Region disaster recovery. Region loss has no defined RPO/RTO. A cross-Region or cross-account
  backup copy is a decision to take before production launch (section 35 B and C, because it affects data location).

## 27. Cost controls

- **AWS Budgets** per account with alerts at 50%, 80% and 100% of actual and forecast spend, delivered by email and the
  alarm SNS topic. **Cost Anomaly Detection** enabled.
- **Tagging** (section 28), with cost-allocation tags activated in the management account.
- **Non-production:** development ECS services scale to zero outside working hours through scheduled scaling;
  development RDS may be stopped when idle (it restarts automatically after 7 days); small burstable RDS classes;
  single NAT Gateway; no WAF by default; shorter log retention.
- **ECR lifecycle** and **log retention** as above.
- **Production security is not reduced for cost** (Multi-AZ RDS, two API tasks, NAT per AZ, WAF, customer-managed keys
  stay).
- **Relative cost hierarchy** for a pilot, highest baseline first (no exact prices are claimed):
  1. production Multi-AZ RDS instance;
  2. NAT Gateways (hourly plus data processing);
  3. always-on Fargate tasks;
  4. Application Load Balancers;
  5. AWS WAF (web ACL, rules, requests); interface VPC endpoints if later added (hourly per AZ);
  6. CloudWatch log ingestion and custom metrics;
  7. Cognito monthly active users above the free allowance;
  8. KMS customer-managed keys, Secrets Manager secrets, S3, SQS and ECR storage (small at pilot scale).

## 28. Tagging

Minimum tags on every taggable resource, applied by CDK:

| Tag | Values |
|-----|--------|
| `Application` | `Tali` |
| `Environment` | `development`, `staging`, `production` |
| `ManagedBy` | `CDK` |
| `Component` | for example `network`, `data`, `identity`, `compute`, `web`, `observability` |
| `Owner` | the maintaining team |
| `CostCenter` | as assigned |
| `DataClassification` | `public`, `internal`, `confidential`, `restricted` where useful (for example RDS and media bucket: `restricted`) |

Tags never contain personal data, business IDs or secrets.

## 29. Infrastructure as code

- **AWS CDK in TypeScript** under `infrastructure/cdk`, created only after this ADR is accepted.
- Intended stacks:
  - account baseline (per account): organization CloudTrail (management), budgets, GitHub OIDC provider and roles,
    alarm SNS topic;
  - per environment: `Network`; `Data` (KMS, RDS, secrets, media bucket, SQS); `Identity` (Cognito); `Registry` (ECR,
    per account); `Compute` (ACM certificate, ALB, WAF, ECS cluster, services and one-off task definitions); `Web`
    (after the hosting spike); `Observability` (alarms, dashboards).
- Stacks are split only where dependencies stay one-directional. If a split creates awkward cross-stack references, the
  stacks are merged.
- Stateful resources (RDS, buckets, user pools, keys) use retain/snapshot removal policies and deletion protection.
- No CDK code is part of this ADR.

## 30. Environment bootstrap

Before the first development environment can be deployed:

1. Management account, AWS Organizations, IAM Identity Center and the non-production and production accounts (manual,
   unavoidable account bootstrap).
2. `cdk bootstrap` in each workload account and the chosen Region.
3. The account baseline stack: GitHub OIDC provider and trust, deploy roles, organization CloudTrail, budgets, SNS
   alarm topic.
4. DNS: the domain and delegated hosted zone, if a domain is available (section 25).
5. The `Network`, `Data` and `Identity` stacks.
6. The database bootstrap task creates `tali_owner` and `tali_app` and seeds their secrets inside AWS (section 10.2).
7. The first migration task run.
8. Then compute, observability and the deploy workflow.

No manual snowflake infrastructure is created beyond steps 1 and 2.

## 31. Rollout order after acceptance

1. Accounts, Organizations, Identity Center (bootstrap).
2. Account baselines: CloudTrail, budgets, OIDC, deploy roles, SNS.
3. DNS (if the domain exists).
4. Network (development first).
5. Data: KMS (production only), RDS, secrets, media bucket, SQS.
6. Identity: Cognito user pool and app clients.
7. ECR repositories.
8. Database bootstrap task and first migration task.
9. Compute: ACM, ALB, ECS services (API and worker).
10. Observability: alarms and dashboard.
11. Deploy workflow (GitHub Actions with OIDC).
12. Web-host spike and web hosting.
13. Staging, then production with WAF, customer-managed keys and the production conditions (section 4.2).

**Adapter work versus provisioning:**

- **Build 1 Slice 6 (the Cognito verification adapter) may start once this ADR is accepted**, independently of any
  AWS provisioning, because its tests use local JWKS fixtures and CI makes no AWS calls.
- Client sign-in UI (web and mobile) with a reviewed Cognito client library is a separate later slice.
- Real AWS provisioning follows the order above and is a separate implementation track.

## 32. Security model summary

- **Least privilege:** separate task roles per workload; execution roles limited to exact secret ARNs; per-environment
  CI roles; Identity Center permission sets; no wildcard resource grants without review.
- **Private RDS** in isolated subnets, reachable only from Tali task security groups; TLS enforced.
- **TLS** for all external traffic (ACM on the ALB, the web host's TLS); HSTS.
- **Encryption at rest** everywhere; customer-managed keys for production RDS and media.
- **Secret separation:** app, migration and master secrets per environment, each available only to the task that
  needs it.
- **No AWS credentials in clients.** Clients receive only Cognito tokens and single-object presigned requests.
- **OIDC CI** without static keys, restricted by repository and GitHub Environment; production approval required.
- **Separate identities per environment:** separate user pools, accounts and roles.
- **Logging hygiene:** CloudWatch logs follow the redaction rules; no tokens or personal data.
- **Database roles:** runtime `tali_app` without DDL or DELETE; migrations only as `tali_owner`; master user only for
  bootstrap.
- **No production data in lower environments.**
- **Tali authorization is not weakened by Cognito.** Cognito proves identity only; User, Membership and Device checks
  happen in Tali on every request, and no authorization comes from Cognito groups or claims.

## 33. Failure domains

| Failure | Initial protection |
|---------|--------------------|
| One AZ lost | Production: Multi-AZ RDS failover, API tasks in both AZs, NAT per AZ, ALB across AZs |
| One API task crashes | ALB health checks and ECS replacement; production keeps at least one other task |
| Worker task crashes | ECS replaces it; work waits in the outbox and SQS (delay, no loss) |
| Consumer keeps failing on a message | `maxReceiveCount`, then DLQ with alarm |
| Bad deployment | Circuit breaker rollback; expand/contract migrations |
| Non-production NAT or AZ lost | Not protected (single NAT; accepted) |

**Not protected initially:**

- loss of the whole Region (no multi-Region deployment or DR);
- a regional Cognito outage (no sign-in or token refresh; already-issued access tokens keep working until expiry);
- compromise of an AWS account or of the deployment pipeline beyond the controls above (no separate backup account
  yet);
- a single worker task in production is a short-term availability gap for background work;
- exhaustion of the Cognito default email quota (section 14.7).

## 34. Human decision table

| Topic | Recommended choice | Alternative considered | Reason | Cost implication | Security/reliability implication | Needs legal/product confirmation? |
|-------|--------------------|------------------------|--------|------------------|----------------------------------|-----------------------------------|
| Region | eu-west-1 primary, eu-west-2 fallback (maintainer direction) | af-south-1; Lagos Local Zone; eu-west-2 primary | Service coverage, maturity, cost, Lagos routes | Lower than af-south-1 | Single Region; Region loss not covered | **Legal: yes** (cross-border transfer); latency measurement before production |
| Accounts | Management + non-production (dev, staging) + production; Organizations; Identity Center (maintainer direction) | One account; one account per environment | Strong production isolation with fewest accounts | Minimal | Production blast radius isolated; staging shares an account with development | No |
| VPC | Per-environment VPC, 2 AZs, public/private/isolated subnets | Public tasks without NAT | No public tasks or database | NAT is a top baseline cost | Private compute and database | No |
| NAT | One per AZ in production, one per VPC in non-production | Interface endpoints only | Egress needed for Cognito and providers | Moderate | Non-production single point of failure accepted | No |
| VPC endpoints | S3 gateway only; interface endpoints deferred | Full interface endpoint set | Cost versus benefit at pilot scale | Avoids hourly per-AZ charges | Traffic to AWS APIs goes via NAT (TLS) | No |
| API entry | Route 53, ACM, ALB, ECS | API Gateway; CloudFront in front | Simplest path for containers | ALB hourly plus LCU | TLS 1.2+, no business rules at the edge | No |
| WAF | Production WAF on ALB, managed common rules, generous IP rate rule (maintainer direction) | No WAF; strict per-IP limits | Distributed abuse protection without Redis; CGNAT | WAF charges in production only | Flood protection; generous limit avoids blocking shared carrier IPs | No |
| Admin DB access | ECS one-off admin task with ECS Exec, break-glass only | SSM via EC2; Client VPN; public RDS | No standing host, no inbound ports | Pay per use | Audited, time-bound access | No |
| RDS topology | PostgreSQL 18; Multi-AZ instance in production; Single-AZ elsewhere; gp3 | Aurora; Multi-AZ cluster | Meets needs at pilot scale | Multi-AZ doubles instance cost in production | AZ failure covered in production | No |
| RDS backups | 35 days production, 7 staging, 1-3 development; PITR; quarterly restore test in production account | Shorter retention | Recovery from operator error | Small backup storage cost | RPO about 5 minutes | No |
| RDS monitoring | Database Insights Standard; paid options only on demonstrated need (maintainer direction) | Advanced insights now | Cost discipline | Low | Adequate baseline visibility | No |
| RDS Proxy | Not initially | Proxy from day one | Persistent processes, bounded pools | Avoids proxy cost | Revisit on connection pressure | No |
| Migrations | One-off ECS task as `tali_owner`, awaited by CI, expand/contract | Run on API start | No concurrent migrations; role separation | Pay per run | Runtime role never gets DDL | No |
| ECS API | Minimum 2 tasks in production across AZs; 1 elsewhere; rolling with circuit breaker | Single task; blue/green | Availability at low cost | Two always-on tasks in production | Survives a task or AZ loss | No |
| ECS worker | Separate service, fixed count, independent scaling | Worker inside API | Isolation of background work | One always-on task per environment | Short delay if the worker fails; no loss | No |
| ECR | Per-account repositories, immutable SHA tags, deploy by digest, promote same digest, basic scan, lifecycle | Shared registry; `latest` | Traceable, reproducible deployments | Small | No mutable deployment identity | No |
| Cognito pools and clients | One pool per environment; public web and mobile clients, no secret; SRP | Shared pool; confidential clients | Environment isolation; clients cannot keep secrets | MAU-based | No cross-environment identities | No |
| Cognito sign-in | Email + password, custom UI, self sign-up for pilot, phone/SMS deferred (maintainer direction) | Phone + SMS OTP; Managed Login | Avoids SMS cost and deliverability risk | No SMS spend | Password + optional TOTP | **Product: yes** (staff without email before broad rollout) |
| Cognito tokens | Access 15 min, ID 15 min, web refresh 12 h memory only, mobile refresh 7 days SecureStore, rotation on, 10 s grace (maintainer direction) | Default 60-minute tokens; `REFRESH_TOKEN_AUTH` | Short residual validity; rotation | None | 15-minute maximum residual token window, plus Tali checks | No |
| Cognito email | Default Cognito email (50 per day) for private pilot only; SES deferred (maintainer direction) | SES now | Scope and cost | None now | Quota exhaustion blocks sign-up/recovery | **Product: yes** (SES decision before broad rollout) |
| S3 uploads | Presigned POST direct upload after API authorization; worker validation | Upload through API | No large-media proxying; authorization in Tali | Lower compute cost | Single-object, short-lived, size-limited | No |
| S3 lifecycle | Abort multipart 1 day, expire pending 2 days, production versioning; no media retention yet | Fixed retention now | Retention needs legal input | Small | Orphans cleaned up | **Legal: yes** (media retention) |
| SQS | Standard queue + DLQ, maxReceiveCount 5, IDs only | FIFO per business | Idempotent consumers; ordering in PostgreSQL | Small | At-least-once handled by `processed_messages` | No |
| Scheduler | Worker-owned, database-backed leases | EventBridge Scheduler; cron in API | No new service; runs once across workers | None | Depends on the worker running | No |
| Secrets | Secrets Manager for credentials only; ECS `secrets`; exact ARNs | Everything in Secrets Manager; env files | Least privilege, minimal secret count | Per-secret monthly charge | Each task sees only its secrets | No |
| KMS | AWS-managed by default; customer-managed keys for production RDS and media (maintainer direction) | CMKs everywhere; per-tenant keys | Key control where it matters; RDS key fixed at creation | Small per-key charge | Key policy control and auditability for restricted data | No |
| SNS | One alarm topic per environment, email subscribers (maintainer direction) | No alarm notifications (dashboards only) | Alarm delivery to maintainers | Negligible | Infrastructure alerts only | No |
| Log retention | 14 / 30 / 90 days | Longer production retention | Cost and minimization | Ingestion is the main cost | Audit lives in PostgreSQL | **Legal: yes** (log retention) |
| Tracing | Deferred; OpenTelemetry when needed | X-Ray now | No concrete need | None | Correlation IDs suffice initially | No |
| CI/CD | OIDC, per-environment roles, protected production, same digest promoted | Static keys; shared role | No long-lived credentials | None | Environment-scoped trust | No |
| Web hosting | Amplify preferred, **not confirmed**; implementation spike on Next.js 16.3.6 (maintainer direction) | S3 + CloudFront static export; ECS service | Official Amplify support listed only through Next.js 15 | Depends on outcome | Web stays a non-authoritative client | No (implementation spike) |
| DNS/TLS | Production zone in production account; delegated non-production subzones; ACM | Single account zone | Account isolation | Small | HTTPS only | **Product: yes** (domain ownership) |
| DR | Single-Region; RPO about 5 min, RTO up to 4 h (production); no multi-Region | Cross-Region DR now | Pilot scope | None now | Region loss not covered | **Legal: yes** before any cross-Region copy |
| Cost | Budgets, anomaly detection, tags, non-production scale-down | None | Pilot economics | Controls spend | No production security reduction | No |

## 35. Open questions

### A. Must be approved before ADR-003 can be accepted

- **None remaining.** The items previously in this category (Region, accounts, Cognito sign-in and tokens, WAF, SNS,
  production KMS) are covered by the maintainer direction in section 2, and the ADR was accepted on 2026-09-30
  (section 40). Final web hosting moved to category B. Categories B and C below remain open.

### B. Can be deferred to infrastructure implementation

- **Final web-host selection:** the Amplify Hosting spike on the exact pinned Next.js version and required features;
  the smallest suitable alternative if it fails (section 24).
- Latency measurement from Nigerian mobile networks to eu-west-1 and eu-west-2, before the production infrastructure
  commitment (section 4.2).
- Re-check of Region service and feature availability, including the Cognito feature plan for refresh-token rotation.
- RDS instance classes and pool size per environment.
- arm64 versus x86_64 images.
- Interface VPC endpoints.
- How `DATABASE_URL` is composed from secrets.
- A separate migrator image.
- Dashboard contents and alarm thresholds.
- GuardDuty (including Malware Protection for S3) and ALB access logs.
- ECR enhanced scanning.
- Cross-Region or cross-account backup copies (also category C).
- Staging moving to its own account (option C).
- Whether the first development environment waits for a domain.

### C. Require legal or compliance input (not resolved by engineering)

- The legal basis and safeguards for transferring Nigerian personal data to an AWS Region outside Nigeria under the
  Nigeria Data Protection Act 2023 and current NDPC guidance; this is a **production deployment condition**.
- Any registration or filing obligations with the Nigeria Data Protection Commission.
- Whether any localization or hosting expectation (for example from NITDA or, if embedded financial services are added
  later, the Central Bank of Nigeria) applies to Tali now or later.
- Retention periods for application logs, media (open decision 14), idempotency and platform audit records.
- Whether backup copies may be held in a second Region, and which one.
- Processor terms with AWS (data processing addendum) for the chosen Region.

### Product gaps (recorded, not decided here)

- **Staff without email** cannot sign in under the pilot design; this must be resolved before broad rollout
  (section 14.3).
- **Moving Cognito email to SES** before broad rollout (section 14.7).
- The domain name (section 25).

## 36. Explicitly deferred

- Multi-Region deployment and DR; a backup or log-archive account.
- Phone/SMS sign-in and Amazon SNS SMS; SES.
- Managed Login / hosted UI; federated (social) sign-in; passkeys.
- RDS Proxy; Aurora; read replicas.
- Interface VPC endpoints; Client VPN; SSM/EC2 access paths.
- EventBridge Scheduler.
- Tracing (OpenTelemetry).
- Malware scanning of uploads; S3 Object Lock.
- Automated rotation of app and migration database secrets.
- Blue/green deployments.
- Final web host.
- Not introduced at all without a new ADR: Kubernetes/EKS, Redis/ElastiCache, Kafka/MSK, service mesh, Lambda business
  services, API Gateway business logic, DynamoDB as an authoritative datastore, additional databases, LocalStack.

## 37. Alternatives considered

Summarized per topic in the tables in sections 4, 5, 10.3, 16.1, 19 and 34. The main rejected alternatives are a
single AWS account, af-south-1 as the primary Region, public or proxied database access, running migrations on API
start, FIFO queues, cron in API replicas, uploads proxied through the API, customer-managed keys everywhere or per
tenant, and multi-Region active-active.

## 38. Consequences

- Positive:
  - A concrete, reviewable topology that can be built in CDK in a defined order.
  - Production is isolated by account, network and identity; no public database; no long-lived CI credentials.
  - Slice 6 can proceed after acceptance without any AWS account.
- Negative / risks:
  - Baseline cost from Multi-AZ RDS, NAT Gateways, ALB, WAF and always-on tasks, even at pilot scale.
  - Cognito default email quota and email-only sign-in limit the pilot to users with email.
  - Web hosting is unresolved until the spike.
  - Region choice depends on legal review; a later change of Region means a migration.
- Impact on financial integrity, tenancy, audit, idempotency, AI safety and security:
  - Financial integrity and audit: unchanged; PostgreSQL remains the system of record; audit remains in the database.
  - Tenancy: Cognito carries no tenant data; `BusinessContext` is resolved from Tali's database; S3 keys and SQS
    messages carry `businessId` and are re-validated.
  - Idempotency: SQS at-least-once is absorbed by `processed_messages`; the outbox stays authoritative.
  - AI safety: unchanged.
  - Security: section 32.
- Migration / rollout / rollback: nothing is deployed by this ADR. Rollout follows section 31. If this ADR is rejected,
  the index and plan updates made with it are reverted.

## 39. Compliance with governance rules

- `AGENTS.md` and ADR-001: AWS provides infrastructure only; no business logic in Cognito, S3, SQS, ALB, WAF or the
  scheduler; clients call only Tali's API; provisioning waits for this ADR's acceptance.
- `00-architecture.mdc`: one modular monolith with API and worker processes; AWS SDK use stays in adapters; no new
  independent service or datastore.
- `20-financial-integrity.mdc`: no change; SQS and S3 never hold authoritative financial state.
- `30-multitenancy.mdc`: Cognito is not tenant authorization; queues, keys and paths carry `businessId` and are
  re-validated; no cross-tenant aggregation.
- `40-ai-safety.mdc`: no change.
- `70-security.mdc`: least privilege, private RDS, private buckets, TLS, encryption at rest, Secrets Manager, OIDC CI,
  no AWS credentials in clients, environment isolation, local identity impossible in deployed environments (existing
  configuration validation).
- ADR-002: local development stays AWS-free; migrations use a separate role; server/public configuration stays
  separated; no RLS change.
- ADR-004: the outbox stays the source of truth; consumers idempotent.
- ADR-005: Cognito authentication only; `sub` maps to `provider_subject`; explicit registration; device credentials
  independent of Cognito.
- This ADR changes no existing rule. It adds AWS WAF, an SNS alarm topic, AWS Organizations, IAM Identity Center and
  an organization CloudTrail trail, which ADR-001 did not list, as infrastructure components under this ADR.

## 40. Acceptance record

- **Accepted 2026-09-30 by the human maintainer**, as written (including the maintainer direction in section 2). The
  ADR was drafted with AI assistance; the AI agent did not accept it.
- Acceptance did not change any topology decision in sections 3 to 33.
- **Acceptance is not legal or compliance approval.** The category C items in section 35 remain unresolved, and they
  remain **production deployment conditions**:
  - the NDPA 2023 cross-border transfer basis and safeguards;
  - NDPC registration or filing obligations;
  - possible NITDA or CBN hosting or localization requirements;
  - retention periods for logs, media, audit records and idempotency records;
  - the location and legal treatment of any cross-Region backup copy;
  - AWS data-processing terms.
- **Product gaps stay open:** staff without email (section 14.3), the SES decision before broader rollout (section
  14.7), and production domain ownership (section 25).
- **Implementation-deferred items stay deferred** (section 35 B and section 36), including the final web-host
  selection. Amplify Hosting is **not** confirmed; compatibility with the pinned Next.js 16 version is still to be
  proven by the implementation spike (section 24).
- **What acceptance unblocks:** Build 1 Slice 6, the Cognito verification adapter. Its tests use local JWKS fixtures
  and need no real AWS resources (section 15). Infrastructure implementation under `infrastructure/cdk` may also begin
  in the order of section 31, as ADR-001's provisioning gate is now satisfied.
- **What acceptance does not mean:**
  - no AWS infrastructure has been provisioned;
  - no CDK code exists;
  - no production Region has completed legal approval;
  - no production (or any) Cognito user pool exists;
  - Amplify Hosting is not confirmed;
  - no deployment workflow exists.
- Adapter implementation (Slice 6) and AWS provisioning are separate work.
