/**
 * Worker healthcheck: exits 0 when the heartbeat file reports `ready` and is
 * fresh (at most 3 heartbeat intervals old), 1 otherwise.
 *   node dist/health/check-heartbeat.js
 * Reads WORKER_HEARTBEAT_FILE and WORKER_HEARTBEAT_INTERVAL_MS.
 */
import { readFile } from "node:fs/promises";
import type { HeartbeatRecord } from "./heartbeat.js";

export async function checkHeartbeat(file: string, intervalMs: number, nowMs: number): Promise<string | undefined> {
  let record: HeartbeatRecord;
  try {
    record = JSON.parse(await readFile(file, "utf8")) as HeartbeatRecord;
  } catch {
    return "heartbeat file missing or unreadable";
  }
  if (record.state !== "ready") return `worker state is ${record.state}`;
  const ageMs = nowMs - Date.parse(record.updatedAt);
  if (!(ageMs <= intervalMs * 3)) return `heartbeat is stale (${ageMs} ms old)`;
  return undefined;
}

const isEntryPoint = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/"));
if (isEntryPoint) {
  const file = process.env["WORKER_HEARTBEAT_FILE"];
  const intervalMs = Number(process.env["WORKER_HEARTBEAT_INTERVAL_MS"] ?? "5000");
  if (file === undefined) {
    process.stderr.write("WORKER_HEARTBEAT_FILE is not set\n");
    process.exit(1);
  }
  const problem = await checkHeartbeat(file, intervalMs, Date.now());
  if (problem !== undefined) {
    process.stderr.write(`unhealthy: ${problem}\n`);
    process.exit(1);
  }
  process.stdout.write("healthy\n");
}
