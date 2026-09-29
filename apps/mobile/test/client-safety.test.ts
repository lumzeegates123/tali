import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const APP_ROOT = join(__dirname, "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : [path];
  });
}

describe("mobile client safety", () => {
  it("declares no AWS SDK, backend package or database driver", () => {
    const manifest = JSON.parse(readFileSync(join(APP_ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
    const forbidden =
      /^(@aws-sdk\/|aws-sdk$|@prisma\/|prisma$|pg$|@nestjs\/|@tali\/(application|database|integrations|api|worker)$)/u;
    expect(declared.filter((name) => forbidden.test(name))).toEqual([]);
  });

  // Node's hierarchical node_modules lookup from the app root, in a separate process without NODE_PATH, matches
  // Metro's resolution under pnpm's isolated layout. `pnpm exec` sets NODE_PATH to pnpm's hoisted store directory,
  // which Jest's resolver follows (Metro does not), so Jest's own resolution cannot prove isolation.
  function resolvableFromApp(specifiers: readonly string[]): Record<string, boolean> {
    const script = `const r=require("node:module").createRequire(${JSON.stringify(join(APP_ROOT, "package.json"))});
const out={};for(const s of ${JSON.stringify(specifiers)}){try{r.resolve(s);out[s]=true}catch{out[s]=false}}
process.stdout.write(JSON.stringify(out));`;
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.toUpperCase() === "NODE_PATH") Reflect.deleteProperty(env, key);
    }
    const result = spawnSync(process.execPath, ["-e", script], { cwd: APP_ROOT, encoding: "utf8", env });
    return JSON.parse(result.stdout) as Record<string, boolean>;
  }

  it("resolves the approved client-safe workspace packages", () => {
    expect(resolvableFromApp(["@tali/shared", "@tali/config/public", "@tali/domain/kernel"])).toEqual({
      "@tali/shared": true,
      "@tali/config/public": true,
      "@tali/domain/kernel": true,
    });
  });

  it("cannot resolve backend workspace packages or server SDKs (pnpm isolation)", () => {
    const forbidden = [
      "@tali/application",
      "@tali/database",
      "@tali/integrations",
      "@prisma/client",
      "@nestjs/core",
      "pg",
    ];
    expect(resolvableFromApp(forbidden)).toEqual(Object.fromEntries(forbidden.map((specifier) => [specifier, false])));
  });

  it("never reads AWS credentials or server-only variables in app source", () => {
    const offenders = [...sourceFiles(join(APP_ROOT, "src")), ...sourceFiles(join(APP_ROOT, "app"))].filter((file) =>
      /AWS_[A-Z_]+|process\.env\.(?!EXPO_PUBLIC_)[A-Z]/u.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
