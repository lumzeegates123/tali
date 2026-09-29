import type { SecureRandomSource } from "../ids/secure-random";
import { installSecureRandom } from "../ids/secure-random";
import type { IdGeneratorCheckReport } from "../ids/id-checks";
import { checkIdGenerator } from "../ids/id-checks";
import { newUuidV7, SecureRandomUnavailableError } from "../ids/uuidv7";
import type { KernelCompatReport } from "./kernel-compat";
import { runKernelCompat } from "./kernel-compat";

/** Logged as one line so a release build's result can be read from `adb logcat`. */
export const REPORT_LOG_PREFIX = "TALI_COMPAT_REPORT ";

interface HermesInternalLike {
  getRuntimeProperties?: () => Record<string, unknown>;
}

export interface RuntimeEngine {
  readonly hermes: boolean;
  readonly hermesVersion: string | undefined;
  /** Whether bundled modules run in strict mode (React Native's Babel module transform does not force it). */
  readonly strictModeModules: boolean;
}

const strictModeModules = (function (this: unknown) {
  return this === undefined;
})();

export type UuidOutcome =
  | { readonly status: "complete"; readonly randomSource: SecureRandomSource; readonly checks: IdGeneratorCheckReport }
  | { readonly status: "refused"; readonly reason: string };

export interface RuntimeReport {
  readonly engine: RuntimeEngine;
  readonly kernel: KernelCompatReport;
  readonly uuidV7: UuidOutcome;
}

function detectEngine(): RuntimeEngine {
  const hermes = (globalThis as { HermesInternal?: HermesInternalLike }).HermesInternal;
  const version = hermes?.getRuntimeProperties?.()["OSS Release Version"];
  return {
    hermes: hermes !== undefined,
    hermesVersion: typeof version === "string" ? version : undefined,
    strictModeModules,
  };
}

function runUuidChecks(): UuidOutcome {
  const randomSource = installSecureRandom();
  try {
    return { status: "complete", randomSource, checks: checkIdGenerator(newUuidV7) };
  } catch (error) {
    if (!(error instanceof SecureRandomUnavailableError)) throw error;
    return { status: "refused", reason: error.message };
  }
}

export function runRuntimeReport(): RuntimeReport {
  return { engine: detectEngine(), kernel: runKernelCompat(), uuidV7: runUuidChecks() };
}
