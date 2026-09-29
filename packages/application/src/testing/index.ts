/**
 * @tali/application/testing: in-memory fakes of the application ports, for
 * tests and local composition only (ADR-002 section 11).
 */
export { FailureInjection } from "./failure-injection.js";
export { FakeFingerprintHasher } from "./fake-fingerprint-hasher.js";
export { FakeIdentityProvider } from "./fake-identity-provider.js";
export { FixedClock } from "./fixed-clock.js";
export { InMemoryAuditWriter } from "./in-memory-audit-writer.js";
export { InMemoryObjectStorage } from "./in-memory-object-storage.js";
export { InMemoryQueue } from "./in-memory-queue.js";
export { InMemoryTenancyStore } from "./in-memory-tenancy-store.js";
export type { RollbackParticipant } from "./in-memory-unit-of-work.js";
export { InMemoryUnitOfWork } from "./in-memory-unit-of-work.js";
export { InMemoryUserIdempotencyStore } from "./in-memory-user-idempotency-store.js";
export { SequentialIdGenerator } from "./sequential-id-generator.js";
export type { RegisteredTestUser, TenancyHarness } from "./tenancy-harness.js";
export { createTenancyHarness } from "./tenancy-harness.js";
