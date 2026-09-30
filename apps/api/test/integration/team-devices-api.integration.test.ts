import { createHash, randomUUID } from "node:crypto";
import { readTenancySnapshot, resetTenancyTables, tenancyFixtures } from "@tali/database/testing";
import { uuidV7IdGenerator } from "@tali/integrations/platform";
import {
  AcceptInvitationResponseSchema,
  BusinessResponseSchema,
  CreateInvitationResponseSchema,
  DEVICE_CREDENTIAL_HEADER,
  DEVICE_ID_HEADER,
  DevicesResponseSchema,
  ErrorEnvelopeSchema,
  MemberChangeResponseSchema,
  type MembershipRoleWireSchema,
  MyBusinessesResponseSchema,
  RegisterDeviceResponseSchema,
} from "@tali/shared";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startApi, type ApiHarness } from "../support/api-harness.js";
import { bearer, createBusinessAs, registerActor, type RegisteredActor } from "../support/tenancy-client.js";

type MembershipRoleWire = (typeof MembershipRoleWireSchema.options)[number];

const code = (body: unknown) => ErrorEnvelopeSchema.parse(body).error.code;
const sha256Hex = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

describe("Slice 5 invitations, member management, rename and devices over HTTP", () => {
  let api: ApiHarness;
  const http = () => request(api.app.getHttpServer());

  beforeAll(async () => {
    api = await startApi();
  });
  afterAll(async () => {
    await api.close();
  });

  interface World {
    readonly owner: RegisteredActor;
    readonly other: RegisteredActor;
    readonly invitee: RegisteredActor;
    readonly businessA: string;
    readonly businessB: string;
  }
  let world: World;

  beforeEach(async () => {
    await resetTenancyTables();
    const owner = await registerActor(api, `owner-${randomUUID()}`, "Amani");
    const other = await registerActor(api, `other-${randomUUID()}`, "Baraka");
    const invitee = await registerActor(api, `invitee-${randomUUID()}`, "Chausiku");
    const businessA = (await createBusinessAs(api, owner, { name: "Business A" })).business.id;
    const businessB = (await createBusinessAs(api, other, { name: "Business B" })).business.id;
    world = { owner, other, invitee, businessA, businessB };
  });

  async function addMember(businessId: string, role: MembershipRoleWire, name: string) {
    const actor = await registerActor(api, `member-${randomUUID()}`, name);
    const membershipId = uuidV7IdGenerator.newId("membership");
    await tenancyFixtures.insertMembership({ id: membershipId, businessId, userId: actor.userId, role });
    return { actor, membershipId };
  }

  function invite(actor: RegisteredActor, businessId: string, role = "CASHIER", key = randomUUID()) {
    return http()
      .post(`/v1/businesses/${businessId}/invitations`)
      .set(bearer(actor.token))
      .set("idempotency-key", key)
      .send({ role });
  }

  function register(actor: RegisteredActor, businessId: string, key = randomUUID()) {
    return http()
      .post(`/v1/businesses/${businessId}/devices`)
      .set(bearer(actor.token))
      .set("idempotency-key", key)
      .send({ platform: "ANDROID", label: "Front counter" });
  }

  /** No plaintext secret may appear in any stored row or log line. */
  async function expectNowhere(secrets: readonly string[]) {
    const snapshot = JSON.stringify(await readTenancySnapshot());
    const logs = JSON.stringify(api.logs);
    for (const secret of secrets) {
      expect(snapshot).not.toContain(secret);
      expect(logs).not.toContain(secret);
    }
  }

  describe("invitations", () => {
    it("creates once with a no-store token, replays without it, and the invitee joins the business", async () => {
      const key = randomUUID();
      const created = await invite(world.owner, world.businessA, "MANAGER", key).expect(201);
      expect(created.headers["cache-control"]).toBe("no-store");
      expect(created.headers["idempotent-replayed"]).toBeUndefined();
      const first = CreateInvitationResponseSchema.parse(created.body);
      if (!first.tokenAvailable) throw new Error("expected the original response to carry the token");
      expect(first.token).toMatch(/^tali_inv_[A-Za-z0-9_-]{43}$/);
      expect(first.invitation).toMatchObject({ role: "MANAGER", status: "PENDING" });

      const replay = await invite(world.owner, world.businessA, "MANAGER", key).expect(201);
      expect(replay.headers["idempotent-replayed"]).toBe("true");
      expect(replay.headers["cache-control"]).toBe("no-store");
      expect(replay.body).toEqual({ invitation: first.invitation, tokenAvailable: false });

      const accepted = await http()
        .post("/v1/invitations/accept")
        .set(bearer(world.invitee.token))
        .send({ token: first.token })
        .expect(200);
      expect(accepted.headers["cache-control"]).toBe("no-store");
      const acceptance = AcceptInvitationResponseSchema.parse(accepted.body);
      expect(acceptance).toMatchObject({
        business: { id: world.businessA, name: "Business A" },
        membership: { role: "MANAGER", status: "ACTIVE" },
      });

      const again = await http()
        .post("/v1/invitations/accept")
        .set(bearer(world.invitee.token))
        .send({ token: first.token })
        .expect(200);
      expect(again.body).toEqual(accepted.body);

      const mine = MyBusinessesResponseSchema.parse(
        (await http().get("/v1/me/businesses").set(bearer(world.invitee.token)).expect(200)).body,
      );
      expect(mine.items.map((item) => [item.business.id, item.membership.role])).toEqual([
        [world.businessA, "MANAGER"],
      ]);

      const snapshot = await readTenancySnapshot();
      expect(snapshot.invitations).toEqual([
        expect.objectContaining({ id: first.invitation.id, status: "ACCEPTED", tokenHashHex: sha256Hex(first.token) }),
      ]);
      expect(
        snapshot.businessAudit
          .filter((entry) => entry.businessId === world.businessA)
          .map((entry) => entry.action)
          .filter((action) => action.startsWith("invitation.") || action === "membership.created"),
      ).toEqual(expect.arrayContaining(["invitation.created", "invitation.accepted", "membership.created"]));
      await expectNowhere([first.token]);
    });

    it("answers every unusable token with the same 404 and never echoes the token", async () => {
      const created = CreateInvitationResponseSchema.parse((await invite(world.owner, world.businessA)).body);
      if (!created.tokenAvailable) throw new Error("expected a token");
      await http()
        .post(`/v1/businesses/${world.businessA}/invitations/${created.invitation.id}/revoke`)
        .set(bearer(world.owner.token))
        .send({})
        .expect(200);
      const unknown = `tali_inv_${"A".repeat(43)}`;
      const responses = [];
      for (const token of [created.token, unknown, "not-a-token", `tali_dev_${"A".repeat(43)}`]) {
        const response = await http().post("/v1/invitations/accept").set(bearer(world.invitee.token)).send({ token });
        expect({ token, status: response.status }).toEqual({ token, status: 404 });
        expect(JSON.stringify(response.body)).not.toContain(token);
        responses.push(response.body);
      }
      expect(new Set(responses.map((body) => JSON.stringify(body))).size).toBe(1);

      const tooLong = `tali_inv_${"B".repeat(300)}`;
      const invalid = await http()
        .post("/v1/invitations/accept")
        .set(bearer(world.invitee.token))
        .send({ token: tooLong })
        .expect(400);
      expect(code(invalid.body)).toBe("VALIDATION_FAILED");
      expect(JSON.stringify(invalid.body)).not.toContain("BBBB");
      await expectNowhere([created.token]);
    });

    it("hides an expired invitation and keeps a second user out once it is accepted", async () => {
      const expired = CreateInvitationResponseSchema.parse((await invite(world.owner, world.businessA)).body);
      if (!expired.tokenAvailable) throw new Error("expected a token");
      await tenancyFixtures.expireInvitation(expired.invitation.id);
      await http()
        .post("/v1/invitations/accept")
        .set(bearer(world.invitee.token))
        .send({ token: expired.token })
        .expect(404);

      const fresh = CreateInvitationResponseSchema.parse((await invite(world.owner, world.businessA)).body);
      if (!fresh.tokenAvailable) throw new Error("expected a token");
      await http()
        .post("/v1/invitations/accept")
        .set(bearer(world.invitee.token))
        .send({ token: fresh.token })
        .expect(200);
      await http()
        .post("/v1/invitations/accept")
        .set(bearer(world.other.token))
        .send({ token: fresh.token })
        .expect(404);
      const others = MyBusinessesResponseSchema.parse(
        (await http().get("/v1/me/businesses").set(bearer(world.other.token)).expect(200)).body,
      );
      expect(others.items.map((item) => item.business.id)).toEqual([world.businessB]);
    });

    it("refuses an invitation for someone who is already a member and leaves it pending", async () => {
      const created = CreateInvitationResponseSchema.parse((await invite(world.owner, world.businessA)).body);
      if (!created.tokenAvailable) throw new Error("expected a token");
      const response = await http()
        .post("/v1/invitations/accept")
        .set(bearer(world.owner.token))
        .send({ token: created.token })
        .expect(409);
      expect(code(response.body)).toBe("CONFLICT");
      expect((await readTenancySnapshot()).invitations[0]?.status).toBe("PENDING");
    });

    it("requires member:invite, hides other tenants and validates the role", async () => {
      const { actor: manager } = await addMember(world.businessA, "MANAGER", "Dalila");
      const denied = await invite(manager, world.businessA).expect(403);
      expect(code(denied.body)).toBe("PERMISSION_DENIED");
      expect(code((await invite(world.other, world.businessA).expect(404)).body)).toBe("NOT_FOUND");
      expect(code((await invite(world.owner, world.businessA, "OWNER").expect(400)).body)).toBe("VALIDATION_FAILED");
      const missingKey = await http()
        .post(`/v1/businesses/${world.businessA}/invitations`)
        .set(bearer(world.owner.token))
        .send({ role: "CASHIER" })
        .expect(400);
      expect(code(missingKey.body)).toBe("IDEMPOTENCY_KEY_REQUIRED");

      const created = CreateInvitationResponseSchema.parse((await invite(world.owner, world.businessA)).body);
      await http()
        .post(`/v1/businesses/${world.businessB}/invitations/${created.invitation.id}/revoke`)
        .set(bearer(world.other.token))
        .send({})
        .expect(404);
      const revoked = await http()
        .post(`/v1/businesses/${world.businessA}/invitations/${created.invitation.id}/revoke`)
        .set(bearer(world.owner.token))
        .send({})
        .expect(200);
      expect(revoked.body).toMatchObject({ invitation: { id: created.invitation.id, status: "REVOKED" } });
      const auditBefore = (await readTenancySnapshot()).businessAudit.length;
      await http()
        .post(`/v1/businesses/${world.businessA}/invitations/${created.invitation.id}/revoke`)
        .set(bearer(world.owner.token))
        .send({})
        .expect(200);
      expect((await readTenancySnapshot()).businessAudit).toHaveLength(auditBefore);
    });

    it("rate-limits acceptance attempts per user in this process", async () => {
      const guesser = await registerActor(api, `guesser-${randomUUID()}`, "Guesser");
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 11; attempt += 1) {
        const response = await http()
          .post("/v1/invitations/accept")
          .set(bearer(guesser.token))
          .send({ token: `tali_inv_${String(attempt).padStart(43, "A")}` });
        statuses.push(response.status);
      }
      expect(statuses.slice(0, 10)).toEqual(Array.from({ length: 10 }, () => 404));
      expect(statuses[10]).toBe(429);
      await http()
        .post("/v1/invitations/accept")
        .set(bearer(world.invitee.token))
        .send({ token: `tali_inv_${"C".repeat(43)}` })
        .expect(404);
    });
  });

  describe("member management and rename", () => {
    it("changes a role, suspends and reactivates with a reason, with one audit record per real change", async () => {
      const { actor: cashier, membershipId } = await addMember(world.businessA, "CASHIER", "Esi");
      const base = `/v1/businesses/${world.businessA}/members/${membershipId}`;
      const promoted = await http()
        .post(`${base}/role`)
        .set(bearer(world.owner.token))
        .send({ role: "MANAGER", reason: "Covers the evening shift" })
        .expect(200);
      expect(MemberChangeResponseSchema.parse(promoted.body).membership).toEqual({
        id: membershipId,
        role: "MANAGER",
        status: "ACTIVE",
      });
      const audits = async () =>
        (await readTenancySnapshot()).businessAudit.filter((entry) => entry.entityId === membershipId).length;
      const afterRole = await audits();
      await http()
        .post(`${base}/role`)
        .set(bearer(world.owner.token))
        .send({ role: "MANAGER", reason: "Again" })
        .expect(200);
      expect(await audits()).toBe(afterRole);

      await http().post(`${base}/suspend`).set(bearer(world.owner.token)).send({ reason: "On leave" }).expect(200);
      await http().get(`/v1/businesses/${world.businessA}`).set(bearer(cashier.token)).expect(404);
      await http().post(`${base}/reactivate`).set(bearer(world.owner.token)).send({ reason: "Back" }).expect(200);
      await http().get(`/v1/businesses/${world.businessA}`).set(bearer(cashier.token)).expect(200);

      const missingReason = await http().post(`${base}/suspend`).set(bearer(world.owner.token)).send({}).expect(400);
      expect(code(missingReason.body)).toBe("VALIDATION_FAILED");
    });

    it("protects the last active owner and requires member:manage", async () => {
      const ownerMembership = (await readTenancySnapshot()).memberships.find(
        (entry) => entry.businessId === world.businessA && entry.userId === world.owner.userId,
      );
      if (ownerMembership === undefined) throw new Error("owner membership missing");
      const self = `/v1/businesses/${world.businessA}/members/${ownerMembership.id}`;
      expect(
        code(
          (await http().post(`${self}/suspend`).set(bearer(world.owner.token)).send({ reason: "x" }).expect(409)).body,
        ),
      ).toBe("CONFLICT");
      await http()
        .post(`${self}/role`)
        .set(bearer(world.owner.token))
        .send({ role: "MANAGER", reason: "x" })
        .expect(409);

      const { actor: manager } = await addMember(world.businessA, "MANAGER", "Fola");
      const denied = await http().post(`${self}/suspend`).set(bearer(manager.token)).send({ reason: "x" }).expect(403);
      expect(code(denied.body)).toBe("PERMISSION_DENIED");
      await http()
        .post(`/v1/businesses/${world.businessB}/members/${ownerMembership.id}/suspend`)
        .set(bearer(world.other.token))
        .send({ reason: "x" })
        .expect(404);
    });

    it("renames with business:update; the same name is a no-op with no audit record", async () => {
      const renamed = await http()
        .patch(`/v1/businesses/${world.businessA}`)
        .set(bearer(world.owner.token))
        .send({ name: "  Duka la Amani  " })
        .expect(200);
      expect(BusinessResponseSchema.parse(renamed.body).name).toBe("Duka la Amani");
      const renames = async () =>
        (await readTenancySnapshot()).businessAudit.filter((entry) => entry.action === "business.renamed");
      expect(await renames()).toHaveLength(1);
      await http()
        .patch(`/v1/businesses/${world.businessA}`)
        .set(bearer(world.owner.token))
        .send({ name: "Duka la Amani" })
        .expect(200);
      expect(await renames()).toHaveLength(1);
      expect((await renames())[0]?.payloadText).not.toContain("Duka");

      const { actor: cashier } = await addMember(world.businessA, "CASHIER", "Gift");
      await http()
        .patch(`/v1/businesses/${world.businessA}`)
        .set(bearer(cashier.token))
        .send({ name: "Mine now" })
        .expect(403);
      await http()
        .patch(`/v1/businesses/${world.businessA}`)
        .set(bearer(world.other.token))
        .send({ name: "Mine now" })
        .expect(404);
      await http()
        .patch(`/v1/businesses/${world.businessA}`)
        .set(bearer(world.owner.token))
        .send({ name: "x".repeat(121) })
        .expect(400);
      await http()
        .patch(`/v1/businesses/${world.businessA}`)
        .set(bearer(world.owner.token))
        .send({ name: "Ok", currencyCode: "USD" })
        .expect(400);
    });
  });

  describe("devices", () => {
    it("registers for any role with a one-time credential, replays without it, and lists safe metadata only", async () => {
      const { actor: cashier } = await addMember(world.businessA, "CASHIER", "Hadiza");
      const key = randomUUID();
      const created = await register(cashier, world.businessA, key).expect(201);
      expect(created.headers["cache-control"]).toBe("no-store");
      const first = RegisterDeviceResponseSchema.parse(created.body);
      if (!first.credentialAvailable) throw new Error("expected the credential");
      expect(first.credential).toMatch(/^tali_dev_[A-Za-z0-9_-]{43}$/);
      expect(first.device).toMatchObject({ platform: "ANDROID", label: "Front counter", status: "ACTIVE" });

      const replay = await register(cashier, world.businessA, key).expect(201);
      expect(replay.headers["idempotent-replayed"]).toBe("true");
      expect(replay.body).toEqual({ device: first.device, credentialAvailable: false });

      expect(
        code(
          (await http().get(`/v1/businesses/${world.businessA}/devices`).set(bearer(cashier.token)).expect(403)).body,
        ),
      ).toBe("PERMISSION_DENIED");
      const listed = await http()
        .get(`/v1/businesses/${world.businessA}/devices`)
        .set(bearer(world.owner.token))
        .expect(200);
      expect(DevicesResponseSchema.parse(listed.body).items).toEqual([first.device]);
      expect(JSON.stringify(listed.body)).not.toMatch(/credential|hash|tali_dev_/i);
      await http().get(`/v1/businesses/${world.businessB}/devices`).set(bearer(world.owner.token)).expect(404);

      const ios = await http()
        .post(`/v1/businesses/${world.businessA}/devices`)
        .set(bearer(cashier.token))
        .set("idempotency-key", randomUUID())
        .send({ platform: "IOS", label: "Phone" })
        .expect(400);
      expect(code(ios.body)).toBe("VALIDATION_FAILED");
      await expectNowhere([first.credential]);
      expect((await readTenancySnapshot()).devices[0]?.credentialHashHex).toBe(sha256Hex(first.credential));
    });

    it("verifies device headers on business routes, attributes audits to the device and fails closed", async () => {
      const created = RegisterDeviceResponseSchema.parse((await register(world.owner, world.businessA)).body);
      if (!created.credentialAvailable) throw new Error("expected the credential");
      const deviceId = created.device.id;
      const trusted = { [DEVICE_ID_HEADER]: deviceId, [DEVICE_CREDENTIAL_HEADER]: created.credential };

      await http().get(`/v1/businesses/${world.businessA}`).set(bearer(world.owner.token)).set(trusted).expect(200);
      const invited = await invite(world.owner, world.businessA).set(trusted).expect(201);
      const invitationId = CreateInvitationResponseSchema.parse(invited.body).invitation.id;
      const audit = (await readTenancySnapshot()).businessAudit.find(
        (entry) => entry.action === "invitation.created" && entry.entityId === invitationId,
      );
      expect(audit?.deviceId).toBe(deviceId);

      const wrong = `tali_dev_${"Z".repeat(43)}`;
      const attempts = [
        { [DEVICE_ID_HEADER]: deviceId, [DEVICE_CREDENTIAL_HEADER]: wrong },
        { [DEVICE_ID_HEADER]: deviceId },
        { [DEVICE_CREDENTIAL_HEADER]: created.credential },
        { [DEVICE_ID_HEADER]: "not-a-uuid", [DEVICE_CREDENTIAL_HEADER]: created.credential },
        { [DEVICE_ID_HEADER]: randomUUID(), [DEVICE_CREDENTIAL_HEADER]: created.credential },
      ];
      for (const headers of attempts) {
        const response = await http()
          .get(`/v1/businesses/${world.businessA}`)
          .set(bearer(world.owner.token))
          .set(headers);
        expect({ headers, status: response.status }).toEqual({ headers, status: 403 });
        expect(code(response.body)).toBe("DEVICE_NOT_TRUSTED");
        expect(JSON.stringify(response.body)).not.toContain(created.credential);
      }

      const foreign = await http()
        .get(`/v1/businesses/${world.businessB}`)
        .set(bearer(world.other.token))
        .set(trusted)
        .expect(403);
      expect(code(foreign.body)).toBe("DEVICE_NOT_TRUSTED");

      // Device headers never grant access: an outsider presenting a valid device is still hidden.
      await http().get(`/v1/businesses/${world.businessA}`).set(bearer(world.other.token)).set(trusted).expect(404);
      await http().get(`/v1/businesses/${world.businessA}`).set(trusted).expect(401);
      // Device headers are ignored on user-level routes.
      await http()
        .get("/v1/me")
        .set(bearer(world.owner.token))
        .set({ [DEVICE_ID_HEADER]: deviceId })
        .expect(200);

      const denials = api.logs.filter((entry) => entry["msg"] === "device.not_trusted");
      expect(denials.length).toBeGreaterThanOrEqual(attempts.length);
      await expectNowhere([created.credential, wrong]);
    });

    it("revokes with device:revoke; a revoked device fails closed and revoking again is a no-op", async () => {
      const { actor: manager } = await addMember(world.businessA, "MANAGER", "Ifeoma");
      const created = RegisterDeviceResponseSchema.parse((await register(manager, world.businessA)).body);
      if (!created.credentialAvailable) throw new Error("expected the credential");
      const revokePath = `/v1/businesses/${world.businessA}/devices/${created.device.id}/revoke`;
      expect(code((await http().post(revokePath).set(bearer(manager.token)).send({}).expect(403)).body)).toBe(
        "PERMISSION_DENIED",
      );
      await http()
        .post(`/v1/businesses/${world.businessB}/devices/${created.device.id}/revoke`)
        .set(bearer(world.other.token))
        .send({})
        .expect(404);
      const revoked = await http().post(revokePath).set(bearer(world.owner.token)).send({}).expect(200);
      expect(revoked.body).toMatchObject({ device: { id: created.device.id, status: "REVOKED" } });
      const audits = (await readTenancySnapshot()).businessAudit.length;
      await http().post(revokePath).set(bearer(world.owner.token)).send({}).expect(200);
      expect((await readTenancySnapshot()).businessAudit).toHaveLength(audits);

      const rejected = await http()
        .get(`/v1/businesses/${world.businessA}`)
        .set(bearer(manager.token))
        .set({ [DEVICE_ID_HEADER]: created.device.id, [DEVICE_CREDENTIAL_HEADER]: created.credential })
        .expect(403);
      expect(code(rejected.body)).toBe("DEVICE_NOT_TRUSTED");
      await http().get(`/v1/businesses/${world.businessA}`).set(bearer(manager.token)).expect(200);
    });
  });
});
