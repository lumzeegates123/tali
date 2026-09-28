import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import type { ApiRuntime } from "../composition/api-runtime.js";
import { API_RUNTIME } from "../composition/tokens.js";

/**
 * Releases process resources (the PostgreSQL pool) from Nest's shutdown hook.
 * Nest runs onApplicationShutdown after the HTTP server has stopped accepting
 * connections, so no request can reach a closed pool.
 */
@Injectable()
export class RuntimeShutdown implements OnApplicationShutdown {
  constructor(@Inject(API_RUNTIME) private readonly runtime: ApiRuntime) {}

  async onApplicationShutdown(): Promise<void> {
    await this.runtime.close();
    this.runtime.logger.info("database disconnected");
  }
}
