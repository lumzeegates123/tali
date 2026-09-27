import { describe, expect, it } from "vitest";
import { inspectFile, inspectText, isBinaryPath } from "./check.mjs";

const encoder = new TextEncoder();

function utf16le(text: string, withBom: boolean): Uint8Array {
  const units: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    units.push(code & 0xff, code >> 8);
  }
  return Uint8Array.from(withBom ? [0xff, 0xfe, ...units] : units);
}

describe("inspectText", () => {
  it("accepts plain UTF-8, including non-ASCII characters", () => {
    expect(inspectText(encoder.encode("Tali ₦ naira — café\n"))).toEqual([]);
  });

  it("accepts an empty file", () => {
    expect(inspectText(new Uint8Array())).toEqual([]);
  });

  it("rejects a UTF-16 LE byte-order mark", () => {
    expect(inspectText(utf16le("hello", true))).toEqual(["UTF-16 byte-order mark: file is not UTF-8"]);
  });

  it("rejects a UTF-16 BE byte-order mark", () => {
    expect(inspectText(Uint8Array.from([0xfe, 0xff, 0x00, 0x68]))).toEqual([
      "UTF-16 byte-order mark: file is not UTF-8",
    ]);
  });

  it("rejects UTF-16 text without a byte-order mark", () => {
    expect(inspectText(utf16le("hello world", false))).toContain(
      "UTF-16 text without a byte-order mark (alternating null bytes)",
    );
  });

  it("rejects a UTF-32 byte-order mark", () => {
    expect(inspectText(Uint8Array.from([0xff, 0xfe, 0x00, 0x00, 0x68, 0, 0, 0]))).toEqual([
      "UTF-32 byte-order mark: file is not UTF-8",
    ]);
  });

  it("rejects a UTF-8 byte-order mark unless explicitly allowed", () => {
    const bytes = Uint8Array.from([0xef, 0xbb, 0xbf, ...encoder.encode("text")]);
    expect(inspectText(bytes)).toEqual(["UTF-8 byte-order mark (BOM) is prohibited"]);
    expect(inspectText(bytes, { allowUtf8Bom: true })).toEqual([]);
  });

  it("rejects a null byte in otherwise ordinary text", () => {
    const bytes = Uint8Array.from([...encoder.encode("abc"), 0x00, ...encoder.encode("def")]);
    expect(inspectText(bytes)).toEqual(["null byte at offset 3"]);
  });

  it("rejects invalid UTF-8 sequences (e.g. Windows-1252 bytes)", () => {
    expect(inspectText(Uint8Array.from([0x63, 0x61, 0x66, 0xe9]))).toEqual(["invalid UTF-8 byte sequence"]);
  });
});

describe("binary exclusion list", () => {
  it("skips only explicitly listed binary extensions", () => {
    expect(isBinaryPath("assets/logo.PNG")).toBe(true);
    expect(isBinaryPath("docs/file.md")).toBe(false);
    expect(isBinaryPath("Makefile")).toBe(false);
    expect(isBinaryPath(".png")).toBe(false);
  });

  it("does not inspect listed binary files", () => {
    expect(inspectFile("assets/logo.png", Uint8Array.from([0x89, 0x50, 0x00, 0xff]))).toEqual([]);
  });

  it("inspects unknown extensions as text", () => {
    expect(inspectFile("data/export.bin", Uint8Array.from([0x00, 0x01]))).not.toEqual([]);
  });
});
