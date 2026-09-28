import { ConfigurationError, loadServerConfig } from "@tali/config/server";
import { createWorkerContext } from "./bootstrap.js";
import { createWorkerRuntime, publishSmokeMessage } from "./composition/worker-runtime.js";

/**
 * Worker process entry point: validate config (fail fast), compose, start the
 * message loop, and shut down gracefully on SIGTERM/SIGINT.
 *
 * Shutdown closes the Nest context, whose hooks stop intake, wait for the
 * message in flight and report stopped. The process then exits 0 because
 * nothing keeps the event loop alive; the signal is not re-raised. A shutdown
 * that exceeds the grace period, or fails, exits 1.
 */
async function main(): Promise<void> {
  const config = loadServerConfig(process.env);
  const runtime = createWorkerRuntime(config);
  const context = await createWorkerContext(runtime);

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    runtime.logger.info("shutdown requested", { signal });
    const forced = setTimeout(() => {
      runtime.logger.error("shutdown grace period exceeded; exiting", {
        gracePeriodMs: config.lifecycle.shutdownGracePeriodMs,
      });
      process.exit(1);
    }, config.lifecycle.shutdownGracePeriodMs);
    forced.unref();
    try {
      await context.close();
      runtime.logger.info("shutdown complete");
    } catch (error) {
      runtime.logger.error("shutdown failed", { error });
      process.exit(1);
    }
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));

  if (config.worker.smokeOnStart) {
    const id = await publishSmokeMessage(runtime);
    runtime.logger.info("smoke message published", { messageId: id });
  }
}

main().catch((error: unknown) => {
  // Configuration errors list keys and problems only, never values.
  const message = error instanceof ConfigurationError ? error.message : "worker failed to start";
  process.stderr.write(
    `${JSON.stringify({ time: new Date().toISOString(), level: "fatal", service: "tali-worker", msg: message, error: error instanceof ConfigurationError ? undefined : String(error) })}\n`,
  );
  process.exit(1);
});
