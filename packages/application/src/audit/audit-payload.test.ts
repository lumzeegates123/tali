import { describe, expect, it } from "vitest";
import { defineAuditAction, defineAuditRegistry } from "./audit-action.js";
import {
  AUDIT_PAYLOAD_MAX_BYTES,
  AuditPayloadError,
  auditField,
  SENSITIVE_FIELD_NAME,
  validateAuditFields,
  validateAuditPayload,
} from "./audit-payload.js";
import { taliAuditRegistry } from "./tali-audit-registry.js";

const ID = "01928c6e-8b3a-7c4d-9e5f-0a1b2c3d4e5f";

const fields = {
  userId: auditField.id(),
  label: auditField.string(10),
  flag: auditField.boolean(),
  role: auditField.enumeration(["OWNER", "MANAGER"]),
  count: auditField.integer(0, 5),
  at: auditField.instant(),
  note: auditField.optional(auditField.string(20)),
};

const valid = {
  userId: ID,
  label: "hello",
  flag: true,
  role: "OWNER",
  count: 3,
  at: "2026-09-29T08:00:00.000Z",
};

describe("audit field definitions", () => {
  it("accepts camelCase fields within the size limit", () => {
    expect(() => {
      validateAuditFields(fields);
    }).not.toThrow();
  });

  it.each(["accessToken", "clientSecret", "credentialId", "passwordHint", "tokenHash", "rawJwt", "idToken"])(
    "rejects the sensitive field name %s",
    (name) => {
      expect(() => {
        validateAuditFields({ [name]: auditField.boolean() });
      }).toThrow(AuditPayloadError);
    },
  );

  it.each(["UserId", "user_id", "user-id", ""])("rejects the non-camelCase field name %j", (name) => {
    expect(() => {
      validateAuditFields({ [name]: auditField.boolean() });
    }).toThrow(AuditPayloadError);
  });

  it("rejects definitions whose worst case exceeds 8 KiB", () => {
    const large = Object.fromEntries(Array.from({ length: 2 }, (_, i) => [`text${i}`, auditField.string(1000)]));
    expect(() => {
      validateAuditFields(large);
    }).toThrow(/8192/);
    expect(AUDIT_PAYLOAD_MAX_BYTES).toBe(8192);
  });

  it("accepts a definition just within the worst-case bound", () => {
    expect(() => {
      validateAuditFields({ text: auditField.string(1000) });
    }).not.toThrow();
  });

  it("rejects invalid builder bounds", () => {
    expect(() => auditField.string(0)).toThrow(AuditPayloadError);
    expect(() => auditField.string(1001)).toThrow(AuditPayloadError);
    expect(() => auditField.integer(5, 1)).toThrow(AuditPayloadError);
    expect(() => auditField.integer(0, 2 ** 53)).toThrow(AuditPayloadError);
    expect(() => auditField.enumeration([])).toThrow(AuditPayloadError);
    expect(() => auditField.enumeration(["A", "A"])).toThrow(AuditPayloadError);
    expect(() => auditField.enumeration(["has space"])).toThrow(AuditPayloadError);
  });
});

describe("audit payload validation", () => {
  it("returns the values unchanged in a frozen copy", () => {
    const input = { ...valid, label: "  Café  " };
    const result = validateAuditPayload(fields, input);
    expect(result).toEqual(input);
    expect(result).not.toBe(input);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("does not normalize, trim or coerce", () => {
    const decomposed = "Cafe\u0301";
    expect(validateAuditPayload(fields, { ...valid, label: decomposed })["label"]).toBe(decomposed);
    expect(() => validateAuditPayload(fields, { ...valid, count: "3" })).toThrow(AuditPayloadError);
    expect(() => validateAuditPayload(fields, { ...valid, flag: "true" })).toThrow(AuditPayloadError);
  });

  it("rejects unknown fields", () => {
    expect(() => validateAuditPayload(fields, { ...valid, extra: 1 })).toThrow(/not declared/);
  });

  it("rejects missing required fields and accepts a missing optional field", () => {
    const missing = Object.fromEntries(Object.entries(valid).filter(([name]) => name !== "label"));
    expect(() => validateAuditPayload(fields, missing)).toThrow(/required/);
    expect(validateAuditPayload(fields, { ...valid, note: "n" })["note"]).toBe("n");
  });

  it("rejects null for an optional field", () => {
    expect(() => validateAuditPayload(fields, { ...valid, note: null })).toThrow(AuditPayloadError);
  });

  it.each([
    ["non-canonical id", { userId: ID.toUpperCase() }],
    ["not an id", { userId: "abc" }],
    ["string too long", { label: "x".repeat(11) }],
    ["lone surrogate", { label: "\uD800" }],
    ["enum outside the list", { role: "CASHIER" }],
    ["integer out of range", { count: 6 }],
    ["fractional integer", { count: 1.5 }],
    ["negative zero", { count: -0 }],
    ["instant without milliseconds", { at: "2026-09-29T08:00:00Z" }],
    ["instant with an offset", { at: "2026-09-29T08:00:00.000+01:00" }],
    ["impossible instant", { at: "2026-02-30T08:00:00.000Z" }],
  ])("rejects %s", (_name, override) => {
    expect(() => validateAuditPayload(fields, { ...valid, ...override })).toThrow(AuditPayloadError);
  });

  it("counts string length in code points", () => {
    expect(validateAuditPayload(fields, { ...valid, label: "😀".repeat(10) })["label"]).toHaveLength(20);
  });

  it.each([null, [], "text", new Date(0), Object.create({ inherited: true })])(
    "rejects the non-plain payload %j",
    (payload) => {
      expect(() => validateAuditPayload(fields, payload)).toThrow(AuditPayloadError);
    },
  );
});

describe("audit actions and registry", () => {
  const action = defineAuditAction({
    name: "example.done",
    stream: "business",
    entityType: "business",
    payloadSchemaVersion: 1,
    fields: { flag: auditField.boolean() },
  });

  it("rejects malformed action names and versions", () => {
    const base = { stream: "business", entityType: "business", fields: {} } as const;
    expect(() => defineAuditAction({ ...base, name: "Example.Done", payloadSchemaVersion: 1 })).toThrow(
      AuditPayloadError,
    );
    expect(() => defineAuditAction({ ...base, name: "example", payloadSchemaVersion: 1 })).toThrow(AuditPayloadError);
    expect(() => defineAuditAction({ ...base, name: "example.done", payloadSchemaVersion: 0 })).toThrow(
      AuditPayloadError,
    );
  });

  it("rejects a sensitive field in an action definition", () => {
    expect(() =>
      defineAuditAction({
        name: "example.leak",
        stream: "platform",
        entityType: "user",
        payloadSchemaVersion: 1,
        fields: { sessionToken: auditField.string(10) },
      }),
    ).toThrow(AuditPayloadError);
  });

  it("rejects duplicate registrations", () => {
    const again = defineAuditAction({ ...action, fields: { flag: auditField.boolean() } });
    expect(() => defineAuditRegistry([action, again])).toThrow(/registered twice/);
  });

  it("recognizes only the exact registered definition", () => {
    const registry = defineAuditRegistry([action]);
    expect(registry.has(action)).toBe(true);
    expect(registry.has(defineAuditAction({ ...action, fields: { flag: auditField.boolean() } }))).toBe(false);
  });

  it("registers exactly the Slice 1 actions", () => {
    expect(taliAuditRegistry.actions.map((a) => [a.name, a.stream]).sort()).toEqual([
      ["business.created", "business"],
      ["identity.linked", "platform"],
      ["location.created", "business"],
      ["membership.created", "business"],
      ["user.registered", "platform"],
    ]);
  });

  it("has no registered field whose name looks sensitive, and no free-text display names", () => {
    for (const registered of taliAuditRegistry.actions) {
      for (const name of Object.keys(registered.fields)) {
        expect(SENSITIVE_FIELD_NAME.test(name), `${registered.name}.${name}`).toBe(false);
        expect(name.toLowerCase(), `${registered.name}.${name}`).not.toMatch(/name|subject|email|phone/);
      }
    }
  });
});
