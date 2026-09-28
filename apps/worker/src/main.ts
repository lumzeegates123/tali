import { ConfigurationError, loadServerConfig } from "@tali/config/server";
import { createWorkerContext } from "./bootstrap.js";
import { createWorkerRuntime, publishSmokeMessage } from "./composition/worker-runtime.js";

/**
 * Worker process entry point: validate config (fail fast), compose, start the
 * message loop, and shut down gracefully on SIGTERM/SIGINT (Nest shutdown
 * hooks: stop polling, finish in-flight work, report stopped).
 */
async function main(): Promise<void> {
  const config = loadServerConfig(process.env);
  const runtime = createWorkerRuntime(config);
  const context = await createWorkerContext(runtime);

  const forceExit = () => {
    const timer = setTimeout(() => {
      runtime.logger.error("shutdown grace period exceeded; exiting", {
        gracePeriodMs: config.lifecycle.shutdownGracePeriodMs,
      });
      process.exit(1);
    }, config.lifecycle.shutdownGracePeriodMs);
    timer.unref();
  };
  process.once("SIGTERM", forceExit);
  process.once("SIGINT", forceExit);
  context.enableShutdownHooks(["SIGTERM", "SIGINT"]);

  await context.init();
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
