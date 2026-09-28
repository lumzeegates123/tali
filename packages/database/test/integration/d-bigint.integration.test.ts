import { Money, parseCurrencyCode } from "@tali/domain";
import { describe, expect, it } from "vitest";
import { loadAmount, loadAmountRaw, saveAmount, sumAmountsRaw } from "../support/fixture-repositories.js";
import { useFixtureHarness, uuid } from "../support/harness.js";

/** Criterion D: BIGINT <-> bigint without coercion to number. */
describe("D. BIGINT round trip", () => {
  const { unitOfWork, owner } = useFixtureHarness();
  const NGN = parseCurrencyCode("NGN");

  const cases = [
    ["MAX_SAFE_INTEGER + 2", BigInt(Number.MAX_SAFE_INTEGER) + 2n],
    ["int8 maximum", 9_223_372_036_854_775_807n],
    ["int8 minimum", -9_223_372_036_854_775_808n],
    ["small value", 1n],
    ["zero", 0n],
  ] as const;

  it.each(cases)("round-trips %s exactly as bigint into domain Money", async (_label, value) => {
    const amount = Money.ofMinor(value, NGN);
    await unitOfWork.run((scope) => saveAmount(scope, uuid(1), amount));
    const loaded = await unitOfWork.run((scope) => loadAmount(scope, uuid(1), NGN));
    expect(typeof loaded?.amountMinor).toBe("bigint");
    expect(loaded?.amountMinor).toBe(value);
    expect(loaded?.equals(amount)).toBe(true);
  });

  it("raw queries return int8 as bigint, not number or string", async () => {
    const value = BigInt(Number.MAX_SAFE_INTEGER) + 2n;
    await unitOfWork.run((scope) => saveAmount(scope, uuid(1), Money.ofMinor(value, NGN)));
    const raw = await unitOfWork.run((scope) => loadAmountRaw(scope, uuid(1)));
    expect(typeof raw).toBe("bigint");
    expect(raw).toBe(value);
  });

  it("the stored value is exact in PostgreSQL (checked as text through a separate connection)", async () => {
    const value = BigInt(Number.MAX_SAFE_INTEGER) + 2n;
    await unitOfWork.run((scope) => saveAmount(scope, uuid(1), Money.ofMinor(value, NGN)));
    const { rows } = await owner.query<{ text: string }>(
      `SELECT amount_minor::text AS text FROM test_fixtures.bigint_probe WHERE id = $1`,
      [uuid(1)],
    );
    expect(rows[0]?.text).toBe("9007199254740993");
  });

  it("database-side aggregation beyond MAX_SAFE_INTEGER stays exact", async () => {
    const big = BigInt(Number.MAX_SAFE_INTEGER);
    await unitOfWork.run(async (scope) => {
      await saveAmount(scope, uuid(1), Money.ofMinor(big, NGN));
      await saveAmount(scope, uuid(2), Money.ofMinor(big, NGN));
      await saveAmount(scope, uuid(3), Money.ofMinor(3n, NGN));
    });
    const total = await unitOfWork.run(sumAmountsRaw);
    expect(typeof total).toBe("bigint");
    expect(total).toBe(big * 2n + 3n);
  });

  it("values beyond int8 are rejected rather than silently truncated", async () => {
    const tooBig = 9_223_372_036_854_775_808n;
    await expect(unitOfWork.run((scope) => saveAmount(scope, uuid(1), Money.ofMinor(tooBig, NGN)))).rejects.toThrow();
  });
});
