import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkHeartbeat } from "./check-heartbeat.js";
import { Heartbeat, type HeartbeatRecord } from "./heartbeat.js";

describe("Heartbeat", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tali-heartbeat-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes state transitions and counters to the file", async () => {
    const file = join(dir, "nested", "heartbeat.json");
    const heartbeat = new Heartbeat({ file, intervalMs: 1_000 });
    await heartbeat.transition("ready");
    heartbeat.recordProcessed();
    await heartbeat.beat();
    const record = JSON.parse(await readFile(file, "utf8")) as HeartbeatRecord;
    expect(record).toMatchObject({ state: "ready", pid: process.pid, processed: 1, failed: 0 });
    await heartbeat.transition("stopped");
    expect((JSON.parse(await readFile(file, "utf8")) as HeartbeatRecord).state).toBe("stopped");
  });

  it("the healthcheck passes only for a fresh ready heartbeat", async () => {
    const file = join(dir, "heartbeat.json");
    expect(await checkHeartbeat(file, 1_000, Date.now())).toMatch(/missing/);
    const heartbeat = new Heartbeat({ file, intervalMs: 1_000 });
    await heartbeat.transition("starting");
    expect(await checkHeartbeat(file, 1_000, Date.now())).toMatch(/starting/);
    await heartbeat.transition("ready");
    expect(await checkHeartbeat(file, 1_000, Date.now())).toBeUndefined();
    expect(await checkHeartbeat(file, 1_000, Date.now() + 10_000)).toMatch(/stale/);
    await heartbeat.transition("stopping");
    expect(await checkHeartbeat(file, 1_000, Date.now())).toMatch(/stopping/);
  });

  it("tracks state in memory when no file is configured", async () => {
    const heartbeat = new Heartbeat({ file: undefined, intervalMs: 1_000 });
    await heartbeat.transition("ready");
    expect(heartbeat.state).toBe("ready");
  });
});
