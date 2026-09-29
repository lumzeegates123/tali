import { describe, expect, it } from "vitest";
import { ConfigurationError } from "../common/environment.js";
import { SERVER_ENV_KEYS } from "../common/server-keys.js";
import { PUBLIC_ENV_SUFFIXES } from "../public/public-config.js";
import {
  assertNoExposedMobileSecrets,
  assertNoExposedWebSecrets,
  CLIENT_FORBIDDEN_ENV_NAMES,
  validateMobileBuildEnvironment,
  validateWebBuildEnvironment,
} from "./index.js";

const WEB = { NEXT_PUBLIC_TALI_ENV: "local", NEXT_PUBLIC_API_BASE_URL: "http://localhost:3000" };
const MOBILE = { EXPO_PUBLIC_TALI_ENV: "local", EXPO_PUBLIC_API_BASE_URL: "http://10.0.2.2:3000" };

describe("public build guard", () => {
  it("rejects public variables that re-expose server secrets", () => {
    for (const key of [
      "NEXT_PUBLIC_DATABASE_URL",
      "NEXT_PUBLIC_API_SECRET",
      "NEXT_PUBLIC_COGNITO_CLIENT_SECRET",
      "NEXT_PUBLIC_SQS_QUEUE_URL",
    ]) {
      expect(() => validateWebBuildEnvironment({ ...WEB, [key]: "value" })).toThrow(ConfigurationError);
      expect(() => {
        assertNoExposedWebSecrets({ [key]: "value" });
      }).toThrow(ConfigurationError);
    }
    expect(() => validateMobileBuildEnvironment({ ...MOBILE, EXPO_PUBLIC_PRIVATE_KEY: "value" })).toThrow(
      ConfigurationError,
    );
    expect(() => {
      assertNoExposedMobileSecrets({ EXPO_PUBLIC_S3_BUCKET: "value" });
    }).toThrow(ConfigurationError);
  });

  it("names the exposed key but never its value", () => {
    expect(() => validateWebBuildEnvironment({ ...WEB, NEXT_PUBLIC_DB_PASSWORD: "hunter2-value" })).toThrow(
      /NEXT_PUBLIC_DB_PASSWORD/,
    );
    expect(() => validateWebBuildEnvironment({ ...WEB, NEXT_PUBLIC_DB_PASSWORD: "hunter2-value" })).not.toThrow(
      /hunter2-value/,
    );
  });

  it("accepts a clean environment even when server variables are present unprefixed", () => {
    expect(validateWebBuildEnvironment({ ...WEB, DATABASE_URL: "postgresql://x" }).apiBaseUrl).toBe(
      "http://localhost:3000",
    );
    expect(validateMobileBuildEnvironment(MOBILE).env).toBe("local");
  });

  it("lists every server-only name for the client-bundle check, and no public suffix", () => {
    const publicSuffixes: readonly string[] = PUBLIC_ENV_SUFFIXES;
    for (const key of SERVER_ENV_KEYS) {
      expect(CLIENT_FORBIDDEN_ENV_NAMES.includes(key)).toBe(!publicSuffixes.includes(key));
    }
    expect(CLIENT_FORBIDDEN_ENV_NAMES).toContain("DATABASE_URL");
    expect(CLIENT_FORBIDDEN_ENV_NAMES).toContain("MIGRATION_DATABASE_URL");
    for (const suffix of PUBLIC_ENV_SUFFIXES) {
      expect(CLIENT_FORBIDDEN_ENV_NAMES).not.toContain(suffix);
    }
  });
});
