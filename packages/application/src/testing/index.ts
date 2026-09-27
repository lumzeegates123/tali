/**
 * @tali/application/testing: in-memory fakes of the application ports, for
 * tests and local composition only (ADR-002 section 11).
 */
export { FakeIdentityProvider } from "./fake-identity-provider";
export { FixedClock } from "./fixed-clock";
export { InMemoryObjectStorage } from "./in-memory-object-storage";
export { InMemoryQueue } from "./in-memory-queue";
export { InMemoryUnitOfWork } from "./in-memory-unit-of-work";
export { SequentialIdGenerator } from "./sequential-id-generator";
