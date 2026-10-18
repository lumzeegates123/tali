import { describe, expect, it } from "vitest";
import {
  formatProvisionLedgerChartsReport,
  parseProvisionLedgerChartsArgs,
  PROVISION_LEDGER_CHARTS_USAGE,
} from "./provision-ledger-charts.js";

const A = "0199f2a0-0000-7000-8000-000000000001";
const B = "0199f2a0-0000-7000-8000-000000000002";

describe("parseProvisionLedgerChartsArgs", () => {
  it("takes one or more --business values, once each, in order", () => {
    expect(parseProvisionLedgerChartsArgs(["--business", A])).toEqual({ businessIds: [A] });
    expect(parseProvisionLedgerChartsArgs(["--business", A, "--business", B, "--business", A])).toEqual({
      businessIds: [A, B],
    });
  });

  it("ignores one leading -- separator passed through by pnpm run", () => {
    expect(parseProvisionLedgerChartsArgs(["--", "--business", A])).toEqual({ businessIds: [A] });
  });

  it.each([
    ["no arguments", []],
    ["only the separator", ["--"]],
    ["a second separator", ["--", "--", "--business", A]],
    ["a flag without a value", ["--business"]],
    ["a value without a flag", [A]],
    ["an unknown flag", ["--all"]],
    ["a flag as the value", ["--business", "--business"]],
    ["a trailing stray argument", ["--business", A, "extra"]],
  ])("rejects %s with the usage text", (_label, argv) => {
    expect(parseProvisionLedgerChartsArgs(argv)).toEqual({ error: PROVISION_LEDGER_CHARTS_USAGE });
  });
});

describe("formatProvisionLedgerChartsReport", () => {
  it("prints identifiers, statuses and codes only, and never echoes input that is not a UUID", () => {
    expect(
      formatProvisionLedgerChartsReport({
        correlationId: "run-1",
        outcomes: [
          { businessId: A, status: "PROVISIONED" },
          { businessId: B, status: "ALREADY_PROVISIONED" },
          { businessId: A, status: "FAILED", code: "LEDGER_CHART_INCOMPLETE" },
          { businessId: "postgres://user:secret@host/db", status: "FAILED", code: "VALIDATION_FAILED" },
        ],
      }),
    ).toEqual([
      `business=${A} status=PROVISIONED`,
      `business=${B} status=ALREADY_PROVISIONED`,
      `business=${A} status=FAILED code=LEDGER_CHART_INCOMPLETE`,
      "business=<invalid> status=FAILED code=VALIDATION_FAILED",
      "summary correlation=run-1 provisioned=1 already_provisioned=1 failed=2",
    ]);
  });
});
