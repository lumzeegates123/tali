import type { BusinessContext, LocationBoundContext } from "@tali/application";
import type { ApiServices } from "../composition/api-services.js";

/**
 * Binds a guard-resolved BusinessContext to the business's ACTIVE default
 * location (ADR-008 section 5; one location per business in the MVP). Every
 * inventory route goes through this: no request names a location, and a
 * business without a default location fails rather than falling back to any
 * client value.
 */
export function bindDefaultLocation(services: ApiServices, context: BusinessContext): Promise<LocationBoundContext> {
  return services.defaultLocations.resolveDefaultLocation(context);
}
