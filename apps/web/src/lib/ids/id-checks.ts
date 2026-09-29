import { isUuidV7 } from "@tali/domain/kernel";

/** The ADR-002 section 14 acceptance checks, evaluated in whichever runtime executes this module. */
export interface IdGeneratorCheckReport {
  readonly count: number;
  readonly allUuidV7: boolean;
  readonly allRfcVariant: boolean;
  readonly allCanonical: boolean;
  readonly unique: boolean;
  readonly strictlyIncreasing: boolean;
  /** Calls observed while generating `count` IDs: every ID must come from getRandomValues, none from Math.random. */
  readonly randomSourceCalls: { readonly getRandomValues: number; readonly mathRandom: number };
  readonly passed: boolean;
}

interface Counters {
  getRandomValues: number;
  mathRandom: number;
}

interface RandomValuesHost {
  getRandomValues?: <T extends ArrayBufferView | null>(array: T) => T;
}

/**
 * Counts calls to the secure and insecure random sources while `work` runs
 * synchronously, then restores both. Diagnostics only.
 */
function countRandomSourceCalls(work: () => void): Counters {
  const counters: Counters = { getRandomValues: 0, mathRandom: 0 };
  const webCrypto = (globalThis as { crypto?: RandomValuesHost }).crypto;
  const originalRandom = Math.random;
  const ownGetRandomValues = webCrypto !== undefined && Object.hasOwn(webCrypto, "getRandomValues");
  const originalGetRandomValues = webCrypto?.getRandomValues;
  Math.random = () => {
    counters.mathRandom += 1;
    return originalRandom();
  };
  if (webCrypto !== undefined && originalGetRandomValues !== undefined) {
    webCrypto.getRandomValues = <T extends ArrayBufferView | null>(array: T): T => {
      counters.getRandomValues += 1;
      return originalGetRandomValues.call(webCrypto, array) as T;
    };
  }
  try {
    work();
  } finally {
    Math.random = originalRandom;
    if (webCrypto !== undefined) {
      if (ownGetRandomValues && originalGetRandomValues !== undefined) {
        webCrypto.getRandomValues = originalGetRandomValues;
      } else {
        Reflect.deleteProperty(webCrypto, "getRandomValues");
      }
    }
  }
  return counters;
}

export function checkIdGenerator(generate: () => string, count = 10_000): IdGeneratorCheckReport {
  let ids: string[] = [];
  const calls = countRandomSourceCalls(() => {
    ids = Array.from({ length: count }, generate);
  });
  let strictlyIncreasing = true;
  for (let index = 1; index < ids.length; index += 1) {
    if (!((ids[index] ?? "") > (ids[index - 1] ?? ""))) strictlyIncreasing = false;
  }
  const flags = {
    allUuidV7: ids.every((id) => isUuidV7(id)),
    allRfcVariant: ids.every((id) => ["8", "9", "a", "b"].includes(id.charAt(19))),
    allCanonical: ids.every((id) => id === id.toLowerCase()),
    unique: new Set(ids).size === count,
    strictlyIncreasing,
  };
  const secureOnly = calls.mathRandom === 0 && calls.getRandomValues >= count;
  return {
    count,
    ...flags,
    randomSourceCalls: calls,
    passed: secureOnly && Object.values(flags).every(Boolean),
  };
}
