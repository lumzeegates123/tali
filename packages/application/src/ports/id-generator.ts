import type { Id } from "@tali/domain";

/**
 * Generates record identities (UUIDv7). Implementations must use a
 * cryptographically secure random source and fail loudly when none is
 * available; they never fall back to Math.random (ADR-002 section 14).
 */
export interface IdGenerator {
  newId<Entity extends string>(entity: Entity): Id<Entity>;
}
