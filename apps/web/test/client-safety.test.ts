import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const APP_ROOT = join(import.meta.dirname, "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : [path];
  });
}

describe("web client safety", () => {
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

  it("never touches browser persistence: the Build 1 session lives in memory only", () => {
    const offenders = sourceFiles(join(APP_ROOT, "src")).filter((file) =>
      /\b(localStorage|sessionStorage|indexedDB|cookieStore)\b|document\.cookie|set-cookie/iu.test(
        readFileSync(file, "utf8"),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("reads the URL fragment (invitation tokens) only in the module that strips it", () => {
    const offenders = sourceFiles(join(APP_ROOT, "src")).filter(
      (file) =>
        /\.hash\b/u.test(readFileSync(file, "utf8")) &&
        !file.endsWith(join("lib", "invitations", "invitation-link.ts")),
    );
    expect(offenders).toEqual([]);
  });

  it("imports no JWT library, AWS SDK, Amplify internal, Node.js built-in or backend package in source", () => {
    const forbiddenImport =
      /from\s+["'](jose|@aws-amplify\/[^"']+|amazon-cognito-identity-js|@aws-sdk\/[^"']+|aws-sdk|node:[^"']+|@tali\/(application|database|integrations)|@tali\/config\/server)["']/u;
    const offenders = sourceFiles(join(APP_ROOT, "src")).filter((file) =>
      forbiddenImport.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("imports aws-amplify only in the Cognito auth module, through documented entry points", () => {
    const cognitoModule = join("src", "lib", "auth", "cognito");
    const amplifyImport = /from\s+["'](aws-amplify[^"']*)["']/gu;
    const outside: string[] = [];
    const entryPoints = new Set<string>();
    for (const file of sourceFiles(join(APP_ROOT, "src"))) {
      const specifiers = [...readFileSync(file, "utf8").matchAll(amplifyImport)].map((match) => match[1] ?? "");
      if (specifiers.length === 0) continue;
      if (!file.includes(cognitoModule)) outside.push(file);
      for (const specifier of specifiers) entryPoints.add(specifier);
    }
    expect(outside).toEqual([]);
    for (const specifier of entryPoints) {
      expect(["aws-amplify", "aws-amplify/auth", "aws-amplify/auth/cognito", "aws-amplify/utils"]).toContain(specifier);
    }
  });

  it("pins aws-amplify exactly and declares no @aws-amplify/* or amazon-cognito-identity-js package", () => {
    const manifest = JSON.parse(readFileSync(join(APP_ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = { ...manifest.dependencies, ...manifest.devDependencies };
    expect(declared["aws-amplify"]).toBe("6.22.1");
    expect(Object.keys(declared).filter((name) => /^(@aws-amplify\/|amazon-cognito-identity-js$)/u.test(name))).toEqual(
      [],
    );
  });

  it("never reads AWS credentials or server-only variables in source", () => {
    const offenders = sourceFiles(join(APP_ROOT, "src")).filter((file) =>
      /AWS_[A-Z_]+|process\.env\.(?!NEXT_PUBLIC_)[A-Z]/u.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
