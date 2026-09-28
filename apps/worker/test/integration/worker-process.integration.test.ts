import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const main = fileURLToPath(new URL("../../dist/main.js", import.meta.url));
const SECRET = "p4ss-that-must-not-leak";

const BASE_ENV = {
  TALI_ENV: "test",
  DATABASE_URL: "postgresql://unused@127.0.0.1:1/unused_test",
  IDENTITY_PROVIDER: "fake",
  OBJECT_STORAGE_PROVIDER: "memory",
  QUEUE_PROVIDER: "memory",
  WORKER_POLL_INTERVAL_MS: "50",
  WORKER_HEARTBEAT_INTERVAL_MS: "200",
};

function spawnWorker(env: Record<string, string>): {
  child: ChildProcess;
  output: () => { stdout: string; stderr: string };
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
} {
  const child = spawn(process.execPath, ["--enable-source-maps", main], {
    env: { PATH: process.env["PATH"] ?? "", SystemRoot: process.env["SystemRoot"] ?? "", ...env },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });
  return { child, output: () => ({ stdout, stderr }), exited };
}

async function waitForOutput(read: () => string, pattern: RegExp, timeoutMs = 8_000): Promise<void> {
  const started = Date.now();
  while (!pattern.test(read())) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${pattern}:\n${read()}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("worker process", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "tali-worker-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("fails fast with exit code 1 on invalid configuration, never printing values", async () => {
    const worker = spawnWorker({ ...BASE_ENV, DATABASE_URL: `mysql://x:${SECRET}@h/d`, WORKER_POLL_INTERVAL_MS: "0" });
    const { code } = await worker.exited;
    const { stdout, stderr } = worker.output();
    expect(code).toBe(1);
    expect(stderr).toMatch(/DATABASE_URL/);
    expect(stderr).toMatch(/WORKER_POLL_INTERVAL_MS/);
    expect(stdout + stderr).not.toContain(SECRET);
  });

  it("refuses the smoke-on-start flag outside local/test", async () => {
    const worker = spawnWorker({
      ...BASE_ENV,
      TALI_ENV: "production",
      IDENTITY_PROVIDER: "cognito",
      COGNITO_REGION: "eu-west-1",
      COGNITO_USER_POOL_ID: "eu-west-1_Example123",
      COGNITO_CLIENT_IDS: "exampleclientid",
      OBJECT_STORAGE_PROVIDER: "s3",
      S3_REGION: "eu-west-1",
      S3_BUCKET: "tali-example-bucket",
      QUEUE_PROVIDER: "sqs",
      SQS_REGION: "eu-west-1",
      SQS_QUEUE_URL: "https://sqs.eu-west-1.amazonaws.com/000000000000/tali-example",
      WORKER_SMOKE_ON_START: "true",
    });
    const { code } = await worker.exited;
    expect(code).toBe(1);
    expect(worker.output().stderr).toMatch(/WORKER_SMOKE_ON_START/);
  });

  it("starts without an HTTP server, processes its smoke message, and heartbeats ready", async () => {
    const heartbeatFile = join(dir, "heartbeat.json");
    const worker = spawnWorker({ ...BASE_ENV, WORKER_SMOKE_ON_START: "true", WORKER_HEARTBEAT_FILE: heartbeatFile });
    try {
      await waitForOutput(() => worker.output().stdout, /"msg":"smoke check completed"/);
      const record = JSON.parse(await readFile(heartbeatFile, "utf8")) as { state: string; pid: number };
      expect(record.state).toBe("ready");
      expect(record.pid).toBe(worker.child.pid);
      expect(worker.output().stdout).not.toMatch(/listening|Mapped \{/);
      expect(worker.output().stderr).toBe("");
    } finally {
      worker.child.kill();
      await worker.exited;
    }
  }, 20_000);

  // Windows cannot deliver SIGTERM to a child process (kill() terminates it
  // outright), so graceful shutdown on a real signal is verified on Linux (CI).
  it.skipIf(process.platform === "win32")(
    "shuts down gracefully on SIGTERM and exits 0 without re-raising the signal",
    async () => {
      const heartbeatFile = join(dir, "heartbeat-sigterm.json");
      const worker = spawnWorker({ ...BASE_ENV, WORKER_SMOKE_ON_START: "true", WORKER_HEARTBEAT_FILE: heartbeatFile });
      await waitForOutput(() => worker.output().stdout, /"msg":"smoke check completed"/);
      worker.child.kill("SIGTERM");
      const exit = await worker.exited;
      const { stdout, stderr } = worker.output();

      expect(exit).toEqual({ code: 0, signal: null });
      expect(stderr).toBe("");

      const entries = stdout
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line) as { msg: string; signal?: string });
      const LIFECYCLE = [
        "worker ready",
        "smoke check completed",
        "shutdown requested",
        "worker stopping",
        "worker stopped",
        "shutdown complete",
      ];
      expect(entries.map((entry) => entry.msg).filter((msg) => LIFECYCLE.includes(msg))).toEqual(LIFECYCLE);
      expect(entries).toContainEqual(expect.objectContaining({ msg: "shutdown requested", signal: "SIGTERM" }));
      const stoppingAt = entries.findIndex((entry) => entry.msg === "worker stopping");
      const handledAfterStop = entries
        .slice(stoppingAt)
        .filter((entry) => entry.msg === "smoke check completed" || entry.msg.startsWith("message handling failed"));
      expect(handledAfterStop).toEqual([]);

      const record = JSON.parse(await readFile(heartbeatFile, "utf8")) as { state: string; processed: number };
      expect(record).toMatchObject({ state: "stopped", processed: 1 });
    },
    20_000,
  );
});
