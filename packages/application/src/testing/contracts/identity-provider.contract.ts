import { describe, expect, it } from "vitest";
import { AuthenticationError } from "../../errors/application-error.js";
import type { IdentityProvider } from "../../ports/identity-provider.js";

export interface IdentityProviderContractSetup {
  readonly provider: IdentityProvider;
  readonly issueValidToken: (subject: string) => Promise<string>;
  readonly issueExpiredToken: (subject: string) => Promise<string>;
}

/** Behaviour every IdentityProvider adapter must satisfy. */
export function describeIdentityProviderContract(
  name: string,
  setup: () => Promise<IdentityProviderContractSetup>,
): void {
  describe(`IdentityProvider contract: ${name}`, () => {
    it("verifies a valid token and returns the subject", async () => {
      const { provider, issueValidToken } = await setup();
      const identity = await provider.verifyAccessToken(await issueValidToken("subject-1"));
      expect(identity.subject).toBe("subject-1");
      expect(["COGNITO", "LOCAL"]).toContain(identity.provider);
      expect(identity.expiresAt.getTime()).toBeGreaterThan(identity.issuedAt.getTime());
      expect(Number.isNaN(identity.authTime.getTime())).toBe(false);
      expect(identity.authTime.getTime()).toBeLessThanOrEqual(identity.issuedAt.getTime());
    });

    it("returns only the verified identity fields, never roles, memberships or raw claims", async () => {
      const { provider, issueValidToken } = await setup();
      const identity = await provider.verifyAccessToken(await issueValidToken("subject-1"));
      expect(Object.keys(identity).sort()).toEqual(["authTime", "expiresAt", "issuedAt", "provider", "subject"]);
    });

    it("rejects a token whose signature or payload was altered", async () => {
      const { provider, issueValidToken } = await setup();
      const token = await issueValidToken("subject-1");
      // A character well inside the last segment carries full bits (a trailing base64url character may not).
      const index = token.lastIndexOf(".") + 10;
      const tampered = `${token.slice(0, index)}${token.charAt(index) === "A" ? "B" : "A"}${token.slice(index + 1)}`;
      await expect(provider.verifyAccessToken(tampered)).rejects.toBeInstanceOf(AuthenticationError);
    });

    it("rejects an expired token", async () => {
      const { provider, issueExpiredToken } = await setup();
      await expect(provider.verifyAccessToken(await issueExpiredToken("subject-1"))).rejects.toBeInstanceOf(
        AuthenticationError,
      );
    });

    it("rejects malformed and empty tokens", async () => {
      const { provider } = await setup();
      await expect(provider.verifyAccessToken("not-a-token")).rejects.toBeInstanceOf(AuthenticationError);
      await expect(provider.verifyAccessToken("")).rejects.toBeInstanceOf(AuthenticationError);
    });
  });
}
