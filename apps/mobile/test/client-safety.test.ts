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

  // Persistent stores (ADR-007 section 6): expo-secure-store only, from two modules: per-business device
  // registrations (Slice 5) and the Cognito session namespace. AsyncStorage is installed only because Amplify's
  // React Native packages require it at module load; Tali never imports it and nothing may be written to it.
  const PERSISTENCE_PACKAGES = ["expo-sqlite", "react-native-mmkv", "react-native-keychain", "expo-file-system"];
  const AMPLIFY_REQUIRED_PEERS = [
    "@react-native-async-storage/async-storage",
    "@aws-amplify/react-native",
    "react-native-get-random-values",
  ];
  const DEVICE_CREDENTIAL_MODULE = join(APP_ROOT, "src", "devices", "device-credential-store.ts");
  const COGNITO_STORAGE_MODULE = join(APP_ROOT, "src", "auth", "cognito", "secure-cognito-storage.ts");
  const AMPLIFY_MODULE = join(APP_ROOT, "src", "auth", "cognito", "amplify-cognito-auth.ts");
  const appSources = () => [...sourceFiles(join(APP_ROOT, "src")), ...sourceFiles(join(APP_ROOT, "app"))];

  it("declares and resolves no persistent storage package other than expo-secure-store", () => {
    const manifest = JSON.parse(readFileSync(join(APP_ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
    expect(declared.filter((name) => PERSISTENCE_PACKAGES.includes(name))).toEqual([]);
    expect(manifest.dependencies?.["expo-secure-store"]).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(resolvableFromApp(PERSISTENCE_PACKAGES)).toEqual(
      Object.fromEntries(PERSISTENCE_PACKAGES.map((specifier) => [specifier, false])),
    );
  });

  it("pins Amplify and its required React Native peers exactly, and nothing else from Amplify", () => {
    const manifest = JSON.parse(readFileSync(join(APP_ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const dependencies = manifest.dependencies ?? {};
    expect(
      Object.keys({ ...dependencies, ...manifest.devDependencies })
        .filter((name) => /amplify|async-storage|get-random-values|netinfo/u.test(name))
        .sort(),
    ).toEqual([
      "@aws-amplify/react-native",
      "@react-native-async-storage/async-storage",
      "aws-amplify",
      "react-native-get-random-values",
    ]);
    for (const name of ["aws-amplify", ...AMPLIFY_REQUIRED_PEERS]) {
      expect(dependencies[name]).toMatch(/^\d+\.\d+\.\d+$/u);
    }
  });

  it("never references AsyncStorage, SQLite or the file system in app source", () => {
    const offenders = appSources().filter((file) =>
      /AsyncStorage|async-storage|SQLite|openDatabase|expo-file-system|localStorage|sessionStorage/u.test(
        readFileSync(file, "utf8"),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("uses SecureStore only in the device credential and Cognito session modules", () => {
    const offenders = appSources().filter(
      (file) =>
        /SecureStore|expo-secure-store/u.test(readFileSync(file, "utf8")) &&
        file !== DEVICE_CREDENTIAL_MODULE &&
        file !== COGNITO_STORAGE_MODULE,
    );
    expect(offenders).toEqual([]);
  });

  it("keeps the two SecureStore namespaces apart", () => {
    const device = readFileSync(DEVICE_CREDENTIAL_MODULE, "utf8");
    const cognito = readFileSync(COGNITO_STORAGE_MODULE, "utf8");
    expect(device).toContain('"tali.device.v1."');
    expect(device).not.toMatch(/tali\.cognito/u);
    expect(cognito).toContain('"tali.cognito.v1."');
    expect(cognito).not.toMatch(/tali\.device/u);
  });

  it("keeps the access token out of the device credential module", () => {
    const source = readFileSync(DEVICE_CREDENTIAL_MODULE, "utf8");
    expect(source).not.toMatch(/AccessToken|accessToken|authorization|userId|displayName/u);
  });

  it("keeps the Cognito session store blind to Amplify's key names and value contents (ADR-007 section 9)", () => {
    const source = readFileSync(COGNITO_STORAGE_MODULE, "utf8");
    expect(source).not.toMatch(
      /accessToken|idToken|refreshToken|LastAuthUser|clockDrift|deviceKey|deviceGroupKey|randomPasswordKey|signInDetails|oauthMetadata|CognitoIdentityServiceProvider|aws-amplify|@aws-amplify/u,
    );
    expect(source).not.toMatch(
      /key\.(includes|startsWith|endsWith|match|split|indexOf)\(|value\.(includes|startsWith|match)\(|JSON\.parse\(value/u,
    );
  });

  it("cannot resolve a JWT library, an AWS SDK, Amplify's internal packages or a Cognito SDK", () => {
    const forbidden = [
      "jose",
      "@aws-amplify/auth",
      "@aws-amplify/core",
      "@aws-amplify/ui-react-native",
      "amazon-cognito-identity-js",
      "@aws-sdk/client-cognito-identity-provider",
    ];
    expect(resolvableFromApp(forbidden)).toEqual(Object.fromEntries(forbidden.map((specifier) => [specifier, false])));
    expect(
      resolvableFromApp(["aws-amplify", "aws-amplify/auth", "aws-amplify/auth/cognito", "aws-amplify/adapter-core"]),
    ).toEqual({
      "aws-amplify": true,
      "aws-amplify/auth": true,
      "aws-amplify/auth/cognito": true,
      "aws-amplify/adapter-core": true,
    });
  });

  it("imports no JWT library, AWS or Cognito SDK, Node.js built-in or backend package in app source", () => {
    const forbiddenImport =
      /from\s+["'](jose|@aws-amplify\/[^"']+|amazon-cognito-identity-js|@aws-sdk\/[^"']+|aws-sdk|node:[^"']+|react-native-get-random-values|@react-native-async-storage\/[^"']+|@tali\/(application|database|integrations)|@tali\/config\/server)["']|require\(["'](aws-amplify|@aws-amplify)/u;
    const offenders = appSources().filter((file) => forbiddenImport.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("imports Amplify in one module, through its public entry points only", () => {
    const amplifyImport = /from\s+["']aws-amplify(\/[^"']*)?["']|import\(["']aws-amplify/u;
    expect(appSources().filter((file) => amplifyImport.test(readFileSync(file, "utf8")))).toEqual([AMPLIFY_MODULE]);
    const specifiers = [...readFileSync(AMPLIFY_MODULE, "utf8").matchAll(/from\s+["'](aws-amplify[^"']*)["']/gu)].map(
      (match) => match[1],
    );
    expect(new Set(specifiers)).toEqual(
      new Set(["aws-amplify", "aws-amplify/adapter-core", "aws-amplify/auth", "aws-amplify/auth/cognito"]),
    );
  });

  it("never reads AWS credentials or server-only variables in app source", () => {
    const offenders = [...sourceFiles(join(APP_ROOT, "src")), ...sourceFiles(join(APP_ROOT, "app"))].filter((file) =>
      /AWS_[A-Z_]+|process\.env\.(?!EXPO_PUBLIC_)[A-Z]/u.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
