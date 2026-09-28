import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { countDatabaseSessions } from "@tali/database/testing";
import { describe, expect, it } from "vitest";
import { TEST_ENV } from "../support/api-harness.js";

const main = fileURLToPath(new URL("../../dist/main.js", import.meta.url));
const SECRET = "p4ss-that-must-not-leak";

interface Exit {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the compiled API process with exactly the given environment. */
function runApi(env: Record<string, string>, stopAfterMs?: number): Promise<Exit> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--enable-source-maps", main], {
      env: { PATH: process.env["PATH"] ?? "", SystemRoot: process.env["SystemRoot"] ?? "", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const timer =
      stopAfterMs === undefined
        ? undefined
        : setTimeout(() => {
            child.kill();
          }, stopAfterMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

describe("API process startup", () => {
  it("fails fast with exit code 1 on invalid configuration, naming keys but never values", async () => {
    const result = await runApi({
      ...TEST_ENV,
      DATABASE_URL: `mysql://tali:${SECRET}@localhost/tali`,
      API_PORT: "not-a-port",
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/DATABASE_URL/);
    expect(result.stderr).toMatch(/API_PORT/);
    expect(result.stderr + result.stdout).not.toContain(SECRET);
    expect(result.stdout).not.toMatch(/listening/);
  });

  it("refuses a forbidden combination (fake identity in production) before serving", async () => {
    const result = await runApi({ ...TEST_ENV, TALI_ENV: "production" });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/IDENTITY_PROVIDER/);
  });

  it("fails loudly for an identity provider that is not implemented yet", async () => {
    const result = await runApi({ ...TEST_ENV, TALI_ENV: "local", IDENTITY_PROVIDER: "local" });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/API failed to start/);
    expect(result.stderr).toMatch(/not implemented yet/);
  });

  it("starts and listens with valid configuration", async () => {
    const result = await runApi({ ...TEST_ENV, API_PORT: "3917" }, 4_000);
    expect(result.stdout).toMatch(/"msg":"api listening"/);
    expect(result.stderr).toBe("");
  }, 15_000);
});

async function waitFor(condition: () => boolean | Promise<boolean>, what: string, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!(await condition())) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// Windows cannot deliver SIGTERM to a child process (kill() terminates it
// outright), so this runs on Linux (CI, or a Linux container locally).
describe.skipIf(process.platform === "win32")("API graceful shutdown on SIGTERM", () => {
  it("stops HTTP, runs Nest shutdown hooks, closes PostgreSQL connections and exits 0 with a clean stderr", async () => {
    const serviceName = "tali-shutdown-probe";
    const applicationName = `${serviceName}-api`;
    const port = "3918";
    const child = spawn(process.execPath, ["--enable-source-maps", main], {
      env: { PATH: process.env["PATH"] ?? "", ...TEST_ENV, SERVICE_NAME: serviceName, API_PORT: port },
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

    try {
      await waitFor(() => stdout.includes('"msg":"api listening"'), "api listening");
      const ready = await fetch(`http://127.0.0.1:${port}/health/ready`);
      expect(ready.status).toBe(200);
      await waitFor(async () => (await countDatabaseSessions(applicationName)) > 0, "an open database session");

      child.kill("SIGTERM");
      const exit = await exited;

      expect(exit).toEqual({ code: 0, signal: null });
      expect(stderr).toBe("");
      const lifecycle = stdout
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line) as { msg: string; signal?: string })
        .filter((entry) => ["shutdown requested", "database disconnected", "shutdown complete"].includes(entry.msg));
      expect(lifecycle).toEqual([
        expect.objectContaining({ msg: "shutdown requested", signal: "SIGTERM" }),
        expect.objectContaining({ msg: "database disconnected" }),
        expect.objectContaining({ msg: "shutdown complete" }),
      ]);
      await expect(fetch(`http://127.0.0.1:${port}/health/live`)).rejects.toThrow();
      await waitFor(
        async () => (await countDatabaseSessions(applicationName)) === 0,
        "database sessions to close",
        3_000,
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 30_000);
});
