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

  // Build 1 keeps the token and selected business in memory (plan 003 section 7). The one persistent store is
  // expo-secure-store (Slice 5), for per-business device registrations only, used from one module.
  const PERSISTENCE_PACKAGES = [
    "@react-native-async-storage/async-storage",
    "expo-sqlite",
    "react-native-mmkv",
    "react-native-keychain",
  ];
  const DEVICE_CREDENTIAL_MODULE = join(APP_ROOT, "src", "devices", "device-credential-store.ts");

  it("declares and resolves no persistent storage package other than expo-secure-store", () => {
    const manifest = JSON.parse(readFileSync(join(APP_ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
    expect(declared.filter((name) => PERSISTENCE_PACKAGES.includes(name) || name === "expo-file-system")).toEqual([]);
    expect(manifest.dependencies?.["expo-secure-store"]).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(resolvableFromApp(PERSISTENCE_PACKAGES)).toEqual(
      Object.fromEntries(PERSISTENCE_PACKAGES.map((specifier) => [specifier, false])),
    );
  });

  it("never references AsyncStorage, SQLite or the file system in app source", () => {
    const offenders = [...sourceFiles(join(APP_ROOT, "src")), ...sourceFiles(join(APP_ROOT, "app"))].filter((file) =>
      /AsyncStorage|SQLite|openDatabase|expo-file-system|localStorage|sessionStorage/u.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("uses SecureStore only in the device credential module", () => {
    const offenders = [...sourceFiles(join(APP_ROOT, "src")), ...sourceFiles(join(APP_ROOT, "app"))].filter(
      (file) => /SecureStore|expo-secure-store/u.test(readFileSync(file, "utf8")) && file !== DEVICE_CREDENTIAL_MODULE,
    );
    expect(offenders).toEqual([]);
  });

  it("keeps the access token out of the device credential module", () => {
    const source = readFileSync(DEVICE_CREDENTIAL_MODULE, "utf8");
    expect(source).not.toMatch(/AccessToken|accessToken|authorization|userId|displayName/u);
  });

  it("cannot resolve a JWT library or an AWS, Amplify or Cognito SDK", () => {
    const forbidden = [
      "jose",
      "aws-amplify",
      "amazon-cognito-identity-js",
      "@aws-sdk/client-cognito-identity-provider",
    ];
    expect(resolvableFromApp(forbidden)).toEqual(Object.fromEntries(forbidden.map((specifier) => [specifier, false])));
  });

  it("imports no JWT library, AWS or Cognito SDK, Node.js built-in or backend package in app source", () => {
    const forbiddenImport =
      /from\s+["'](jose|aws-amplify|@aws-amplify\/[^"']+|amazon-cognito-identity-js|@aws-sdk\/[^"']+|aws-sdk|node:[^"']+|@tali\/(application|database|integrations)|@tali\/config\/server)["']/u;
    const offenders = [...sourceFiles(join(APP_ROOT, "src")), ...sourceFiles(join(APP_ROOT, "app"))].filter((file) =>
      forbiddenImport.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("never reads AWS credentials or server-only variables in app source", () => {
    const offenders = [...sourceFiles(join(APP_ROOT, "src")), ...sourceFiles(join(APP_ROOT, "app"))].filter((file) =>
      /AWS_[A-Z_]+|process\.env\.(?!EXPO_PUBLIC_)[A-Z]/u.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
