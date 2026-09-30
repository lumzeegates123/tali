import type { BusinessContext, LocationBoundContext } from "../../context/business-context.js";
import type { UnitOfWork } from "../../ports/unit-of-work.js";
import type { LocationRepository } from "./ports.js";

/**
 * A business context whose business has no ACTIVE default location. Every
 * business is created with one (ADR-005 section 6) and the database enforces
 * at most one, so this is a broken invariant, not a client error: it is never
 * an ApplicationError and surfaces as an internal error.
 */
export class DefaultLocationMissingError extends Error {
  constructor() {
    super("business has no active default location");
    this.name = "DefaultLocationMissingError";
  }
}

/**
 * Binds a resolved business context to the business's ACTIVE default location
 * (data-principles section 5; MVP: exactly one per business). The location is
 * always read from Tali's database by the context business; a location ID that
 * arrived from a client is never accepted as a substitute, and any location
 * already on the context is replaced by the resolved one.
 */
export interface DefaultLocationResolver {
  resolveDefaultLocation(context: BusinessContext): Promise<LocationBoundContext>;
}

export function createDefaultLocationResolver(dependencies: {
  readonly unitOfWork: UnitOfWork;
  readonly locations: LocationRepository;
}): DefaultLocationResolver {
  return {
    async resolveDefaultLocation(context) {
      const location = await dependencies.unitOfWork.run((scope) =>
        dependencies.locations.findActiveDefault(scope, context.businessId),
      );
      if (location === undefined || location.businessId !== context.businessId) {
        throw new DefaultLocationMissingError();
      }
      return { ...context, locationId: location.id };
    },
  };
}
