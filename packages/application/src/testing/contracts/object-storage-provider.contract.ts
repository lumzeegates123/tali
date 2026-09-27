import { describe, expect, it } from "vitest";
import type { ObjectKey, ObjectStorageProvider } from "../../ports/object-storage-provider";

export interface ObjectStorageContractSetup {
  readonly storage: ObjectStorageProvider;
  readonly now: () => Date;
}

const key = (value: string): ObjectKey => value as ObjectKey;

/** Behaviour every ObjectStorageProvider adapter must satisfy. */
export function describeObjectStorageProviderContract(
  name: string,
  setup: () => Promise<ObjectStorageContractSetup>,
): void {
  describe(`ObjectStorageProvider contract: ${name}`, () => {
    it("stores and returns exact bytes and metadata", async () => {
      const { storage } = await setup();
      const body = Uint8Array.from([0, 1, 2, 250, 255]);
      await storage.putObject({ key: key("contract/a.bin"), contentType: "application/octet-stream", body });
      expect(await storage.getObject(key("contract/a.bin"))).toEqual(body);
      expect(await storage.getObjectInfo(key("contract/a.bin"))).toEqual({
        key: "contract/a.bin",
        byteSize: 5,
        contentType: "application/octet-stream",
      });
    });

    it("returns null for a missing object", async () => {
      const { storage } = await setup();
      expect(await storage.getObject(key("contract/missing"))).toBeNull();
      expect(await storage.getObjectInfo(key("contract/missing"))).toBeNull();
    });

    it("is not affected by callers mutating buffers", async () => {
      const { storage } = await setup();
      const body = Uint8Array.from([1, 2, 3]);
      await storage.putObject({ key: key("contract/b.bin"), contentType: "application/octet-stream", body });
      body[0] = 9;
      const read = await storage.getObject(key("contract/b.bin"));
      if (read !== null) read[1] = 9;
      expect(await storage.getObject(key("contract/b.bin"))).toEqual(Uint8Array.from([1, 2, 3]));
    });

    it("issues short-lived upload targets and download URLs", async () => {
      const { storage, now } = await setup();
      const upload = await storage.createUploadTarget({
        key: key("contract/c.jpg"),
        contentType: "image/jpeg",
        maxBytes: 1024,
        expiresInSeconds: 300,
      });
      expect(upload.url.length).toBeGreaterThan(0);
      expect(upload.expiresAt.getTime() - now().getTime()).toBeLessThanOrEqual(300_000);
      expect(upload.expiresAt.getTime()).toBeGreaterThan(now().getTime());

      const download = await storage.createDownloadUrl({ key: key("contract/c.jpg"), expiresInSeconds: 60 });
      expect(download.expiresAt.getTime() - now().getTime()).toBeLessThanOrEqual(60_000);
    });

    it("rejects unsafe keys and excessive URL lifetimes", async () => {
      const { storage } = await setup();
      await expect(storage.getObject(key("../escape"))).rejects.toThrow();
      await expect(storage.getObject(key("/absolute"))).rejects.toThrow();
      await expect(storage.createDownloadUrl({ key: key("contract/d"), expiresInSeconds: 86_400 })).rejects.toThrow();
    });
  });
}
