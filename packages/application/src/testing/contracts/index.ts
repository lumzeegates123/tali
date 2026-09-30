/**
 * @tali/application/testing/contracts: port contract suites (Vitest). Every
 * adapter (in-memory, local, AWS) runs the suite for the port it implements.
 */
export {
  describeClockContract,
  describeIdGeneratorContract,
  describeUnitOfWorkContract,
} from "./core-ports.contract.js";
export type { FingerprintHasherContractSetup } from "./fingerprint-hasher.contract.js";
export { describeFingerprintHasherContract } from "./fingerprint-hasher.contract.js";
export type { FingerprintVector } from "./fingerprint-vectors.js";
export { FINGERPRINT_V1_VECTORS } from "./fingerprint-vectors.js";
export type { IdentityProviderContractSetup } from "./identity-provider.contract.js";
export { describeIdentityProviderContract } from "./identity-provider.contract.js";
export type { ObjectStorageContractSetup } from "./object-storage-provider.contract.js";
export { describeObjectStorageProviderContract } from "./object-storage-provider.contract.js";
export type { QueueProviderContractSetup } from "./queue-provider.contract.js";
export { describeQueueProviderContract } from "./queue-provider.contract.js";
