import { describe, expect, it } from "vitest";
import type { DomainErrorCode } from "../../errors.js";
import { DomainError } from "../../errors.js";
import type { KernelErrorCode } from "../../kernel/index.js";
import { BusinessDate, KernelError, parseUnitCode, Quantity } from "../../kernel/index.js";
import { parseBusinessId, parseMembershipId } from "../business/index.js";
import { parseProductVariantId } from "../catalog/index.js";
import { parseLocationId } from "../location/index.js";
import type { Stocktake, StocktakeLine } from "./index.js";
import {
  decideCancelStocktake,
  decidePostStocktake,
  decideRecordStocktakeCount,
  decideRemoveStocktakeLine,
  MAX_STOCKTAKE_LINES,
  parseStocktakeId,
  parseStocktakeLineStatus,
  parseStocktakeStatus,
  restoreStocktake,
  restoreStocktakeLine,
  startStocktake,
  STOCKTAKE_LINE_STATUSES,
  STOCKTAKE_STATUSES,
} from "./index.js";

const uuid = (n: number): string => `01928c6e-8b3a-7c4d-9e5f-${n.toString(16).padStart(12, "0")}`;
const businessId = parseBusinessId(uuid(1));
const locationId = parseLocationId(uuid(2));
const variantA = parseProductVariantId(uuid(0x0a));
const variantB = parseProductVariantId(uuid(0x0b));
const actorId = parseMembershipId(uuid(4));
const posterId = parseMembershipId(uuid(5));
const stocktakeId = parseStocktakeId(uuid(30));
const PIECE = parseUnitCode("PIECE");
const KG = parseUnitCode("KG");
const createdAt = new Date("2026-10-08T10:00:00.000Z");
const later = new Date("2026-10-08T12:00:00.000Z");
const businessDate = BusinessDate.of(2026, 10, 8);
const pieces = (minor: bigint): Quantity => Quantity.ofMinor(minor, PIECE);

function expectDomainError(action: () => unknown, code: DomainErrorCode, field?: string): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DomainError);
  expect((caught as DomainError).code).toBe(code);
  if (field !== undefined) expect((caught as DomainError).field).toBe(field);
}

function expectKernelError(action: () => unknown, code: KernelErrorCode): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(KernelError);
  expect((caught as KernelError).code).toBe(code);
}

function draft(overrides: Partial<Parameters<typeof startStocktake>[0]> = {}): Stocktake {
  return startStocktake({
    id: stocktakeId,
    businessId,
    locationId,
    createdByMembershipId: actorId,
    createdAt,
    ...overrides,
  });
}

function count(
  stocktake: Stocktake,
  input: {
    readonly current?: StocktakeLine;
    readonly currentDistinctLineCount?: number;
    readonly variantId?: typeof variantA;
    readonly counted?: Quantity;
    readonly stockUnit?: typeof PIECE;
    readonly expectedOnHand?: Quantity;
    readonly balanceVersion?: number;
    readonly expectedVersion?: number | undefined;
    readonly now?: Date;
    readonly actorMembershipId?: typeof actorId;
  } = {},
) {
  return decideRecordStocktakeCount({
    stocktake,
    current: input.current,
    currentDistinctLineCount: input.currentDistinctLineCount ?? (input.current === undefined ? 0 : 1),
    variantId: input.variantId ?? variantA,
    counted: input.counted ?? pieces(7n),
    stockUnit: input.stockUnit ?? PIECE,
    expectedOnHand: input.expectedOnHand ?? pieces(10n),
    balanceVersion: input.balanceVersion ?? 3,
    actorMembershipId: input.actorMembershipId ?? actorId,
    now: input.now ?? later,
    ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }),
  });
}

function posted(stocktake: Stocktake = draft(), countedLineCount = 1, expectedVersion = stocktake.version): Stocktake {
  return decidePostStocktake({
    stocktake,
    countedLineCount,
    postedByMembershipId: posterId,
    postedAt: later,
    businessDate,
    expectedVersion,
  }).stocktake;
}

describe("stocktake status", () => {
  it("accepts exactly DRAFT, POSTED and CANCELLED", () => {
    expect(STOCKTAKE_STATUSES).toEqual(["DRAFT", "POSTED", "CANCELLED"]);
    expect(STOCKTAKE_LINE_STATUSES).toEqual(["COUNTED", "REMOVED"]);
    expect(parseStocktakeStatus("DRAFT")).toBe("DRAFT");
    expect(parseStocktakeLineStatus("REMOVED")).toBe("REMOVED");
    expectDomainError(() => parseStocktakeStatus("CLOSED"), "INVALID_VALUE", "status");
    expectDomainError(() => parseStocktakeLineStatus("SKIPPED"), "INVALID_VALUE", "status");
  });
});

describe("startStocktake", () => {
  it("creates a DRAFT at version 1 with no lines and copies createdAt", () => {
    const stocktake = draft({ note: "  Opening count  " });
    expect(stocktake).toMatchObject({
      id: stocktakeId,
      businessId,
      locationId,
      status: "DRAFT",
      version: 1,
      note: "Opening count",
      createdByMembershipId: actorId,
    });
    expect(stocktake.createdAt).toEqual(createdAt);
    expect(stocktake.createdAt).not.toBe(createdAt);
    expect(stocktake.postedAt).toBeUndefined();
    expect(stocktake.cancelledAt).toBeUndefined();
    expect(stocktake.businessDate).toBeUndefined();
    expect(Object.isFrozen(stocktake)).toBe(true);
  });

  it("rejects an invalid createdAt and an invalid note", () => {
    expectDomainError(() => draft({ createdAt: new Date(Number.NaN) }), "INVALID_VALUE", "createdAt");
    expectDomainError(() => draft({ note: "   " }), "INVALID_VALUE", "note");
  });
});

describe("restoreStocktake", () => {
  it("accepts each valid lifecycle shape", () => {
    expect(restoreStocktake(draft()).status).toBe("DRAFT");
    const postedShape = restoreStocktake({
      ...draft(),
      status: "POSTED",
      version: 2,
      postedByMembershipId: posterId,
      postedAt: later,
      businessDate,
    });
    expect(postedShape).toMatchObject({ status: "POSTED", postedByMembershipId: posterId });
    expect(postedShape.postedAt).not.toBe(later);
    const cancelledShape = restoreStocktake({
      ...draft(),
      status: "CANCELLED",
      version: 2,
      cancelledByMembershipId: posterId,
      cancelledAt: later,
    });
    expect(cancelledShape.status).toBe("CANCELLED");
    expect(cancelledShape.cancelledAt).not.toBe(later);
  });

  it("rejects posting or cancellation fields on DRAFT", () => {
    expectDomainError(
      () => restoreStocktake({ ...draft(), postedByMembershipId: posterId }),
      "INVALID_VALUE",
      "status",
    );
    expectDomainError(() => restoreStocktake({ ...draft(), postedAt: later }), "INVALID_VALUE", "status");
    expectDomainError(() => restoreStocktake({ ...draft(), businessDate }), "INVALID_VALUE", "status");
    expectDomainError(
      () => restoreStocktake({ ...draft(), cancelledByMembershipId: posterId }),
      "INVALID_VALUE",
      "status",
    );
    expectDomainError(() => restoreStocktake({ ...draft(), cancelledAt: later }), "INVALID_VALUE", "status");
  });

  it("rejects incomplete POSTED and CANCELLED shapes and mixed terminal fields", () => {
    expectDomainError(
      () => restoreStocktake({ ...draft(), status: "POSTED", postedByMembershipId: posterId, postedAt: later }),
      "INVALID_VALUE",
      "status",
    );
    expectDomainError(
      () => restoreStocktake({ ...draft(), status: "CANCELLED", cancelledByMembershipId: posterId }),
      "INVALID_VALUE",
      "status",
    );
    expectDomainError(
      () =>
        restoreStocktake({
          ...draft(),
          status: "POSTED",
          postedByMembershipId: posterId,
          postedAt: later,
          businessDate,
          cancelledByMembershipId: posterId,
          cancelledAt: later,
        }),
      "INVALID_VALUE",
      "status",
    );
  });

  it("rejects posted or cancelled before created, a missing BusinessDate, version 0 and unknown status", () => {
    expectDomainError(
      () =>
        restoreStocktake({
          ...draft(),
          status: "POSTED",
          postedByMembershipId: posterId,
          postedAt: new Date(createdAt.getTime() - 1),
          businessDate,
        }),
      "INVALID_VALUE",
      "postedAt",
    );
    expectDomainError(
      () =>
        restoreStocktake({
          ...draft(),
          status: "CANCELLED",
          cancelledByMembershipId: posterId,
          cancelledAt: new Date(createdAt.getTime() - 1),
        }),
      "INVALID_VALUE",
      "cancelledAt",
    );
    expectDomainError(
      () =>
        restoreStocktake({
          ...draft(),
          status: "POSTED",
          postedByMembershipId: posterId,
          postedAt: later,
          businessDate: "2026-10-08" as unknown as BusinessDate,
        }),
      "INVALID_VALUE",
      "businessDate",
    );
    expectDomainError(() => restoreStocktake({ ...draft(), version: 0 }), "INVALID_VALUE", "version");
    expectDomainError(() => restoreStocktake({ ...draft(), status: "CLOSED" }), "INVALID_VALUE", "status");
  });
});

describe("restoreStocktakeLine", () => {
  const base = {
    businessId,
    stocktakeId,
    variantId: variantA,
    status: "COUNTED",
    countedQuantity: pieces(7n),
    stockUnitAtCount: PIECE,
    expectedAtCount: pieces(10n),
    balanceVersionAtCount: 3,
    version: 1,
    countedByMembershipId: actorId,
    countedAt: later,
  };

  it("accepts a COUNTED line, including counted 0, negative expected, and any-sign variance", () => {
    const line = restoreStocktakeLine({ ...base, countedQuantity: pieces(0n), expectedAtCount: pieces(-2n) });
    expect(line.countedQuantity.isZero()).toBe(true);
    expect(line.expectedAtCount.amountMinor).toBe(-2n);
    expect(restoreStocktakeLine({ ...base, variance: pieces(0n) }).variance?.isZero()).toBe(true);
    expect(restoreStocktakeLine({ ...base, variance: pieces(-3n) }).variance?.amountMinor).toBe(-3n);
    expect(Object.isFrozen(line)).toBe(true);
  });

  it("rejects a negative counted quantity, unit mismatches, a variance on REMOVED, and bad versions", () => {
    expectDomainError(
      () => restoreStocktakeLine({ ...base, countedQuantity: pieces(-1n) }),
      "INVALID_VALUE",
      "countedQuantity",
    );
    expectKernelError(
      () => restoreStocktakeLine({ ...base, countedQuantity: Quantity.ofMinor(7n, KG) }),
      "UNIT_MISMATCH",
    );
    expectKernelError(
      () => restoreStocktakeLine({ ...base, expectedAtCount: Quantity.ofMinor(7n, KG) }),
      "UNIT_MISMATCH",
    );
    expectDomainError(
      () => restoreStocktakeLine({ ...base, status: "REMOVED", variance: pieces(1n) }),
      "INVALID_VALUE",
      "variance",
    );
    expectDomainError(() => restoreStocktakeLine({ ...base, version: 0 }), "INVALID_VALUE", "version");
    expectDomainError(
      () => restoreStocktakeLine({ ...base, balanceVersionAtCount: -1 }),
      "INVALID_VALUE",
      "balanceVersionAtCount",
    );
    expectDomainError(
      () => restoreStocktakeLine({ ...base, countedAt: new Date(Number.NaN) }),
      "INVALID_VALUE",
      "countedAt",
    );
    expectDomainError(() => restoreStocktakeLine({ ...base, status: "SKIPPED" }), "INVALID_VALUE", "status");
  });
});

describe("decideRecordStocktakeCount", () => {
  it("creates a new COUNTED line at version 1 and increments the stocktake", () => {
    const result = count(draft(), { counted: pieces(0n), expectedVersion: 0 });
    expect(result.changed).toBe(true);
    expect(result.stocktake.version).toBe(2);
    expect(result.line).toMatchObject({
      status: "COUNTED",
      version: 1,
      stocktakeId,
      variantId: variantA,
      balanceVersionAtCount: 3,
      countedByMembershipId: actorId,
    });
    expect(result.line.countedQuantity.isZero()).toBe(true);
    expect(result.line.variance).toBeUndefined();
  });

  it("accepts the 1000th distinct line and rejects the 1001st", () => {
    expect(MAX_STOCKTAKE_LINES).toBe(1000);
    expect(count(draft(), { currentDistinctLineCount: 999 }).changed).toBe(true);
    expectDomainError(() => count(draft(), { currentDistinctLineCount: 1000 }), "INVALID_VALUE", "lines");
  });

  describe("expectedVersion against the stored line version (0 for no line)", () => {
    const removedLine = () => {
      const created = count(draft());
      return decideRemoveStocktakeLine({ stocktake: created.stocktake, line: created.line, expectedVersion: 1 });
    };

    it("A and B: no stored line with expectedVersion omitted or 0 creates version 1", () => {
      expect(count(draft()).line.version).toBe(1);
      expect(count(draft(), { expectedVersion: 0 }).line.version).toBe(1);
    });

    it("C: no stored line with a positive expectedVersion is VERSION_CONFLICT", () => {
      for (const expectedVersion of [1, 2]) {
        expectDomainError(() => count(draft(), { expectedVersion }), "VERSION_CONFLICT", "expectedVersion");
      }
    });

    it("D, E and F: an existing COUNTED line with expectedVersion omitted, 0 or stale is VERSION_CONFLICT", () => {
      const created = count(draft());
      for (const expectedVersion of [undefined, 0, 2]) {
        expectDomainError(
          () => count(created.stocktake, { current: created.line, expectedVersion }),
          "VERSION_CONFLICT",
          "expectedVersion",
        );
      }
    });

    it("G: an existing COUNTED line with its exact version proceeds to the no-op or change decision", () => {
      const created = count(draft());
      expect(count(created.stocktake, { current: created.line, expectedVersion: 1 }).changed).toBe(false);
      expect(
        count(created.stocktake, { current: created.line, expectedVersion: 1, counted: pieces(8n) }).line.version,
      ).toBe(2);
    });

    it("H: an existing REMOVED line with expectedVersion omitted or 0 is VERSION_CONFLICT", () => {
      const removed = removedLine();
      for (const expectedVersion of [undefined, 0]) {
        expectDomainError(
          () => count(removed.stocktake, { current: removed.line, expectedVersion }),
          "VERSION_CONFLICT",
          "expectedVersion",
        );
      }
    });

    it("I: an existing REMOVED line with its exact version is recounted", () => {
      const removed = removedLine();
      const recounted = count(removed.stocktake, { current: removed.line, expectedVersion: 2 });
      expect(recounted.line).toMatchObject({ status: "COUNTED", version: 3 });
    });

    it("a malformed expectedVersion stays INVALID_VALUE, with or without a stored line", () => {
      const created = count(draft());
      for (const expectedVersion of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, "1" as unknown as number]) {
        expectDomainError(() => count(draft(), { expectedVersion }), "INVALID_VALUE", "expectedVersion");
        expectDomainError(
          () => count(created.stocktake, { current: created.line, expectedVersion }),
          "INVALID_VALUE",
          "expectedVersion",
        );
      }
    });

    it("recounting an existing line at the line limit does not consume another slot", () => {
      const created = count(draft());
      expect(
        count(created.stocktake, {
          current: created.line,
          expectedVersion: 1,
          counted: pieces(9n),
          currentDistinctLineCount: MAX_STOCKTAKE_LINES,
        }).line.version,
      ).toBe(2);
    });
  });

  it("is a no-op only when status, counted quantity and captured state are unchanged", () => {
    const created = count(draft());
    const same = count(created.stocktake, {
      current: created.line,
      expectedVersion: 1,
      counted: pieces(7n),
      expectedOnHand: pieces(10n),
      balanceVersion: 3,
      now: new Date("2026-10-09T00:00:00.000Z"),
      actorMembershipId: posterId,
    });
    expect(same).toEqual({ stocktake: created.stocktake, line: created.line, changed: false });
  });

  it("reconfirms when the captured balance version, expected quantity or stock unit changed", () => {
    const created = count(draft());
    const byVersion = count(created.stocktake, {
      current: created.line,
      expectedVersion: 1,
      balanceVersion: 4,
    });
    expect(byVersion.changed).toBe(true);
    expect(byVersion.line.version).toBe(2);
    expect(byVersion.stocktake.version).toBe(3);
    expect(byVersion.line.balanceVersionAtCount).toBe(4);
    const byExpected = count(created.stocktake, {
      current: created.line,
      expectedVersion: 1,
      expectedOnHand: pieces(9n),
    });
    expect(byExpected.line.expectedAtCount.amountMinor).toBe(9n);
    const byUnit = count(created.stocktake, {
      current: created.line,
      expectedVersion: 1,
      counted: Quantity.ofMinor(7n, KG),
      stockUnit: KG,
      expectedOnHand: Quantity.ofMinor(10n, KG),
    });
    expect(byUnit.changed).toBe(true);
    expect(byUnit.line.stockUnitAtCount).toBe(KG);
    expect(byUnit.line.countedQuantity.unit).toBe(KG);
  });

  it("recaptures a changed quantity, actor and time", () => {
    const created = count(draft());
    const next = count(created.stocktake, {
      current: created.line,
      expectedVersion: 1,
      counted: pieces(8n),
      actorMembershipId: posterId,
      now: new Date("2026-10-08T15:00:00.000Z"),
    });
    expect(next.line.countedQuantity.amountMinor).toBe(8n);
    expect(next.line.countedByMembershipId).toBe(posterId);
    expect(next.line.countedAt).toEqual(new Date("2026-10-08T15:00:00.000Z"));
    expect(next.line.version).toBe(2);
    expect(next.stocktake.version).toBe(3);
  });

  it("recounts a REMOVED line onto the same row", () => {
    const created = count(draft());
    const removed = decideRemoveStocktakeLine({
      stocktake: created.stocktake,
      line: created.line,
      expectedVersion: 1,
    });
    const recounted = count(removed.stocktake, {
      current: removed.line,
      expectedVersion: 2,
      counted: pieces(4n),
      variantId: variantA,
    });
    expect(recounted.line.status).toBe("COUNTED");
    expect(recounted.line.variantId).toBe(variantA);
    expect(recounted.line.version).toBe(3);
    expect(recounted.stocktake.version).toBe(4);
    expect(recounted.line.countedQuantity.amountMinor).toBe(4n);
  });

  it("rejects a count on a POSTED or CANCELLED stocktake", () => {
    expectDomainError(() => count(posted()), "INVALID_TRANSITION", "status");
    const cancelled = decideCancelStocktake({
      stocktake: draft(),
      cancelledByMembershipId: posterId,
      cancelledAt: later,
      expectedVersion: 1,
    }).stocktake;
    expectDomainError(() => count(cancelled), "INVALID_TRANSITION", "status");
  });
});

describe("decideRemoveStocktakeLine", () => {
  it("marks COUNTED as REMOVED and increments both versions while keeping history", () => {
    const created = count(draft());
    const removed = decideRemoveStocktakeLine({
      stocktake: created.stocktake,
      line: created.line,
      expectedVersion: 1,
    });
    expect(removed.changed).toBe(true);
    expect(removed.line.status).toBe("REMOVED");
    expect(removed.line.version).toBe(2);
    expect(removed.stocktake.version).toBe(3);
    expect(removed.line.countedQuantity.equals(created.line.countedQuantity)).toBe(true);
    expect(removed.line.expectedAtCount.equals(created.line.expectedAtCount)).toBe(true);
    expect(removed.line.balanceVersionAtCount).toBe(3);
    expect(removed.line.variance).toBeUndefined();
  });

  it("conflicts on a stale COUNTED version", () => {
    const created = count(draft());
    expectDomainError(
      () => decideRemoveStocktakeLine({ stocktake: created.stocktake, line: created.line, expectedVersion: 9 }),
      "VERSION_CONFLICT",
      "expectedVersion",
    );
    expectDomainError(
      () => decideRemoveStocktakeLine({ stocktake: created.stocktake, line: created.line }),
      "INVALID_VALUE",
      "expectedVersion",
    );
  });

  it("treats an already REMOVED line as a no-op before version checking", () => {
    const created = count(draft());
    const removed = decideRemoveStocktakeLine({
      stocktake: created.stocktake,
      line: created.line,
      expectedVersion: 1,
    });
    const again = decideRemoveStocktakeLine({
      stocktake: removed.stocktake,
      line: removed.line,
      expectedVersion: 99,
    });
    expect(again).toEqual({ stocktake: removed.stocktake, line: removed.line, changed: false });
    expect(decideRemoveStocktakeLine({ stocktake: removed.stocktake, line: removed.line })).toEqual({
      stocktake: removed.stocktake,
      line: removed.line,
      changed: false,
    });
  });
});

describe("decidePostStocktake", () => {
  it("posts a DRAFT, increments only the stocktake version, and requires at least one counted line", () => {
    const stocktake = count(draft()).stocktake;
    const result = decidePostStocktake({
      stocktake,
      countedLineCount: 1,
      postedByMembershipId: posterId,
      postedAt: later,
      businessDate,
      expectedVersion: 2,
    });
    expect(result.changed).toBe(true);
    expect(result.stocktake).toMatchObject({
      status: "POSTED",
      version: 3,
      postedByMembershipId: posterId,
    });
    expect(result.stocktake.businessDate?.equals(businessDate)).toBe(true);
    expectDomainError(
      () =>
        decidePostStocktake({
          stocktake: draft(),
          countedLineCount: 0,
          postedByMembershipId: posterId,
          postedAt: later,
          businessDate,
          expectedVersion: 1,
        }),
      "INVALID_TRANSITION",
      "countedLineCount",
    );
  });

  it("rejects a stale expectedVersion on DRAFT", () => {
    expectDomainError(
      () =>
        decidePostStocktake({
          stocktake: draft(),
          countedLineCount: 1,
          postedByMembershipId: posterId,
          postedAt: later,
          businessDate,
          expectedVersion: 9,
        }),
      "VERSION_CONFLICT",
      "expectedVersion",
    );
  });

  it("treats POSTED as a no-op even with a stale expectedVersion", () => {
    const already = posted();
    const retry = decidePostStocktake({
      stocktake: already,
      countedLineCount: 0,
      postedByMembershipId: actorId,
      postedAt: createdAt,
      businessDate,
      expectedVersion: 1,
    });
    expect(retry).toEqual({ stocktake: already, changed: false });
  });

  it("rejects posting a CANCELLED stocktake", () => {
    const cancelled = decideCancelStocktake({
      stocktake: draft(),
      cancelledByMembershipId: posterId,
      cancelledAt: later,
      expectedVersion: 1,
    }).stocktake;
    expectDomainError(
      () =>
        decidePostStocktake({
          stocktake: cancelled,
          countedLineCount: 1,
          postedByMembershipId: posterId,
          postedAt: later,
          businessDate,
          expectedVersion: 2,
        }),
      "INVALID_TRANSITION",
      "status",
    );
  });
});

describe("decideCancelStocktake", () => {
  it("cancels a DRAFT and increments the stocktake version only", () => {
    const created = count(draft());
    const result = decideCancelStocktake({
      stocktake: created.stocktake,
      cancelledByMembershipId: posterId,
      cancelledAt: later,
      expectedVersion: 2,
    });
    expect(result.changed).toBe(true);
    expect(result.stocktake).toMatchObject({
      status: "CANCELLED",
      version: 3,
      cancelledByMembershipId: posterId,
    });
    expect(result.stocktake.postedAt).toBeUndefined();
    expect(result.stocktake.businessDate).toBeUndefined();
  });

  it("rejects a stale expectedVersion on DRAFT", () => {
    expectDomainError(
      () =>
        decideCancelStocktake({
          stocktake: draft(),
          cancelledByMembershipId: posterId,
          cancelledAt: later,
          expectedVersion: 4,
        }),
      "VERSION_CONFLICT",
      "expectedVersion",
    );
  });

  it("treats CANCELLED as a no-op even with a stale expectedVersion", () => {
    const cancelled = decideCancelStocktake({
      stocktake: draft(),
      cancelledByMembershipId: posterId,
      cancelledAt: later,
      expectedVersion: 1,
    }).stocktake;
    expect(
      decideCancelStocktake({
        stocktake: cancelled,
        cancelledByMembershipId: actorId,
        cancelledAt: createdAt,
        expectedVersion: 99,
      }),
    ).toEqual({ stocktake: cancelled, changed: false });
  });

  it("rejects cancelling a POSTED stocktake", () => {
    expectDomainError(
      () =>
        decideCancelStocktake({
          stocktake: posted(),
          cancelledByMembershipId: posterId,
          cancelledAt: later,
          expectedVersion: 2,
        }),
      "INVALID_TRANSITION",
      "status",
    );
  });
});

describe("stocktake identity", () => {
  it("rejects a line from another stocktake or variant", () => {
    const created = count(draft());
    const other = count(draft({ id: parseStocktakeId(uuid(31)) }), { variantId: variantB }).line;
    expectDomainError(
      () =>
        decideRemoveStocktakeLine({
          stocktake: created.stocktake,
          line: other,
          expectedVersion: 1,
        }),
      "INVALID_VALUE",
      "line",
    );
    expectDomainError(
      () => count(created.stocktake, { current: created.line, expectedVersion: 1, variantId: variantB }),
      "INVALID_VALUE",
      "variantId",
    );
  });
});
