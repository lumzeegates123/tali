import { z } from "zod";

export const TALI_ENVIRONMENTS = ["local", "test", "development", "staging", "production"] as const;

export const TaliEnvSchema = z.enum(TALI_ENVIRONMENTS);

export type TaliEnv = z.infer<typeof TaliEnvSchema>;

/** Environments that run on AWS; local, fake and in-memory adapters are forbidden there. */
export const DEPLOYED_ENVIRONMENTS: readonly TaliEnv[] = ["development", "staging", "production"];

export function isDeployedEnvironment(env: TaliEnv): boolean {
  return DEPLOYED_ENVIRONMENTS.includes(env);
}

export type EnvSource = Readonly<Record<string, string | undefined>>;

export interface ConfigurationIssue {
  readonly key: string;
  readonly message: string;
}

/**
 * Raised at startup when configuration is invalid. The message names the keys
 * and the problems but never includes configured values, so secrets cannot
 * leak into logs.
 */
export class ConfigurationError extends Error {
  readonly issues: readonly ConfigurationIssue[];

  constructor(scope: string, issues: readonly ConfigurationIssue[]) {
    super(`Invalid ${scope} configuration:\n${issues.map((issue) => `  - ${issue.key}: ${issue.message}`).join("\n")}`);
    this.name = "ConfigurationError";
    this.issues = issues;
  }
}

export function issuesFromZod(error: z.ZodError): ConfigurationIssue[] {
  return error.issues.map((issue) => ({
    key: issue.path.map(String).join(".") || "(root)",
    message: issue.message,
  }));
}
