import { publicEnvironment, readMobileConfig } from "../src/config/mobile-config";

describe("mobile public configuration", () => {
  it("reads only the EXPO_PUBLIC_* variables", () => {
    expect(Object.keys(publicEnvironment()).sort()).toEqual([
      "EXPO_PUBLIC_API_BASE_URL",
      "EXPO_PUBLIC_AUTH_MODE",
      "EXPO_PUBLIC_COGNITO_CLIENT_ID",
      "EXPO_PUBLIC_COGNITO_REGION",
      "EXPO_PUBLIC_COGNITO_USER_POOL_ID",
      "EXPO_PUBLIC_TALI_ENV",
    ]);
  });

  it("accepts a local configuration over http", () => {
    expect(
      readMobileConfig({ EXPO_PUBLIC_TALI_ENV: "local", EXPO_PUBLIC_API_BASE_URL: "http://10.0.2.2:3000" }),
    ).toEqual({
      ok: true,
      config: { env: "local", apiBaseUrl: "http://10.0.2.2:3000", authMode: "local" },
    });
  });

  it("requires https outside local and test", () => {
    const result = readMobileConfig({
      EXPO_PUBLIC_TALI_ENV: "staging",
      EXPO_PUBLIC_API_BASE_URL: "http://api.example.test",
    });
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.issues.map((issue) => issue.key)).toContain("EXPO_PUBLIC_API_BASE_URL");
  });

  it("rejects partial Cognito placeholders", () => {
    const result = readMobileConfig({
      EXPO_PUBLIC_TALI_ENV: "local",
      EXPO_PUBLIC_API_BASE_URL: "http://10.0.2.2:3000",
      EXPO_PUBLIC_COGNITO_REGION: "eu-west-1",
    });
    expect(result.ok).toBe(false);
  });

  it("never reads a server variable even when present in the environment", () => {
    const result = readMobileConfig({
      EXPO_PUBLIC_TALI_ENV: "local",
      EXPO_PUBLIC_API_BASE_URL: "http://10.0.2.2:3000",
      DATABASE_URL: "postgresql://ignored",
    });
    expect(result).toEqual({
      ok: true,
      config: { env: "local", apiBaseUrl: "http://10.0.2.2:3000", authMode: "local" },
    });
  });
});
