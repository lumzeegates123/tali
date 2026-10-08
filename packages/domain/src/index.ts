/**
 * @tali/domain: server-side entry point. Business modules (src/modules/**) are
 * added with their use cases; clients import only @tali/domain/kernel.
 */
export * from "./kernel/index.js";
export type { DomainErrorCode } from "./errors.js";
export { DomainError } from "./errors.js";
export * from "./modules/business/index.js";
export * from "./modules/catalog/index.js";
export * from "./modules/device/index.js";
export * from "./modules/identity/index.js";
export * from "./modules/inventory/index.js";
export * from "./modules/location/index.js";
