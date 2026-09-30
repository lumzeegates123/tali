import { ConfigurationError, loadServerConfig } from "@tali/config/server";
import { createApiApplication } from "./bootstrap.js";
import { createApiRuntime } from "./composition/api-runtime.js";

/**
 * API process entry point: validate config (fail fast), compose, serve, and
 * shut down gracefully on SIGTERM/SIGINT.
 */
async function main(): Promise<void> {
  const config = loadServerConfig(process.env);
  const runtime = await createApiRuntime(config);
  const app = await createApiApplication(runtime);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
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
    // Stops the HTTP server, then runs Nest shutdown hooks (RuntimeShutdown closes the database pool).
    await app.close();
    runtime.logger.info("shutdown complete");
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));

  await app.listen(config.api.port);
  runtime.logger.info("api listening", { port: config.api.port, env: config.env });
}

main().catch((error: unknown) => {
  // Configuration errors list keys and problems only, never values.
  const message = error instanceof ConfigurationError ? error.message : "API failed to start";
  process.stderr.write(
    `${JSON.stringify({ time: new Date().toISOString(), level: "fatal", service: "tali-api", msg: message, error: error instanceof ConfigurationError ? undefined : String(error) })}\n`,
  );
  process.exit(1);
});
