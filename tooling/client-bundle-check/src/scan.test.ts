import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canaryEnvironment,
  canaryValue,
  CANARY_PREFIX,
  forbiddenNeedles,
  forbiddenValueNeedles,
  THIRD_PARTY_IDENTIFIERS,
} from "./policy.mjs";
import { listFiles, scanFiles } from "./scan.mjs";

const dirs: string[] = [];

function fixture(files: Record<string, Buffer | string>): string {
  const dir = mkdtempSync(join(tmpdir(), "tali-bundle-check-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("client-bundle scan", () => {
  it("finds a server variable name, a placeholder secret and a canary in UTF-8 output", () => {
    const dir = fixture({
      "chunk.js": `const a="DATABASE_URL";const b="local-only-app";const c="${canaryValue("SQS_QUEUE_URL")}";`,
    });
    const findings = scanFiles(listFiles(dir), forbiddenNeedles(), dir).map((finding) => finding.needle);
    expect(findings).toEqual(
      expect.arrayContaining([
        "server variable name DATABASE_URL",
        "placeholder secret local-only-app",
        "canary value",
      ]),
    );
  });

  it("finds one-time secret prefixes (invitation tokens, device credentials)", () => {
    const dir = fixture({ "chunk.js": 'const t="tali_inv_";const d="tali_dev_";' });
    expect(scanFiles(listFiles(dir), forbiddenNeedles(), dir).map((finding) => finding.needle)).toEqual([
      "one-time secret prefix tali_inv_",
      "one-time secret prefix tali_dev_",
    ]);
  });

  it("finds strings stored as UTF-16 (Hermes bytecode string tables for non-ASCII strings)", () => {
    const dir = fixture({
      "entry.hbc": Buffer.concat([Buffer.from([0xc6, 0x1f]), Buffer.from("S3_BUCKET", "utf16le")]),
    });
    expect(scanFiles(listFiles(dir), forbiddenNeedles(), dir)).toEqual([
      { file: "entry.hbc", needle: "server variable name S3_BUCKET", encoding: "utf16le" },
    ]);
  });

  it("reports nothing for public configuration names and values", () => {
    const dir = fixture({
      "chunk.js": 'const e={NEXT_PUBLIC_API_BASE_URL:"http://127.0.0.1:3910",EXPO_PUBLIC_TALI_ENV:"test"};',
    });
    expect(scanFiles(listFiles(dir), forbiddenNeedles(), dir)).toEqual([]);
  });

  it("ignores only aws-amplify's own LOG_LEVEL properties, never a Tali server variable", () => {
    const amplify = fixture({
      "chunk.js": "m.LOG_LEVEL&&(n=m.LOG_LEVEL),window.LOG_LEVEL&&(n=window.LOG_LEVEL);m.BIND_ALL_LOG_LEVELS=!1;",
    });
    expect(scanFiles(listFiles(amplify), forbiddenNeedles(), amplify, THIRD_PARTY_IDENTIFIERS)).toEqual([]);

    for (const leak of [
      'const k="LOG_LEVEL";',
      "const c={LOG_LEVEL:1};",
      "const l=process.env.LOG_LEVEL;",
      `m.LOG_LEVEL="${canaryValue("LOG_LEVEL")}";`,
    ]) {
      const dir = fixture({ "chunk.js": leak });
      expect(scanFiles(listFiles(dir), forbiddenNeedles(), dir, THIRD_PARTY_IDENTIFIERS)).not.toEqual([]);
      // Next to the masked Amplify forms, in the same file, the leak is still found.
      const mixed = fixture({ "chunk.js": `m.LOG_LEVEL&&(n=m.LOG_LEVEL);${leak}m.BIND_ALL_LOG_LEVELS=!1;` });
      expect(scanFiles(listFiles(mixed), forbiddenNeedles(), mixed, THIRD_PARTY_IDENTIFIERS)).not.toEqual([]);
    }
  });

  it("ignores only aws-amplify's Cognito service-name exports, never a Tali SERVICE_NAME", () => {
    const amplify = fixture({
      "chunk.js":
        "e.COGNITO_IDP_SERVICE_NAME=void 0;e.COGNITO_IDENTITY_SERVICE_NAME='cognito-identity';{service:E.COGNITO_IDP_SERVICE_NAME}",
    });
    expect(scanFiles(listFiles(amplify), forbiddenNeedles(), amplify, THIRD_PARTY_IDENTIFIERS)).toEqual([]);

    for (const leak of [
      'const k="SERVICE_NAME";',
      "const c={SERVICE_NAME:1};",
      "const l=process.env.SERVICE_NAME;",
      "e.SERVICE_NAME=1;",
      "e.COGNITO_IDP_SERVICE_NAMES=1;",
      `e.COGNITO_IDP_SERVICE_NAME="${canaryValue("SERVICE_NAME")}";`,
    ]) {
      const dir = fixture({ "chunk.js": leak });
      expect(scanFiles(listFiles(dir), forbiddenNeedles(), dir, THIRD_PARTY_IDENTIFIERS)).not.toEqual([]);
      const mixed = fixture({
        "chunk.js": `e.COGNITO_IDP_SERVICE_NAME=void 0;${leak}e.COGNITO_IDENTITY_SERVICE_NAME=1;`,
      });
      expect(scanFiles(listFiles(mixed), forbiddenNeedles(), mixed, THIRD_PARTY_IDENTIFIERS)).not.toEqual([]);
    }
  });

  it("scans bytecode for values only, so name masks never apply to shared Hermes string bytes", () => {
    const values = forbiddenValueNeedles().map((needle) => needle.label);
    expect(values).toEqual(expect.arrayContaining(["canary value", "placeholder secret local-only-app"]));
    expect(values.some((label) => label.startsWith("server variable name"))).toBe(false);
    const dir = fixture({ "entry.hbc": `BIND_ALL_LOG_LEVELS${canaryValue("LOG_LEVEL")}` });
    expect(scanFiles(listFiles(dir), forbiddenValueNeedles(), dir).map((finding) => finding.needle)).toEqual([
      "canary value",
    ]);
  });

  it("injects a canary into every forbidden server variable", () => {
    const env = canaryEnvironment();
    expect(Object.keys(env)).toEqual(expect.arrayContaining(["DATABASE_URL", "SQS_QUEUE_URL", "TEST_DATABASE_URL"]));
    expect(Object.values(env).every((value) => value.startsWith(CANARY_PREFIX))).toBe(true);
    expect(Object.keys(env)).not.toContain("TALI_ENV");
  });
});
