/**
 * @tali/application/testing/contracts: port contract suites (Vitest). Every
 * adapter (in-memory, local, AWS) runs the suite for the port it implements.
 */
export { describeClockContract, describeIdGeneratorContract, describeUnitOfWorkContract } from "./core-ports.contract";
export type { IdentityProviderContractSetup } from "./identity-provider.contract";
export { describeIdentityProviderContract } from "./identity-provider.contract";
export type { ObjectStorageContractSetup } from "./object-storage-provider.contract";
export { describeObjectStorageProviderContract } from "./object-storage-provider.contract";
export type { QueueProviderContractSetup } from "./queue-provider.contract";
export { describeQueueProviderContract } from "./queue-provider.contract";
