import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canaryEnvironment, canaryValue, CANARY_PREFIX, forbiddenNeedles } from "./policy.mjs";
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

  it("injects a canary into every forbidden server variable", () => {
    const env = canaryEnvironment();
    expect(Object.keys(env)).toEqual(expect.arrayContaining(["DATABASE_URL", "SQS_QUEUE_URL", "TEST_DATABASE_URL"]));
    expect(Object.values(env).every((value) => value.startsWith(CANARY_PREFIX))).toBe(true);
    expect(Object.keys(env)).not.toContain("TALI_ENV");
  });
});
