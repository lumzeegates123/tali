import { CryptoDigestAlgorithm, digestStringAsync } from "expo-crypto";
import * as SecureStore from "expo-secure-store";

/*
 * The Cognito session store of ADR-007 sections 5 and 6: Amplify's public
 * KeyValueStorageInterface backed by Expo SecureStore. Every key and value is
 * opaque here. Nothing in this module knows or matches Amplify's key names or
 * what a value contains; it stores whatever Amplify hands it and returns it
 * exactly, or returns nothing.
 *
 * Format (Tali-owned, version 1), all under the `tali.cognito.v1.` namespace.
 * Every item name the format can ever use is known in advance, so the whole
 * namespace can be cleared without the index and without listing SecureStore:
 * - `index`: one record per entry: its storage identifier (the first 128 bits
 *   of SHA-256 over the whole Amplify key, in hex: content-blind, fixed length,
 *   and keeps key text, which may contain a username, out of item names), the
 *   slot it occupies, its committed generation and chunk count, and at most one
 *   pending write;
 * - `m.<slot>`: the manifest `{ v, i, g, n, b }`: format version, storage
 *   identifier, generation, chunk count, total UTF-8 byte length. Metadata only;
 * - `c.<slot>.<g>.<i>`: chunk `i` of generation `g` (0 or 1, alternating on
 *   each replacement), at most MAX_CHUNK_BYTES of UTF-8, never splitting a
 *   character.
 * There are MAX_ENTRIES slots of 2 x MAX_CHUNKS chunks each. Anything
 * inconsistent (unknown version, missing, extra or malformed chunk, wrong
 * length, unreadable index or manifest) clears the namespace and reads as
 * absent: a partial session is never returned.
 *
 * Each signed-in session reaches the store only through its own lease. Once a
 * lease is frozen it can no longer write; once revoked (or replaced by a newer
 * lease) it reads nothing and writes nothing. The check runs when the queued
 * operation executes, so an operation of an ended session can never reach a
 * later session's entries, however late it completes.
 */

/** The part of expo-secure-store this module uses, so tests can substitute it. */
export interface SecureStoreModule {
  getItemAsync(key: string, options?: SecureStore.SecureStoreOptions): Promise<string | null>;
  setItemAsync(key: string, value: string, options?: SecureStore.SecureStoreOptions): Promise<void>;
  deleteItemAsync(key: string, options?: SecureStore.SecureStoreOptions): Promise<void>;
}

/** The shape of Amplify's KeyValueStorageInterface, without importing Amplify here. */
export interface CognitoKeyValueStorage {
  setItem(key: string, value: string): Promise<void>;
  getItem(key: string): Promise<string | null>;
  removeItem(key: string): Promise<void>;
  clear(): Promise<void>;
}

/** The store as one session sees it. */
export interface CognitoStorageLease extends CognitoKeyValueStorage {
  /** From now on the session may read what it stored but write nothing. */
  freeze(): void;
  /** From now on the session reads nothing and writes nothing. */
  revoke(): void;
}

export interface SecureCognitoStorage extends CognitoKeyValueStorage {
  /** True when the namespace holds no entry (an unreadable index counts as not empty). */
  isEmpty(): Promise<boolean>;
  /** A new session's view of the store. Revokes every earlier lease. */
  lease(): CognitoStorageLease;
}

export const COGNITO_NAMESPACE = "tali.cognito.v1.";
export const COGNITO_STORAGE_FORMAT = 1;
/**
 * Well under the roughly 2 KiB at which some iOS versions rejected SecureStore
 * values, leaving room for the platform's own encoding overhead.
 */
export const MAX_CHUNK_BYTES = 1024;
/** 16 KiB per entry; several times the largest Cognito token. */
export const MAX_CHUNKS = 16;
/** Amplify's Cognito user-pool session uses six to ten entries; the index must also fit one chunk. */
export const MAX_ENTRIES = 12;

/** iOS: readable only while unlocked, never migrated to another device or backup. Ignored on Android. */
export const COGNITO_SECURE_STORE_OPTIONS: SecureStore.SecureStoreOptions = Object.freeze({
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
});

const INDEX_KEY = `${COGNITO_NAMESPACE}index`;
const ID = /^[0-9a-f]{32}$/u;
const GENERATIONS = [0, 1] as const;
const SLOTS = Array.from({ length: MAX_ENTRIES }, (_, slot) => slot);

const manifestKey = (slot: number) => `${COGNITO_NAMESPACE}m.${String(slot)}`;
const chunkKey = (slot: number, g: number, i: number) =>
  `${COGNITO_NAMESPACE}c.${String(slot)}.${String(g)}.${String(i)}`;

/** Every item name the format can use: chunks, then manifests, then the index. */
export const COGNITO_ITEM_NAMES: readonly string[] = Object.freeze([
  ...SLOTS.flatMap((slot) =>
    GENERATIONS.flatMap((g) => Array.from({ length: MAX_CHUNKS }, (_, i) => chunkKey(slot, g, i))),
  ),
  ...SLOTS.map(manifestKey),
  INDEX_KEY,
]);

/** Raised to Amplify for values this store refuses to keep. Carries no key or value. */
export class CognitoStorageError extends Error {
  constructor(reason: string) {
    super(`Cognito session storage refused the value: ${reason}`);
    this.name = "CognitoStorageError";
  }
}

interface Generation {
  readonly g: number;
  readonly n: number;
}

interface Manifest extends Generation {
  readonly v: typeof COGNITO_STORAGE_FORMAT;
  readonly i: string;
  readonly b: number;
}

interface IndexEntry {
  readonly id: string;
  readonly slot: number;
  /** The committed generation, as the manifest should also say. */
  readonly live?: Generation;
  /** A write in progress, always into the generation `live` does not use. */
  readonly pending?: Generation;
}

function isCount(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

function isGeneration(g: unknown, n: unknown): boolean {
  return (g === 0 || g === 1) && isCount(n, 0, MAX_CHUNKS);
}

/** `[g, n]` in the index. */
function parsePair(value: unknown): Generation | undefined | "corrupt" {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length !== 2) return "corrupt";
  const [g, n] = value as unknown[];
  return isGeneration(g, n) ? { g: g as number, n: n as number } : "corrupt";
}

function parseManifest(raw: string | null): Manifest | undefined {
  if (raw === null) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return undefined;
    const { v, i, g, n, b } = value as Record<string, unknown>;
    if (v !== COGNITO_STORAGE_FORMAT || typeof i !== "string" || !ID.test(i) || !isGeneration(g, n)) return undefined;
    if (!isCount(b, 0, MAX_CHUNKS * MAX_CHUNK_BYTES) || (n === 0) !== (b === 0)) return undefined;
    return value as Manifest;
  } catch {
    return undefined;
  }
}

function parseIndex(raw: string | null): IndexEntry[] | "corrupt" {
  if (raw === null) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return "corrupt";
    const { v, e } = value as Record<string, unknown>;
    if (v !== COGNITO_STORAGE_FORMAT || !Array.isArray(e) || e.length > MAX_ENTRIES) return "corrupt";
    const ids = new Set<string>();
    const slots = new Set<number>();
    const parsed: IndexEntry[] = [];
    for (const record of e as unknown[]) {
      if (typeof record !== "object" || record === null) return "corrupt";
      const { i: id, s: slot, l, p } = record as Record<string, unknown>;
      if (typeof id !== "string" || !ID.test(id) || ids.has(id)) return "corrupt";
      if (!isCount(slot, 0, MAX_ENTRIES - 1) || slots.has(slot)) return "corrupt";
      const live = parsePair(l);
      const pending = parsePair(p);
      if (live === "corrupt" || pending === "corrupt") return "corrupt";
      if (live === undefined && pending === undefined) return "corrupt";
      if (live !== undefined && pending !== undefined && live.g === pending.g) return "corrupt";
      ids.add(id);
      slots.add(slot);
      parsed.push({ id, slot, ...(live === undefined ? {} : { live }), ...(pending === undefined ? {} : { pending }) });
    }
    return parsed;
  } catch {
    return "corrupt";
  }
}

function serializeIndex(entries: readonly IndexEntry[]): string {
  return JSON.stringify({
    v: COGNITO_STORAGE_FORMAT,
    e: entries.map(({ id, slot, live, pending }) => ({
      i: id,
      s: slot,
      ...(live === undefined ? {} : { l: [live.g, live.n] }),
      ...(pending === undefined ? {} : { p: [pending.g, pending.n] }),
    })),
  });
}

/** UTF-8 byte length of one code point; a lone surrogate cannot be stored exactly and is refused. */
function utf8Bytes(codePoint: number): number {
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) throw new CognitoStorageError("not well-formed text");
  return codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
}

/** Splits text into chunks of at most `limit` UTF-8 bytes on code-point boundaries. */
export function splitUtf8(value: string, limit: number = MAX_CHUNK_BYTES): { chunks: string[]; bytes: number } {
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  let bytes = 0;
  for (const character of value) {
    const size = utf8Bytes(character.codePointAt(0) ?? 0);
    if (currentBytes + size > limit) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += character;
    currentBytes += size;
    bytes += size;
  }
  if (current !== "") chunks.push(current);
  return { chunks, bytes };
}

/** UTF-8 length of a stored chunk, or undefined when it is not well-formed. */
function chunkBytes(chunk: string): number | undefined {
  try {
    return splitUtf8(chunk, Number.MAX_SAFE_INTEGER).bytes;
  } catch {
    return undefined;
  }
}

/** A store that keeps nothing: what the process-wide Amplify token provider is given. */
export function inertCognitoStorage(): CognitoKeyValueStorage {
  return {
    getItem: () => Promise.resolve(null),
    setItem: () => Promise.resolve(),
    removeItem: () => Promise.resolve(),
    clear: () => Promise.resolve(),
  };
}

export interface SecureCognitoStorageOptions {
  readonly secureStore?: SecureStoreModule;
  /** SHA-256 of a string, lowercase hex. */
  readonly sha256Hex?: (value: string) => Promise<string>;
}

const expoSha256Hex = (value: string) => digestStringAsync(CryptoDigestAlgorithm.SHA256, value);

export function createSecureCognitoStorage(options: SecureCognitoStorageOptions = {}): SecureCognitoStorage {
  const store = options.secureStore ?? SecureStore;
  const sha256Hex = options.sha256Hex ?? expoSha256Hex;
  let tail: Promise<unknown> = Promise.resolve();
  let revokeCurrentLease: (() => void) | undefined;

  /** One operation at a time, in call order: the index is read-modify-write. */
  function serialized<T>(task: () => Promise<T>): Promise<T> {
    const result = tail.then(task);
    tail = result.catch(() => undefined);
    return result;
  }

  const get = (key: string) => store.getItemAsync(key, COGNITO_SECURE_STORE_OPTIONS);
  const set = (key: string, value: string) => store.setItemAsync(key, value, COGNITO_SECURE_STORE_OPTIONS);
  const remove = (key: string) => store.deleteItemAsync(key, COGNITO_SECURE_STORE_OPTIONS);

  async function storageId(key: string): Promise<string> {
    const digest = (await sha256Hex(`${COGNITO_NAMESPACE}${key}`)).toLowerCase();
    if (!/^[0-9a-f]{64}$/u.test(digest)) throw new CognitoStorageError("digest unavailable");
    return digest.slice(0, 32);
  }

  async function writeIndex(entries: readonly IndexEntry[]): Promise<void> {
    if (entries.length === 0) {
      await remove(INDEX_KEY);
      return;
    }
    const raw = serializeIndex(entries);
    if (splitUtf8(raw).chunks.length > 1) throw new CognitoStorageError("too many entries");
    await set(INDEX_KEY, raw);
  }

  /** Removes chunks 0..n of one generation; chunk n is the "extra chunk" a read checks for. */
  async function removeGeneration(slot: number, generation: Generation): Promise<void> {
    const last = Math.min(generation.n, MAX_CHUNKS - 1);
    for (let i = 0; i <= last; i += 1) await remove(chunkKey(slot, generation.g, i));
  }

  /** Removes every item the format can use, independently of the index; the index goes last. */
  async function sweep(): Promise<void> {
    const names = COGNITO_ITEM_NAMES.filter((name) => name !== INDEX_KEY);
    const results = await Promise.allSettled(names.map(async (name) => remove(name)));
    if (results.some((result) => result.status === "rejected")) throw new CognitoStorageError("clear incomplete");
    await remove(INDEX_KEY);
  }

  /** Index absent and no manifest left behind. */
  async function empty(): Promise<boolean> {
    if ((await get(INDEX_KEY)) !== null) return false;
    const manifests = await Promise.all(SLOTS.map((slot) => get(manifestKey(slot))));
    return manifests.every((raw) => raw === null);
  }

  /** The index, after sweeping the namespace when it is unreadable. */
  async function readIndex(): Promise<IndexEntry[]> {
    const entries = parseIndex(await get(INDEX_KEY));
    if (entries !== "corrupt") return entries;
    await sweep();
    return [];
  }

  /**
   * Finishes or rolls back an interrupted write. If the manifest already names
   * the pending generation, the switch happened and the previous generation is
   * removed; otherwise the pending chunks are removed and the committed
   * generation stays authoritative. Returns the entries with this one settled.
   */
  async function settlePending(entries: IndexEntry[], entry: IndexEntry): Promise<IndexEntry[]> {
    const { pending, live, slot, id } = entry;
    if (pending === undefined) return entries;
    const manifest = parseManifest(await get(manifestKey(slot)));
    const names = (generation: Generation | undefined) =>
      generation !== undefined && manifest?.i === id && manifest.g === generation.g && manifest.n === generation.n;
    let committed: Generation | undefined;
    if (names(pending)) {
      if (live !== undefined) await removeGeneration(slot, live);
      committed = pending;
    } else {
      await removeGeneration(slot, pending);
      if (names(live)) {
        committed = live;
      } else {
        if (live !== undefined) await removeGeneration(slot, live);
        await remove(manifestKey(slot));
      }
    }
    const others = entries.filter((item) => item.id !== id);
    const settled = committed === undefined ? others : [...others, { id, slot, live: committed }];
    await writeIndex(settled);
    return settled;
  }

  async function getItem(key: string): Promise<string | null> {
    const id = await storageId(key);
    let entries = await readIndex();
    let entry = entries.find((item) => item.id === id);
    if (entry?.pending !== undefined) {
      entries = await settlePending(entries, entry);
      entry = entries.find((item) => item.id === id);
    }
    if (entry?.live === undefined) return null;
    const { slot, live } = entry;
    const manifest = parseManifest(await get(manifestKey(slot)));
    if (manifest?.i !== id || manifest.g !== live.g || manifest.n !== live.n) {
      await sweep();
      return null;
    }
    let value = "";
    let bytes = 0;
    for (let i = 0; i < manifest.n; i += 1) {
      const chunk = await get(chunkKey(slot, manifest.g, i));
      const size = chunk === null ? undefined : chunkBytes(chunk);
      if (chunk === null || size === undefined || size === 0 || size > MAX_CHUNK_BYTES) {
        await sweep();
        return null;
      }
      value += chunk;
      bytes += size;
    }
    const extra = manifest.n < MAX_CHUNKS ? await get(chunkKey(slot, manifest.g, manifest.n)) : null;
    if (bytes !== manifest.b || extra !== null) {
      await sweep();
      return null;
    }
    return value;
  }

  async function setItem(key: string, value: string): Promise<void> {
    const { chunks, bytes } = splitUtf8(value);
    if (chunks.length > MAX_CHUNKS) throw new CognitoStorageError("value too large");
    const id = await storageId(key);
    // A namespace whose index was lost is cleared before it is written again.
    if ((await get(INDEX_KEY)) === null && !(await empty())) await sweep();
    let entries = await readIndex();
    let entry = entries.find((item) => item.id === id);
    if (entry?.pending !== undefined) {
      entries = await settlePending(entries, entry);
      entry = entries.find((item) => item.id === id);
    }
    let slot = entry?.slot;
    if (slot === undefined) {
      const used = new Set(entries.map((item) => item.slot));
      slot = SLOTS.find((candidate) => !used.has(candidate));
      if (slot === undefined) throw new CognitoStorageError("too many entries");
    }
    const previous = entry?.live;
    const next: Manifest = {
      v: COGNITO_STORAGE_FORMAT,
      i: id,
      g: previous?.g === 0 ? 1 : 0,
      n: chunks.length,
      b: bytes,
    };
    const others = entries.filter((item) => item.id !== id);
    // 1. record the write, 2. new chunks, 3. switch the manifest, 4. drop the old generation, 5. settle the index.
    await writeIndex([
      ...others,
      { id, slot, ...(previous === undefined ? {} : { live: previous }), pending: { g: next.g, n: next.n } },
    ]);
    for (let i = 0; i < chunks.length; i += 1) await set(chunkKey(slot, next.g, i), chunks[i] ?? "");
    if (chunks.length < MAX_CHUNKS) await remove(chunkKey(slot, next.g, chunks.length));
    await set(manifestKey(slot), JSON.stringify(next));
    if (previous !== undefined) await removeGeneration(slot, previous);
    await writeIndex([...others, { id, slot, live: { g: next.g, n: next.n } }]);
  }

  async function removeItem(key: string): Promise<void> {
    const id = await storageId(key);
    const entries = await readIndex();
    const entry = entries.find((item) => item.id === id);
    if (entry === undefined) return;
    if (entry.pending !== undefined) await removeGeneration(entry.slot, entry.pending);
    if (entry.live !== undefined) await removeGeneration(entry.slot, entry.live);
    await remove(manifestKey(entry.slot));
    await writeIndex(entries.filter((item) => item.id !== id));
  }

  function lease(): CognitoStorageLease {
    revokeCurrentLease?.();
    let state: "active" | "frozen" | "revoked" = "active";
    const revoke = () => {
      state = "revoked";
    };
    revokeCurrentLease = revoke;
    const write =
      <A extends unknown[]>(task: (...args: A) => Promise<void>) =>
      (...args: A) =>
        serialized(() => (state === "active" ? task(...args) : Promise.resolve()));
    return {
      getItem: (key) => serialized(() => (state === "revoked" ? Promise.resolve(null) : getItem(key))),
      setItem: write(setItem),
      removeItem: write(removeItem),
      clear: write(sweep),
      freeze: () => {
        if (state === "active") state = "frozen";
      },
      revoke,
    };
  }

  return {
    getItem: (key) => serialized(() => getItem(key)),
    setItem: (key, value) => serialized(() => setItem(key, value)),
    removeItem: (key) => serialized(() => removeItem(key)),
    clear: () => serialized(sweep),
    isEmpty: () => serialized(empty),
    lease,
  };
}
