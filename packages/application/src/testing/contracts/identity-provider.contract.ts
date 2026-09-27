import { describe, expect, it } from "vitest";
import { AuthenticationError } from "../../errors/application-error";
import type { IdentityProvider } from "../../ports/identity-provider";

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
      expect(identity.provider.length).toBeGreaterThan(0);
      expect(identity.expiresAt.getTime()).toBeGreaterThan(identity.issuedAt.getTime());
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
