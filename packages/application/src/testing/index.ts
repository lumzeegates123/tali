/**
 * @tali/application/testing: in-memory fakes of the application ports, for
 * tests and local composition only (ADR-002 section 11).
 */
export { FakeIdentityProvider } from "./fake-identity-provider.js";
export { FixedClock } from "./fixed-clock.js";
export { InMemoryObjectStorage } from "./in-memory-object-storage.js";
export { InMemoryQueue } from "./in-memory-queue.js";
export { InMemoryUnitOfWork } from "./in-memory-unit-of-work.js";
export { SequentialIdGenerator } from "./sequential-id-generator.js";
