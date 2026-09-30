import { defineCurrency, restoreLocation } from "@tali/domain";
import { describe, expect, it } from "vitest";
import { createTenancyHarness } from "../../testing/tenancy-harness.js";
import { DefaultLocationMissingError } from "./default-location-resolver.js";

async function setup() {
  const h = createTenancyHarness({ currencies: [defineCurrency("KES", 2)] });
  const owner = await h.registeredUser("owner", "Owner");
  const outsider = await h.registeredUser("outsider", "Outsider");
  const mine = await h.businessOwnedBy(owner, { name: "Mine" });
  const theirs = await h.businessOwnedBy(outsider, { name: "Theirs" });
  const context = await h.businessContexts.resolveForUser(owner.context, mine.business.id);
  return { h, mine, theirs, context };
}

describe("DefaultLocationResolver", () => {
  it("binds the context to the business's ACTIVE default location", async () => {
    const { h, mine, context } = await setup();
    const bound = await h.defaultLocations.resolveDefaultLocation(context);
    expect(bound.locationId).toBe(mine.location.id);
    expect(bound.businessId).toBe(context.businessId);
    expect(bound.actor).toEqual(context.actor);
    expect(bound.correlationId).toBe(context.correlationId);
    expect(context.locationId).toBeUndefined();
  });

  it("never lets a location already on the context substitute for the resolved one", async () => {
    const { h, mine, theirs, context } = await setup();
    const forged = { ...context, locationId: theirs.location.id };
    const bound = await h.defaultLocations.resolveDefaultLocation(forged);
    expect(bound.locationId).toBe(mine.location.id);
  });

  it("scopes the lookup by the context business", async () => {
    const { h, theirs, context } = await setup();
    const bound = await h.defaultLocations.resolveDefaultLocation(context);
    expect(bound.locationId).not.toBe(theirs.location.id);
  });

  it("does not return a non-default location", async () => {
    const { h, mine, context } = await setup();
    h.store.putLocation(
      restoreLocation({
        id: h.ids.newId("Location"),
        businessId: mine.business.id,
        name: "Back store",
        isDefault: false,
        status: "ACTIVE",
        createdAt: h.clock.now(),
        updatedAt: h.clock.now(),
      }),
    );
    expect((await h.defaultLocations.resolveDefaultLocation(context)).locationId).toBe(mine.location.id);
  });

  it("fails as a broken invariant when the default location is not ACTIVE", async () => {
    const { h, mine, context } = await setup();
    h.store.putLocation(restoreLocation({ ...mine.location, status: "ARCHIVED", isDefault: false }));
    const failure = await h.defaultLocations.resolveDefaultLocation(context).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DefaultLocationMissingError);
    expect(failure).not.toHaveProperty("code");
  });

  it("fails as a broken invariant when the business has no default location", async () => {
    const { h, theirs, context } = await setup();
    const unknown = { ...context, businessId: h.ids.newId("Business") };
    await expect(h.defaultLocations.resolveDefaultLocation(unknown)).rejects.toThrow(DefaultLocationMissingError);
    expect(theirs.location.isDefault).toBe(true);
  });
});
