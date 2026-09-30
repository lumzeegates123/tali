import {
  type BusinessContext,
  createBusinessContextResolver,
  createDefaultLocationResolver,
  createUserContextResolver,
  DefaultLocationMissingError,
} from "@tali/application";
import { describe, expect, it } from "vitest";
import { useTenancyHarness } from "../support/tenancy.js";

/**
 * resolveDefaultLocation over the PostgreSQL location adapter: the ACTIVE
 * default location of the context business only, never another business's
 * location or a location supplied on the context.
 */
describe("default-location resolver (PostgreSQL)", () => {
  const harness = useTenancyHarness();
  const { owner, repositories, unitOfWork } = harness;

  async function setup() {
    const tenancy = harness.compose();
    const a = await tenancy.registeredUser("subject-a", "Amina");
    const b = await tenancy.registeredUser("subject-b", "Bello");
    const businessA = (await tenancy.create(a, { name: "Shop A" })).result;
    const businessB = (await tenancy.create(b, { name: "Shop B" })).result;
    const userContexts = createUserContextResolver({ unitOfWork, users: repositories.users });
    const contexts = createBusinessContextResolver({
      unitOfWork,
      userContexts,
      businesses: repositories.businesses,
      memberships: repositories.memberships,
    });
    const context: BusinessContext = await contexts.resolveForUser(a.context, businessA.business.id);
    const resolver = createDefaultLocationResolver({ unitOfWork, locations: repositories.locations });
    return { businessA, businessB, context, resolver };
  }

  it("binds the context to its business's ACTIVE default location", async () => {
    const { businessA, context, resolver } = await setup();
    const bound = await resolver.resolveDefaultLocation(context);
    expect(bound.locationId).toBe(businessA.location.id);
    expect(bound.businessId).toBe(businessA.business.id);
  });

  it("replaces a location from another business that was placed on the context", async () => {
    const { businessA, businessB, context, resolver } = await setup();
    const bound = await resolver.resolveDefaultLocation({ ...context, locationId: businessB.location.id });
    expect(bound.locationId).toBe(businessA.location.id);
  });

  it("never falls back to another business's default when this business has none", async () => {
    const { businessA, context, resolver } = await setup();
    await owner.query(`UPDATE business_locations SET status = 'ARCHIVED', is_default = false WHERE business_id = $1`, [
      businessA.business.id,
    ]);
    await expect(resolver.resolveDefaultLocation(context)).rejects.toBeInstanceOf(DefaultLocationMissingError);
  });

  it("joins an enclosing unit of work", async () => {
    const { businessA, context, resolver } = await setup();
    const bound = await unitOfWork.run(() => resolver.resolveDefaultLocation(context));
    expect(bound.locationId).toBe(businessA.location.id);
  });
});
