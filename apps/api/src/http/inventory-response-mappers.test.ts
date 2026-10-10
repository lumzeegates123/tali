import type {
  PostStocktakeResult,
  StocktakeChangeResult,
  StocktakeLineView,
  StocktakeView,
  ThresholdChangeResult,
} from "@tali/application";
import {
  BusinessDate,
  parseLocationId,
  parseProductVariantId,
  parseStocktakeId,
  parseUnitCode,
  Quantity,
} from "@tali/domain";
import {
  LowStockThresholdResponseSchema,
  PostStocktakeResponseSchema,
  StocktakeLineBlindSchema,
  StocktakeLinesResponseSchema,
} from "@tali/shared";
import { describe, expect, it } from "vitest";
import {
  toCancelStocktakeResponse,
  toLowStockThresholdResponse,
  toPostStocktakeResponse,
  toStocktakeLineChangeResponse,
  toStocktakeLinesResponse,
  toStocktakeResponse,
} from "./inventory-response-mappers.js";

const PIECE = parseUnitCode("PIECE");
const pieces = (minor: bigint) => Quantity.ofMinor(minor, PIECE);
const VARIANT = parseProductVariantId("019a0000-0000-7000-8000-000000000001");
const LOCATION = parseLocationId("019a0000-0000-7000-8000-00000000000c");
const STOCKTAKE = parseStocktakeId("019a0000-0000-7000-8000-00000000000d");
const AT = new Date("2026-10-09T10:00:00.000Z");

function view(visibility: "FULL" | "BLIND", status: StocktakeView["status"] = "DRAFT"): StocktakeView {
  return {
    visibility,
    stocktakeId: STOCKTAKE,
    locationId: LOCATION,
    status,
    version: 2,
    createdAt: AT,
    countedLineCount: 1,
    ...(status === "POSTED"
      ? {
          postedAt: AT,
          businessDate: BusinessDate.of(2026, 10, 9),
          posting: { correctionMovementCount: 1, zeroVarianceCount: 0 },
        }
      : {}),
  };
}

const LINE_BASE = {
  variantId: VARIANT,
  status: "COUNTED",
  countedQuantity: pieces(7n),
  stockUnit: PIECE,
  version: 1,
  countedAt: AT,
} as const;

/** A BLIND line view that wrongly still carries the FULL-only fields. */
const MALFORMED_BLIND = {
  ...LINE_BASE,
  visibility: "BLIND",
  expectedAtCount: pieces(10n),
  variance: pieces(-3n),
} as unknown as StocktakeLineView;

describe("stocktake line serialization", () => {
  it("builds a BLIND line from scratch, so FULL-only source fields never reach the wire", () => {
    const [line] = toStocktakeLinesResponse({ items: [MALFORMED_BLIND], nextCursor: null }).items;
    expect(line).toEqual({
      visibility: "BLIND",
      variantId: VARIANT,
      status: "COUNTED",
      countedQuantity: { quantityMinor: "7", unit: "PIECE" },
      stockUnit: "PIECE",
      version: 1,
      countedAt: AT.toISOString(),
    });
    expect(Object.keys(line ?? {})).not.toContain("expectedAtCount");
    expect(Object.keys(line ?? {})).not.toContain("variance");
  });

  it("has a strict BLIND schema that rejects expected and variance keys, even as null", () => {
    const blind = toStocktakeLinesResponse({ items: [MALFORMED_BLIND], nextCursor: null }).items[0];
    expect(StocktakeLineBlindSchema.safeParse(blind).success).toBe(true);
    for (const extra of [
      { expectedAtCount: { quantityMinor: "10", unit: "PIECE" } },
      { variance: { quantityMinor: "-3", unit: "PIECE" } },
      { expectedAtCount: null },
      { variance: null },
    ]) {
      expect(StocktakeLineBlindSchema.safeParse({ ...blind, ...extra }).success).toBe(false);
    }
  });

  it("writes FULL lines with the expected quantity and a null variance before posting", () => {
    const full: StocktakeLineView = { ...LINE_BASE, visibility: "FULL", expectedAtCount: pieces(10n) };
    const response = toStocktakeLineChangeResponse({ stocktake: view("FULL"), line: full, changed: true });
    expect(response.line).toMatchObject({
      visibility: "FULL",
      expectedAtCount: { quantityMinor: "10" },
      variance: null,
    });
  });

  it("rejects a page or a change that mixes visibilities", () => {
    const full: StocktakeLineView = { ...LINE_BASE, visibility: "FULL", expectedAtCount: pieces(10n) };
    expect(() => toStocktakeLinesResponse({ items: [full, MALFORMED_BLIND], nextCursor: null })).toThrow();
    expect(() =>
      toStocktakeLineChangeResponse({ stocktake: view("FULL"), line: MALFORMED_BLIND, changed: true }),
    ).toThrow();
    expect(StocktakeLinesResponseSchema.safeParse({ items: [], nextCursor: null }).success).toBe(true);
  });
});

describe("stocktake header serialization", () => {
  it("writes absent optional fields as null and summary counts in both visibilities", () => {
    for (const visibility of ["FULL", "BLIND"] as const) {
      expect(toStocktakeResponse(view(visibility))).toEqual({
        visibility,
        stocktakeId: STOCKTAKE,
        locationId: LOCATION,
        status: "DRAFT",
        version: 2,
        note: null,
        createdAt: AT.toISOString(),
        postedAt: null,
        businessDate: null,
        cancelledAt: null,
        countedLineCount: 1,
        posting: null,
      });
    }
  });

  it("fails closed when a post or cancel result is BLIND", () => {
    const post = { stocktake: view("BLIND", "POSTED"), movements: [], changed: true } as unknown as PostStocktakeResult;
    const cancel: StocktakeChangeResult = { stocktake: view("BLIND", "CANCELLED"), changed: true };
    expect(() => toPostStocktakeResponse(post)).toThrow();
    expect(() => toCancelStocktakeResponse(cancel)).toThrow();
  });
});

describe("movement serialization", () => {
  it("names only public fields and never the business, actor, device or correlation", () => {
    const movement = {
      id: "019a0000-0000-7000-8000-0000000000e1",
      businessId: "019a0000-0000-7000-8000-0000000000b1",
      locationId: LOCATION,
      variantId: VARIANT,
      type: "COUNT_CORRECTION",
      delta: pieces(-3n),
      balanceAfter: pieces(7n),
      balanceVersion: 4,
      source: { kind: "STOCKTAKE", id: STOCKTAKE },
      actorMembershipId: "019a0000-0000-7000-8000-0000000000a1",
      deviceId: "019a0000-0000-7000-8000-0000000000d1",
      correlationId: "corr-1",
      sourceChannel: "API",
      occurredAt: AT,
      recordedAt: AT,
      businessDate: BusinessDate.of(2026, 10, 9),
    };
    const result = {
      stocktake: view("FULL", "POSTED"),
      movements: [movement],
      changed: true,
    } as unknown as PostStocktakeResult;
    const response = toPostStocktakeResponse(result);
    expect(PostStocktakeResponseSchema.parse(JSON.parse(JSON.stringify(response)))).toEqual(response);
    expect(response.movements[0]).toEqual({
      movementId: movement.id,
      variantId: VARIANT,
      type: "COUNT_CORRECTION",
      delta: { quantityMinor: "-3", unit: "PIECE" },
      balanceAfter: { quantityMinor: "7", unit: "PIECE" },
      balanceVersion: 4,
      source: { kind: "STOCKTAKE", id: STOCKTAKE },
      pack: null,
      reversesMovementId: null,
      reasonCode: null,
      reasonNote: null,
      sourceChannel: "API",
      occurredAt: AT.toISOString(),
      businessDate: "2026-10-09",
    });
  });
});

describe("threshold serialization", () => {
  it("writes a cleared threshold as null", () => {
    const result: ThresholdChangeResult = { variantId: VARIANT, locationId: LOCATION, version: 2, changed: true };
    expect(LowStockThresholdResponseSchema.parse(toLowStockThresholdResponse(result))).toEqual({
      variantId: VARIANT,
      locationId: LOCATION,
      threshold: null,
      version: 2,
      changed: true,
    });
  });
});
