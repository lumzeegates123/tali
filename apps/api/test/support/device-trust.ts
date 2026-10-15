import { randomUUID } from "node:crypto";
import { DEVICE_CREDENTIAL_HEADER, DEVICE_ID_HEADER, RegisterDeviceResponseSchema } from "@tali/shared";
import request from "supertest";
import type { ApiHarness } from "./api-harness.js";
import { bearer, type RegisteredActor } from "./tenancy-client.js";

export type DeviceHeaders = Readonly<Record<string, string>>;

/** Registers an ANDROID device for the business and returns its verified headers. */
export async function registerDevice(
  api: ApiHarness,
  owner: RegisteredActor,
  businessId: string,
  label = "Store counter",
): Promise<{ readonly id: string; readonly headers: DeviceHeaders }> {
  const response = await request(api.app.getHttpServer())
    .post(`/v1/businesses/${businessId}/devices`)
    .set(bearer(owner.token))
    .set("idempotency-key", randomUUID())
    .send({ platform: "ANDROID", label })
    .expect(201);
  const device = RegisterDeviceResponseSchema.parse(response.body);
  if (!device.credentialAvailable) throw new Error("expected the device credential");
  return {
    id: device.device.id,
    headers: { [DEVICE_ID_HEADER]: device.device.id, [DEVICE_CREDENTIAL_HEADER]: device.credential },
  };
}

/**
 * Every untrusted device-header case for business `businessId`: a wrong
 * credential, either header alone, a malformed ID, a revoked device with its
 * once-valid credential, and another business's valid device. Missing headers
 * pass by design (web sessions) and are not included.
 */
export async function untrustedDeviceCases(
  api: ApiHarness,
  owner: RegisteredActor,
  businessId: string,
  foreign: { readonly owner: RegisteredActor; readonly businessId: string },
): Promise<readonly (readonly [string, DeviceHeaders])[]> {
  const active = await registerDevice(api, owner, businessId, "Active counter");
  const revoked = await registerDevice(api, owner, businessId, "Lost phone");
  await request(api.app.getHttpServer())
    .post(`/v1/businesses/${businessId}/devices/${revoked.id}/revoke`)
    .set(bearer(owner.token))
    .send({})
    .expect(200);
  const elsewhere = await registerDevice(api, foreign.owner, foreign.businessId, "Other shop");
  const credential = active.headers[DEVICE_CREDENTIAL_HEADER] ?? "";
  return [
    ["wrong credential", { [DEVICE_ID_HEADER]: active.id, [DEVICE_CREDENTIAL_HEADER]: `tali_dev_${"Z".repeat(43)}` }],
    ["device ID only", { [DEVICE_ID_HEADER]: active.id }],
    ["credential only", { [DEVICE_CREDENTIAL_HEADER]: credential }],
    ["malformed device ID", { [DEVICE_ID_HEADER]: "not-a-uuid", [DEVICE_CREDENTIAL_HEADER]: credential }],
    ["revoked device", revoked.headers],
    ["another business's device", elsewhere.headers],
  ];
}
