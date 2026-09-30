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

  it("imports no JWT library, AWS or Cognito SDK, Node.js built-in or backend package in source", () => {
    const forbiddenImport =
      /from\s+["'](jose|aws-amplify|@aws-amplify\/[^"']+|amazon-cognito-identity-js|@aws-sdk\/[^"']+|aws-sdk|node:[^"']+|@tali\/(application|database|integrations)|@tali\/config\/server)["']/u;
    const offenders = sourceFiles(join(APP_ROOT, "src")).filter((file) =>
      forbiddenImport.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("never reads AWS credentials or server-only variables in source", () => {
    const offenders = sourceFiles(join(APP_ROOT, "src")).filter((file) =>
      /AWS_[A-Z_]+|process\.env\.(?!NEXT_PUBLIC_)[A-Z]/u.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
