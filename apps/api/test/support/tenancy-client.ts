import { randomUUID } from "node:crypto";
import { CreateBusinessResponseSchema, CurrentUserResponseSchema, type CreateBusinessResponse } from "@tali/shared";
import request from "supertest";
import { expect } from "vitest";
import type { ApiHarness } from "./api-harness.js";

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Typed asymmetric matchers (Vitest types them as `any`). */
export const matches = (pattern: RegExp): string => expect.stringMatching(pattern) as string;
export const anyUuid = (): string => matches(UUID);
export const anyString = (): string => expect.any(String) as string;

export interface RegisteredActor {
  readonly subject: string;
  readonly token: string;
  readonly userId: string;
}

/** Issues a fake-provider token for a synthetic subject and registers it through the API. */
export async function registerActor(api: ApiHarness, subject: string, displayName: string): Promise<RegisteredActor> {
  const token = api.identity.issueToken(subject);
  const response = await request(api.app.getHttpServer())
    .post("/v1/me/registration")
    .set(bearer(token))
    .send({ displayName })
    .expect(201);
  return { subject, token, userId: CurrentUserResponseSchema.parse(response.body).id };
}

export async function createBusinessAs(
  api: ApiHarness,
  actor: RegisteredActor,
  body: { name: string; currencyCode?: string; timeZone?: string },
  idempotencyKey: string = randomUUID(),
): Promise<CreateBusinessResponse> {
  const response = await request(api.app.getHttpServer())
    .post("/v1/businesses")
    .set(bearer(actor.token))
    .set("idempotency-key", idempotencyKey)
    .send({ currencyCode: "KES", timeZone: "Africa/Nairobi", ...body })
    .expect(201);
  return CreateBusinessResponseSchema.parse(response.body);
}
