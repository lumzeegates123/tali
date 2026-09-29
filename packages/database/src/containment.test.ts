import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import packageJson from "../package.json" with { type: "json" };

/**
 * Criterion G (type containment): Prisma and pg types must not escape
 * packages/database. Emits the public declarations of every exported entry
 * point in memory, follows every declaration file they reference, and fails if
 * any of them mentions Prisma, the generated client or the pg driver.
 */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FORBIDDEN = [/@prisma\//u, /\bprisma\b/iu, /generated\//u, /from "pg"/u, /\bPool\b/u, /\bPrismaClient\b/u];

function emitPublicDeclarations(): Map<string, string> {
  const configPath = join(packageRoot, "tsconfig.build.json");
  const config = ts.readConfigFile(configPath, (path) => ts.sys.readFile(path));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, packageRoot);
  // Comments are stripped so documentation that mentions Prisma is not mistaken for a type reference.
  const program = ts.createProgram(parsed.fileNames, {
    ...parsed.options,
    emitDeclarationOnly: true,
    declarationMap: false,
    removeComments: true,
  });
  const output = new Map<string, string>();
  const result = program.emit(undefined, (fileName, text) => {
    if (fileName.endsWith(".d.ts")) output.set(normalize(fileName), text);
  });
  expect(result.diagnostics).toEqual([]);
  return output;
}

function reachableDeclarations(declarations: Map<string, string>, entry: string): Map<string, string> {
  const reached = new Map<string, string>();
  const queue = [normalize(entry)];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (reached.has(file)) continue;
    const text = declarations.get(file);
    if (text === undefined) throw new Error(`public declaration ${file} was not emitted`);
    reached.set(file, text);
    for (const match of text.matchAll(/(?:from|import\()\s*"(\.{1,2}\/[^"]+)"/gu)) {
      const specifier = (match[1] as string).replace(/\.js$/u, ".d.ts");
      queue.push(normalize(join(dirname(file), specifier)));
    }
  }
  return reached;
}

describe("type containment (criterion G)", () => {
  const declarations = emitPublicDeclarations();
  const exportsMap = packageJson.exports as Record<string, { types: string }>;

  it("exposes only the documented entry points", () => {
    expect(Object.keys(exportsMap).sort()).toEqual([".", "./testing"]);
  });

  it.each(Object.entries(exportsMap))("entry point %s exposes no Prisma or pg types", (_subpath, target) => {
    const entry = join(packageRoot, target.types);
    const reached = reachableDeclarations(declarations, entry);
    expect(reached.size).toBeGreaterThan(0);
    for (const [file, text] of reached) {
      for (const pattern of FORBIDDEN) {
        expect({ file, leaked: pattern.test(text) }).toEqual({ file, leaked: false });
      }
    }
  });

  it("the check is not vacuous: internal declarations do reference Prisma", () => {
    const internal = [...declarations.entries()].filter(([file]) => file.includes(normalize("unit-of-work/")));
    expect(internal.some(([, text]) => /generated\/prisma/u.test(text))).toBe(true);
  });

  // Importing the root loads the Prisma runtime, the pg adapter and @tali/application through Vite (about 2 s
  // idle); under the full parallel `pnpm verify` load that exceeds Vitest's 5 s default.
  it("the public root exports only createDatabase at runtime", { timeout: 20_000 }, async () => {
    const root = await import("./index.js");
    expect(Object.keys(root).sort()).toEqual(["createDatabase"]);
  });
});
