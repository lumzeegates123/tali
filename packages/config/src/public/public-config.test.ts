import { describe, expect, it } from "vitest";
import { ConfigurationError, SECRET_NAME_PATTERN } from "../common/environment.js";
import { SERVER_ONLY_ENV_KEYS } from "../common/server-keys.js";
import { loadMobilePublicConfig, loadWebPublicConfig, PUBLIC_ENV_SUFFIXES } from "./public-config.js";

describe("public config", () => {
  it("loads web and mobile configuration from their own prefixes only", () => {
    const env = {
      NEXT_PUBLIC_TALI_ENV: "local",
      NEXT_PUBLIC_API_BASE_URL: "http://localhost:3000",
      EXPO_PUBLIC_TALI_ENV: "local",
      EXPO_PUBLIC_API_BASE_URL: "http://10.0.2.2:3000",
    };
    expect(loadWebPublicConfig(env)).toEqual({ env: "local", apiBaseUrl: "http://localhost:3000" });
    expect(loadMobilePublicConfig(env)).toEqual({ env: "local", apiBaseUrl: "http://10.0.2.2:3000" });
  });

  it("never reads server variables, even when present", () => {
    const config = loadWebPublicConfig({
      NEXT_PUBLIC_TALI_ENV: "local",
      NEXT_PUBLIC_API_BASE_URL: "http://localhost:3000",
      DATABASE_URL: "postgresql://user:secret@localhost/db",
    });
    expect(JSON.stringify(config)).not.toContain("secret");
  });

  it("rejects public variables that re-expose server secrets", () => {
    for (const key of [
      "NEXT_PUBLIC_DATABASE_URL",
      "NEXT_PUBLIC_API_SECRET",
      "NEXT_PUBLIC_COGNITO_CLIENT_SECRET",
      "NEXT_PUBLIC_SQS_QUEUE_URL",
    ]) {
      expect(() =>
        loadWebPublicConfig({
          NEXT_PUBLIC_TALI_ENV: "local",
          NEXT_PUBLIC_API_BASE_URL: "http://localhost:3000",
          [key]: "value",
        }),
      ).toThrow(ConfigurationError);
    }
    expect(() =>
      loadMobilePublicConfig({
        EXPO_PUBLIC_TALI_ENV: "local",
        EXPO_PUBLIC_API_BASE_URL: "http://localhost:3000",
        EXPO_PUBLIC_PRIVATE_KEY: "value",
      }),
    ).toThrow(ConfigurationError);
  });

  it("requires https outside local and test", () => {
    expect(() =>
      loadWebPublicConfig({ NEXT_PUBLIC_TALI_ENV: "production", NEXT_PUBLIC_API_BASE_URL: "http://api.example.com" }),
    ).toThrow(/https/);
    expect(
      loadWebPublicConfig({ NEXT_PUBLIC_TALI_ENV: "production", NEXT_PUBLIC_API_BASE_URL: "https://api.example.com" })
        .apiBaseUrl,
    ).toBe("https://api.example.com");
  });

  it("requires the public Cognito settings together", () => {
    const base = { EXPO_PUBLIC_TALI_ENV: "staging", EXPO_PUBLIC_API_BASE_URL: "https://api.example.com" };
    expect(() => loadMobilePublicConfig({ ...base, EXPO_PUBLIC_COGNITO_REGION: "eu-west-1" })).toThrow(/together/);
    expect(
      loadMobilePublicConfig({
        ...base,
        EXPO_PUBLIC_COGNITO_REGION: "eu-west-1",
        EXPO_PUBLIC_COGNITO_USER_POOL_ID: "eu-west-1_Example123",
        EXPO_PUBLIC_COGNITO_CLIENT_ID: "exampleclientid",
      }).cognito,
    ).toEqual({ region: "eu-west-1", userPoolId: "eu-west-1_Example123", clientId: "exampleclientid" });
  });

  it("defines no public variable that looks secret or server-only", () => {
    for (const suffix of PUBLIC_ENV_SUFFIXES) {
      expect(suffix).not.toMatch(SECRET_NAME_PATTERN);
      expect(SERVER_ONLY_ENV_KEYS).not.toContain(suffix);
    }
  });
});
