import type * as CognitoDevice from "./support/cognito-device";
import { createHash } from "node:crypto";
import {
  COGNITO_ITEM_NAMES,
  COGNITO_NAMESPACE,
  CognitoStorageError,
  createSecureCognitoStorage,
  MAX_CHUNK_BYTES,
  MAX_CHUNKS,
  MAX_ENTRIES,
  splitUtf8,
  type SecureStoreModule,
} from "../src/auth/cognito/secure-cognito-storage";
import { createSecureDeviceCredentialStore, deviceRegistrationKey } from "../src/devices/device-credential-store";
import { device, resetDevice } from "./support/cognito-device";

jest.mock("expo-secure-store", () =>
  jest.requireActual<typeof CognitoDevice>("./support/cognito-device").secureStoreMock(),
);
jest.mock("expo-crypto", () => jest.requireActual<typeof CognitoDevice>("./support/cognito-device").expoCryptoMock());

const KEY = "CognitoIdentityServiceProvider.syntheticclient.0191a1b2-0000-7000-8000-00000000c0de.refreshToken";
const OTHER_KEY = "CognitoIdentityServiceProvider.syntheticclient.LastAuthUser";
const BUSINESS_ID = "0191a1b2-0000-7000-8000-0000000000b1";
const DEVICE = { deviceId: "0191a1b2-0000-7000-8000-0000000000d1", credential: "synthetic-device-credential" };
const INDEX = `${COGNITO_NAMESPACE}index`;

const utf8Length = (value: string) => Buffer.byteLength(value, "utf8");
const cognitoKeys = () => [...device().secure.keys()].filter((key) => key.startsWith(COGNITO_NAMESPACE));
const chunkKeys = () => cognitoKeys().filter((key) => key.startsWith(`${COGNITO_NAMESPACE}c.`));
const manifestKeys = () => cognitoKeys().filter((key) => key.startsWith(`${COGNITO_NAMESPACE}m.`));
/** `tali.cognito.v1.c.<slot>.<g>.<i>` -> `<g>` */
const generationOf = (chunk: string) => chunk.split(".")[5];
const idOf = (key: string) => createHash("sha256").update(`${COGNITO_NAMESPACE}${key}`).digest("hex").slice(0, 32);

/** A JWT-shaped value of the given size; realistic Cognito tokens are 1 to 2 KB. */
const tokenLike = (bytes: number, seed = "a") => `eyJ${seed.repeat(Math.max(0, bytes - 3))}`;

beforeEach(() => {
  resetDevice();
});

describe("Cognito session store: values round-trip exactly", () => {
  const cases: [string, string][] = [
    ["empty", ""],
    ["short ASCII", "synthetic"],
    ["multibyte", "naïve café ₦ 漢字".repeat(5)],
    ["emoji (four-byte, surrogate pairs)", "🔐🧾💳".repeat(30)],
    ["one byte below the chunk boundary", "x".repeat(MAX_CHUNK_BYTES - 1)],
    ["exactly at the chunk boundary", "x".repeat(MAX_CHUNK_BYTES)],
    ["one byte above the chunk boundary", "x".repeat(MAX_CHUNK_BYTES + 1)],
    ["above 2 KiB", "y".repeat(2049)],
    ["much larger (15 KiB)", "z".repeat(15 * 1024)],
    ["exactly the bounded size", "z".repeat(MAX_CHUNKS * MAX_CHUNK_BYTES)],
    ["a realistic access token", tokenLike(1100)],
    ["a realistic ID token", tokenLike(1400, "b")],
    ["a realistic refresh token (opaque JWE)", tokenLike(1780, "c")],
    ["multibyte straddling a boundary", `${"x".repeat(MAX_CHUNK_BYTES - 1)}€${"x".repeat(10)}`],
    ["emoji straddling a boundary", `${"x".repeat(MAX_CHUNK_BYTES - 2)}😀${"x".repeat(10)}`],
  ];

  it.each(cases)("%s", async (_name, value) => {
    const storage = createSecureCognitoStorage();
    await storage.setItem(KEY, value);
    expect(await storage.getItem(KEY)).toBe(value);
    const expectedChunks = Math.ceil(utf8Length(value) / MAX_CHUNK_BYTES);
    expect(chunkKeys().length).toBeGreaterThanOrEqual(expectedChunks);
    for (const key of chunkKeys()) {
      const chunk = device().secure.get(key) ?? "";
      expect(utf8Length(chunk)).toBeGreaterThan(0);
      expect(utf8Length(chunk)).toBeLessThanOrEqual(MAX_CHUNK_BYTES);
      expect(chunk).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
    }
    // A fresh adapter over the same device (an app restart) reads the same value.
    expect(await createSecureCognitoStorage().getItem(KEY)).toBe(value);
  });

  it("splits on code points only, never inside a character", () => {
    const { chunks, bytes } = splitUtf8(`${"x".repeat(MAX_CHUNK_BYTES - 1)}😀`);
    expect(chunks).toEqual(["x".repeat(MAX_CHUNK_BYTES - 1), "😀"]);
    expect(bytes).toBe(MAX_CHUNK_BYTES + 3);
  });

  it("refuses text that is not well-formed UTF-16 instead of storing it altered", async () => {
    const storage = createSecureCognitoStorage();
    await expect(storage.setItem(KEY, "bad\uD800text")).rejects.toBeInstanceOf(CognitoStorageError);
    expect(cognitoKeys()).toEqual([]);
  });

  it("refuses values above the bounded size", async () => {
    const storage = createSecureCognitoStorage();
    await expect(storage.setItem(KEY, "x".repeat(MAX_CHUNKS * MAX_CHUNK_BYTES + 1))).rejects.toBeInstanceOf(
      CognitoStorageError,
    );
    expect(cognitoKeys()).toEqual([]);
  });

  it("returns null for a key never written", async () => {
    expect(await createSecureCognitoStorage().getItem(KEY)).toBeNull();
  });
});

describe("Cognito session store: opaque, bounded format", () => {
  it("names keystore items by slot and position only: no key text, username or value in any item name", async () => {
    const storage = createSecureCognitoStorage();
    await storage.setItem(KEY, "secret-value-1");
    for (const name of cognitoKeys()) {
      expect(name).toMatch(/^tali\.cognito\.v1\.(index|m\.\d+|c\.\d+\.[01]\.\d+)$/u);
    }
  });

  it("uses only item names from the fixed, bounded list", async () => {
    expect(new Set(COGNITO_ITEM_NAMES).size).toBe(COGNITO_ITEM_NAMES.length);
    expect(COGNITO_ITEM_NAMES).toHaveLength(MAX_ENTRIES * 2 * MAX_CHUNKS + MAX_ENTRIES + 1);
    const storage = createSecureCognitoStorage();
    for (let i = 0; i < MAX_ENTRIES; i += 1) {
      await storage.setItem(`key-${String(i)}`, tokenLike(MAX_CHUNKS * MAX_CHUNK_BYTES - i * 700, String(i % 10)));
      await storage.setItem(`key-${String(i)}`, tokenLike(1500, "r"));
    }
    const written = new Set(
      device()
        .secureCalls.filter((call) => call.op === "set")
        .map((call) => call.key),
    );
    for (const name of written) expect(COGNITO_ITEM_NAMES).toContain(name);
  });

  it("keeps only metadata in the manifest and identifiers in the index", async () => {
    const storage = createSecureCognitoStorage();
    const value = tokenLike(2500);
    await storage.setItem(KEY, value);
    expect(manifestKeys()).toEqual([`${COGNITO_NAMESPACE}m.0`]);
    expect(JSON.parse(device().secure.get(`${COGNITO_NAMESPACE}m.0`) ?? "")).toEqual({
      v: 1,
      i: idOf(KEY),
      g: 0,
      n: 3,
      b: 2500,
    });
    expect(JSON.parse(device().secure.get(INDEX) ?? "")).toEqual({ v: 1, e: [{ i: idOf(KEY), s: 0, l: [0, 3] }] });
    const metadata = `${device().secure.get(`${COGNITO_NAMESPACE}m.0`) ?? ""}${device().secure.get(INDEX) ?? ""}`;
    expect(metadata).not.toContain("eyJ");
    expect(metadata).not.toContain("refreshToken");
  });

  it("transforms keys without looking at them: equal keys map to one entry, different keys to different entries", async () => {
    const storage = createSecureCognitoStorage();
    // Names that a key-matching implementation would special-case are handled exactly like any other key.
    const keys = [KEY, OTHER_KEY, "refreshToken", "accessToken", "anything at all", "", "☃.unicode"];
    for (const [index, key] of keys.entries()) await storage.setItem(key, `value-${String(index)}`);
    for (const [index, key] of keys.entries()) expect(await storage.getItem(key)).toBe(`value-${String(index)}`);
    expect(manifestKeys()).toHaveLength(keys.length);
  });

  it("stores every item with WHEN_UNLOCKED_THIS_DEVICE_ONLY", async () => {
    const storage = createSecureCognitoStorage();
    await storage.setItem(KEY, tokenLike(3000));
    await storage.getItem(KEY);
    await storage.removeItem(KEY);
    await storage.clear();
    expect(device().secureCalls.length).toBeGreaterThan(0);
    for (const call of device().secureCalls) expect(call.options).toEqual({ keychainAccessible: 6 });
  });

  it("bounds the index", async () => {
    const storage = createSecureCognitoStorage();
    for (let i = 0; i < MAX_ENTRIES; i += 1) await storage.setItem(`key-${String(i)}`, "v");
    await expect(storage.setItem("one-too-many", "v")).rejects.toBeInstanceOf(CognitoStorageError);
    expect(await storage.getItem("one-too-many")).toBeNull();
    expect(utf8Length(device().secure.get(INDEX) ?? "")).toBeLessThanOrEqual(MAX_CHUNK_BYTES);
  });

  it("reuses a freed slot", async () => {
    const storage = createSecureCognitoStorage();
    for (let i = 0; i < MAX_ENTRIES; i += 1) await storage.setItem(`key-${String(i)}`, "v");
    await storage.removeItem("key-3");
    await storage.setItem("replacement", "w");
    expect(await storage.getItem("replacement")).toBe("w");
    expect(manifestKeys()).toHaveLength(MAX_ENTRIES);
  });

  it("error messages carry no key, value or token material", async () => {
    const storage = createSecureCognitoStorage();
    const secret = "secret-material-\uD800";
    const error = (await storage.setItem(KEY, secret).catch((caught: unknown) => caught)) as Error;
    expect(error.message).not.toContain("secret-material");
    expect(error.message).not.toContain(KEY);
    expect(error.message).not.toContain("refreshToken");
  });
});

describe("Cognito session store: replacement", () => {
  it("replaces a value with the other generation and removes the old one", async () => {
    const storage = createSecureCognitoStorage();
    await storage.setItem(KEY, tokenLike(3000, "a"));
    await storage.setItem(KEY, tokenLike(1200, "b"));
    expect(await storage.getItem(KEY)).toBe(tokenLike(1200, "b"));
    expect(chunkKeys().map(generationOf)).toEqual(["1", "1"]);
    // Rotation alternates between two generations and does not retain a chain of earlier values.
    for (let i = 0; i < 5; i += 1) await storage.setItem(KEY, tokenLike(1800, String(i)));
    expect(chunkKeys()).toHaveLength(2);
    expect(new Set(chunkKeys().map(generationOf)).size).toBe(1);
    expect(manifestKeys()).toHaveLength(1);
    expect(await storage.getItem(KEY)).toBe(tokenLike(1800, "4"));
  });

  it("a shorter value leaves no chunk of a longer one behind", async () => {
    const storage = createSecureCognitoStorage();
    await storage.setItem(KEY, tokenLike(5000, "a"));
    await storage.setItem(KEY, tokenLike(900, "b"));
    await storage.setItem(KEY, tokenLike(1500, "c"));
    expect(chunkKeys()).toHaveLength(2);
    expect(await createSecureCognitoStorage().getItem(KEY)).toBe(tokenLike(1500, "c"));
  });

  it("serialises concurrent writes and reads in call order", async () => {
    const storage = createSecureCognitoStorage();
    const writes = Array.from({ length: 8 }, (_, i) => storage.setItem(KEY, tokenLike(1500 + i, String(i))));
    const read = storage.getItem(KEY);
    await Promise.all(writes);
    expect(await read).toBe(tokenLike(1507, "7"));
  });

  // Writes in order: index (pending), chunks, manifest, old chunk removal, index (settled).
  it.each([
    ["the pending index record", 0],
    ["the first new chunk", 1],
    ["a later new chunk", 2],
    ["the manifest switch", 3],
  ])("an interruption at %s leaves the old generation authoritative", async (_name, writesBeforeFailure) => {
    const storage = createSecureCognitoStorage();
    const old = tokenLike(1500, "o");
    await storage.setItem(KEY, old);
    device().failWritesFrom = { prefix: COGNITO_NAMESPACE, afterWrites: writesBeforeFailure };
    await expect(storage.setItem(KEY, tokenLike(1500, "n"))).rejects.toThrow("simulated interruption");
    device().failWritesFrom = undefined;
    const restarted = createSecureCognitoStorage();
    expect(await restarted.getItem(KEY)).toBe(old);
    // Orphaned chunks of the abandoned generation are removed.
    expect(chunkKeys().map(generationOf)).toEqual(["0", "0"]);
  });

  it("an interruption after the manifest switch keeps the new generation and cleans the old", async () => {
    const storage = createSecureCognitoStorage();
    await storage.setItem(KEY, tokenLike(1500, "o"));
    device().failWritesFrom = { prefix: INDEX, afterWrites: 1 };
    await expect(storage.setItem(KEY, tokenLike(1500, "n"))).rejects.toThrow("simulated interruption");
    device().failWritesFrom = undefined;
    expect(await createSecureCognitoStorage().getItem(KEY)).toBe(tokenLike(1500, "n"));
    expect(chunkKeys().map(generationOf)).toEqual(["1", "1"]);
  });

  it("an interrupted first write leaves nothing readable and no orphans", async () => {
    const storage = createSecureCognitoStorage();
    device().failWritesFrom = { prefix: `${COGNITO_NAMESPACE}m.`, afterWrites: 0 };
    await expect(storage.setItem(KEY, tokenLike(2500))).rejects.toThrow("simulated interruption");
    device().failWritesFrom = undefined;
    expect(await createSecureCognitoStorage().getItem(KEY)).toBeNull();
    expect(cognitoKeys()).toEqual([]);
  });
});

describe("Cognito session store: corruption fails closed", () => {
  const MANIFEST = `${COGNITO_NAMESPACE}m.0`;
  const CHUNKS = [0, 1, 2].map((i) => `${COGNITO_NAMESPACE}c.0.0.${String(i)}`);

  async function stored(): Promise<void> {
    const storage = createSecureCognitoStorage();
    await storage.setItem(KEY, tokenLike(2500));
    await storage.setItem(OTHER_KEY, "synthetic-user");
    expect(device().secure.has(MANIFEST)).toBe(true);
    for (const chunk of CHUNKS) expect(device().secure.has(chunk)).toBe(true);
  }

  async function expectWiped(): Promise<void> {
    const storage = createSecureCognitoStorage();
    expect(await storage.getItem(KEY)).toBeNull();
    // The whole session goes, not just the damaged entry: a partial session is never returned.
    expect(await storage.getItem(OTHER_KEY)).toBeNull();
    expect(cognitoKeys()).toEqual([]);
  }

  const manifest = (fields: Record<string, unknown>) =>
    JSON.stringify({ v: 1, i: idOf(KEY), g: 0, n: 3, b: 2500, ...fields });

  const corruptions: [string, () => void][] = [
    ["a missing manifest", () => device().secure.delete(MANIFEST)],
    ["a missing chunk", () => device().secure.delete(CHUNKS[1] ?? "")],
    ["an extra chunk", () => device().secure.set(`${COGNITO_NAMESPACE}c.0.0.3`, "extra")],
    ["a truncated chunk (length mismatch)", () => device().secure.set(CHUNKS[0] ?? "", "short")],
    ["an empty chunk", () => device().secure.set(CHUNKS[2] ?? "", "")],
    ["an oversized chunk", () => device().secure.set(CHUNKS[0] ?? "", "x".repeat(MAX_CHUNK_BYTES + 1))],
    ["an invalid encoding in a chunk", () => device().secure.set(CHUNKS[0] ?? "", `${"x".repeat(1023)}\uDC00`)],
    ["an unknown format version", () => device().secure.set(MANIFEST, manifest({ v: 2 }))],
    ["a manifest that is not JSON", () => device().secure.set(MANIFEST, "{not json")],
    ["a manifest with a wrong total", () => device().secure.set(MANIFEST, manifest({ b: 2499 }))],
    ["a manifest with impossible counts", () => device().secure.set(MANIFEST, manifest({ n: -1, b: 1 }))],
    ["a manifest naming another entry", () => device().secure.set(MANIFEST, manifest({ i: idOf(OTHER_KEY) }))],
    ["a manifest naming the other generation", () => device().secure.set(MANIFEST, manifest({ g: 1 }))],
  ];

  it.each(corruptions)("%s", async (_name, corrupt) => {
    await stored();
    corrupt();
    await expectWiped();
  });

  it("a corrupt index makes every entry unreadable and the namespace is cleared", async () => {
    await stored();
    device().secure.set(INDEX, "{corrupt");
    const storage = createSecureCognitoStorage();
    expect(await storage.isEmpty()).toBe(false);
    expect(await storage.getItem(KEY)).toBeNull();
    expect(await storage.getItem(OTHER_KEY)).toBeNull();
    expect(cognitoKeys()).toEqual([]);
  });

  it("an entry the index does not list is never returned, and the next write clears it", async () => {
    await stored();
    device().secure.delete(INDEX);
    const storage = createSecureCognitoStorage();
    expect(await storage.getItem(KEY)).toBeNull();
    // Manifests left without an index still count as stored data.
    expect(await storage.isEmpty()).toBe(false);
    await storage.setItem("next", "value");
    expect(await storage.getItem("next")).toBe("value");
    expect(cognitoKeys().sort()).toEqual([INDEX, `${COGNITO_NAMESPACE}c.0.0.0`, MANIFEST].sort());
  });
});

describe("Cognito session store: clearing does not depend on the index", () => {
  /** Several entries, a multi-chunk value, an interrupted replacement and an interrupted first write. */
  async function populated(): Promise<Set<string>> {
    await createSecureDeviceCredentialStore().save(BUSINESS_ID, DEVICE);
    const storage = createSecureCognitoStorage();
    await storage.setItem(KEY, tokenLike(3500, "a"));
    await storage.setItem(OTHER_KEY, "synthetic-user");
    for (let i = 0; i < 4; i += 1) await storage.setItem(`entry-${String(i)}`, tokenLike(1200 + i * 400, String(i)));
    // A replacement interrupted before its manifest switch: an orphan generation next to the committed one.
    device().failWritesFrom = { prefix: `${COGNITO_NAMESPACE}m.`, afterWrites: 0 };
    await expect(storage.setItem(KEY, tokenLike(4500, "b"))).rejects.toThrow("simulated interruption");
    // A first write interrupted the same way: chunks that no manifest names.
    await expect(storage.setItem("never-committed", tokenLike(2200, "c"))).rejects.toThrow("simulated interruption");
    device().failWritesFrom = undefined;
    const names = new Set(cognitoKeys());
    const orphanGeneration = [...names].filter((name) => name.startsWith(`${COGNITO_NAMESPACE}c.0.1.`));
    expect(orphanGeneration.length).toBeGreaterThan(0);
    expect(names.size).toBeGreaterThan(20);
    return names;
  }

  const damages: [string, () => void][] = [
    ["the index is deleted", () => device().secure.delete(INDEX)],
    ["the index is not JSON", () => device().secure.set(INDEX, "{corrupt")],
    ["the index has an unknown version", () => device().secure.set(INDEX, JSON.stringify({ v: 9, e: [] }))],
    ["the index is valid but lists nothing", () => device().secure.set(INDEX, JSON.stringify({ v: 1, e: [] }))],
    [
      "the index is valid but lists one wrong entry",
      () => device().secure.set(INDEX, JSON.stringify({ v: 1, e: [{ i: idOf("unrelated"), s: 11, l: [1, 1] }] })),
    ],
  ];

  it.each(damages)("%s: clear removes every Cognito item and keeps the Device registration", async (_name, damage) => {
    const before = await populated();
    damage();
    // A fresh runtime: nothing is known except what is on the device.
    const storage = createSecureCognitoStorage();
    await storage.clear();
    expect(cognitoKeys()).toEqual([]);
    for (const name of before) expect(device().secure.has(name)).toBe(false);
    expect(await storage.isEmpty()).toBe(true);
    expect([...device().secure.keys()]).toEqual([deviceRegistrationKey(BUSINESS_ID)]);
    expect(await createSecureDeviceCredentialStore().read(BUSINESS_ID)).toEqual(DEVICE);
    // Clearing touched no item outside the Cognito namespace.
    for (const call of device().secureCalls.filter((item) => item.op === "delete")) {
      expect(call.key.startsWith(COGNITO_NAMESPACE)).toBe(true);
    }
  });

  it("a clear that cannot delete every item fails and keeps the index, so the namespace is not reported empty", async () => {
    await populated();
    const secureStore = jest.requireMock<SecureStoreModule>("expo-secure-store");
    let failures = 1;
    const storage = createSecureCognitoStorage({
      secureStore: {
        getItemAsync: (key, options) => secureStore.getItemAsync(key, options),
        setItemAsync: (key, value, options) => secureStore.setItemAsync(key, value, options),
        deleteItemAsync: (key, options) => {
          if (key.startsWith(`${COGNITO_NAMESPACE}c.`) && failures > 0) {
            failures -= 1;
            return Promise.reject(new Error("simulated keystore failure"));
          }
          return secureStore.deleteItemAsync(key, options);
        },
      },
    });
    await expect(storage.clear()).rejects.toBeInstanceOf(CognitoStorageError);
    expect(await storage.isEmpty()).toBe(false);
    await storage.clear();
    expect(cognitoKeys()).toEqual([]);
  });
});

describe("Cognito session store: removal and namespace separation", () => {
  it("removeItem removes the manifest and every chunk of that entry only", async () => {
    const storage = createSecureCognitoStorage();
    await storage.setItem(KEY, tokenLike(2500));
    await storage.setItem(OTHER_KEY, "synthetic-user");
    await storage.removeItem(KEY);
    expect(await storage.getItem(KEY)).toBeNull();
    expect(await storage.getItem(OTHER_KEY)).toBe("synthetic-user");
    expect(manifestKeys()).toHaveLength(1);
    expect(chunkKeys()).toHaveLength(1);
  });

  it("clear removes manifests, chunks, orphans and the index, and never touches device registrations", async () => {
    const deviceStore = createSecureDeviceCredentialStore();
    await deviceStore.save(BUSINESS_ID, DEVICE);
    const storage = createSecureCognitoStorage();
    await storage.setItem(KEY, tokenLike(2500));
    await storage.setItem(OTHER_KEY, "synthetic-user");
    // An orphan from an interrupted write.
    device().failWritesFrom = { prefix: `${COGNITO_NAMESPACE}m.`, afterWrites: 0 };
    await expect(storage.setItem("orphan", tokenLike(2500))).rejects.toThrow();
    device().failWritesFrom = undefined;
    await storage.clear();
    expect(cognitoKeys()).toEqual([]);
    expect(await storage.isEmpty()).toBe(true);
    expect([...device().secure.keys()]).toEqual([deviceRegistrationKey(BUSINESS_ID)]);
    expect(await deviceStore.read(BUSINESS_ID)).toEqual(DEVICE);
  });

  it("clearing device registrations never touches the Cognito namespace", async () => {
    const deviceStore = createSecureDeviceCredentialStore();
    await deviceStore.save(BUSINESS_ID, DEVICE);
    const storage = createSecureCognitoStorage();
    await storage.setItem(KEY, "synthetic");
    await deviceStore.clear(BUSINESS_ID);
    expect(await storage.getItem(KEY)).toBe("synthetic");
  });

  it("the two namespaces cannot collide", () => {
    expect(COGNITO_NAMESPACE).toBe("tali.cognito.v1.");
    expect(deviceRegistrationKey(BUSINESS_ID).startsWith(COGNITO_NAMESPACE)).toBe(false);
    expect(deviceRegistrationKey(BUSINESS_ID).startsWith("tali.device.v1.")).toBe(true);
    for (const name of COGNITO_ITEM_NAMES) expect(name.startsWith(COGNITO_NAMESPACE)).toBe(true);
  });
});

describe("Cognito session store: session leases", () => {
  it("an active lease reads and writes the namespace", async () => {
    const lease = createSecureCognitoStorage().lease();
    await lease.setItem(KEY, "v1");
    expect(await lease.getItem(KEY)).toBe("v1");
    await lease.removeItem(KEY);
    expect(await lease.getItem(KEY)).toBeNull();
  });

  it("a frozen lease still reads but writes nothing", async () => {
    const lease = createSecureCognitoStorage().lease();
    await lease.setItem(KEY, "v1");
    lease.freeze();
    const before = new Map(device().secure);
    await lease.setItem(KEY, "v2");
    await lease.setItem(OTHER_KEY, "v3");
    await lease.removeItem(KEY);
    await lease.clear();
    expect(new Map(device().secure)).toEqual(before);
    expect(await lease.getItem(KEY)).toBe("v1");
  });

  it("a revoked lease reads nothing and writes nothing", async () => {
    const storage = createSecureCognitoStorage();
    const lease = storage.lease();
    await lease.setItem(KEY, "v1");
    lease.revoke();
    lease.freeze();
    const before = new Map(device().secure);
    expect(await lease.getItem(KEY)).toBeNull();
    await lease.setItem(KEY, "v2");
    await lease.removeItem(KEY);
    await lease.clear();
    expect(new Map(device().secure)).toEqual(before);
    expect(await storage.getItem(KEY)).toBe("v1");
  });

  it("a new lease revokes the previous one, including operations it queued that have not run yet", async () => {
    const storage = createSecureCognitoStorage();
    const first = storage.lease();
    await first.setItem(KEY, "first");
    const late = [first.setItem(KEY, "late"), first.removeItem(OTHER_KEY), first.clear()];
    const lateRead = first.getItem(KEY);
    const second = storage.lease();
    await Promise.all(late);
    expect(await lateRead).toBeNull();
    expect(await second.getItem(KEY)).toBe("first");
    await second.setItem(OTHER_KEY, "second");
    await first.setItem(OTHER_KEY, "stale");
    await first.clear();
    expect(await second.getItem(OTHER_KEY)).toBe("second");
    expect(await second.getItem(KEY)).toBe("first");
  });
});
