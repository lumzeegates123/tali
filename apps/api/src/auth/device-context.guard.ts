import { type CanActivate, type ExecutionContext, Inject, Injectable } from "@nestjs/common";
import { ApplicationError } from "@tali/application";
import type { ApiServices } from "../composition/api-services.js";
import { API_SERVICES, LOGGER } from "../composition/tokens.js";
import { RequestPipelineError, type TaliRequest } from "../http/request-context.js";
import type { Logger } from "../observability/logger.js";

/**
 * Header values as the verifier sees them: absent stays absent, a repeated
 * header (an array) becomes an unparseable value, so it is refused rather
 * than silently picking one of the values.
 */
function headerValue(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : "";
}

/**
 * Optional device verification on business-scoped routes (ADR-005 section
 * 15.3; plan 003 section 5 step 8). Runs after AuthenticationGuard and
 * BusinessContextGuard: the user is already authenticated and authorized for
 * the route's business, and a device never replaces that. Without
 * `X-Tali-Device-Id` and `X-Tali-Device-Credential` the context is unchanged.
 * With either header, the device must be ACTIVE in that same business and
 * the credential must match, or the request fails closed with
 * DEVICE_NOT_TRUSTED; it is never downgraded to a request without a device.
 * Header values are never logged.
 */
@Injectable()
export class DeviceContextGuard implements CanActivate {
  readonly #services: ApiServices;
  readonly #logger: Logger;

  constructor(@Inject(API_SERVICES) services: ApiServices, @Inject(LOGGER) logger: Logger) {
    this.#services = services;
    this.#logger = logger;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<TaliRequest>();
    const business = request.businessContext;
    if (business === undefined) throw new RequestPipelineError("a business context");
    const presented = {
      deviceId: headerValue(request.headers["x-tali-device-id"]),
      credential: headerValue(request.headers["x-tali-device-credential"]),
    };
    request.businessContext = await this.#services.deviceVerifier
      .verify(business, presented)
      .catch((error: unknown) => {
        if (error instanceof ApplicationError && error.code === "DEVICE_NOT_TRUSTED") {
          const userId = business.actor.type === "user" ? business.actor.userId : undefined;
          this.#logger.info("device.not_trusted", { businessId: business.businessId, userId });
        }
        throw error;
      });
    return true;
  }
}
