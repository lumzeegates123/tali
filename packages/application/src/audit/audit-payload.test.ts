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

  it("registers exactly the Build 1 actions (plan 003 section 12) and the Build 2 catalog actions", () => {
    expect(taliAuditRegistry.actions.map((a) => [a.name, a.stream]).sort()).toEqual([
      ["business.created", "business"],
      ["business.renamed", "business"],
      ["device.registered", "business"],
      ["device.revoked", "business"],
      ["identity.linked", "platform"],
      ["invitation.accepted", "business"],
      ["invitation.created", "business"],
      ["invitation.revoked", "business"],
      ["location.created", "business"],
      ["membership.created", "business"],
      ["membership.reactivated", "business"],
      ["membership.role_changed", "business"],
      ["membership.suspended", "business"],
      ["product.archived", "business"],
      ["product.created", "business"],
      ["product.price_set", "business"],
      ["product.reactivated", "business"],
      ["product.updated", "business"],
      ["product_category.archived", "business"],
      ["product_category.created", "business"],
      ["product_category.updated", "business"],
      ["product_pack.added", "business"],
      ["product_pack.retired", "business"],
      ["user.registered", "platform"],
    ]);
  });

  it("registers no inventory action in Build 2 Slice 1", () => {
    expect(taliAuditRegistry.actions.filter((a) => a.name.startsWith("inventory."))).toEqual([]);
  });

  /**
   * Catalog names are business data that ADR-008 section 16 requires in the
   * payload (product, category and pack names). People's names, subjects,
   * emails and phone numbers are never recorded.
   */
  const CATALOG_NAME_FIELDS = new Set([
    "product.created.name",
    "product.updated.fromName",
    "product.updated.toName",
    "product.updated.nameChanged",
    "product_category.created.name",
    "product_category.updated.fromName",
    "product_category.updated.toName",
    "product_pack.added.name",
  ]);

  it("has no registered field whose name looks sensitive, and no personal display names", () => {
    for (const registered of taliAuditRegistry.actions) {
      for (const name of Object.keys(registered.fields)) {
        const qualified = `${registered.name}.${name}`;
        expect(SENSITIVE_FIELD_NAME.test(name), qualified).toBe(false);
        if (CATALOG_NAME_FIELDS.has(qualified)) continue;
        expect(name.toLowerCase(), qualified).not.toMatch(/name|subject|email|phone/);
      }
    }
  });

  it("allows catalog name fields only on catalog entity types", () => {
    for (const registered of taliAuditRegistry.actions) {
      for (const name of Object.keys(registered.fields)) {
        if (!CATALOG_NAME_FIELDS.has(`${registered.name}.${name}`)) continue;
        expect(["product", "product_category", "product_pack"]).toContain(registered.entityType);
      }
    }
  });
});

describe("integer-string audit field (ADR-008 section 16)", () => {
  const unsigned = { value: auditField.integerString({ maxLength: 19, allowNegative: false }) };
  const signed = { value: auditField.integerString({ maxLength: 17, allowNegative: true }) };

  it.each(["0", "7", "1500", "9223372036854775807"])("accepts the canonical non-negative string %s", (value) => {
    expect(validateAuditPayload(unsigned, { value })["value"]).toBe(value);
  });

  it.each(["0", "-1", "-1000000000000000", "1000000000000000"])("accepts the canonical signed string %s", (value) => {
    expect(validateAuditPayload(signed, { value })["value"]).toBe(value);
  });

  it.each([
    ["a negative where not allowed", unsigned, "-1"],
    ["negative zero", signed, "-0"],
    ["negative zero (unsigned)", unsigned, "-0"],
    ["a plus sign", signed, "+1"],
    ["a leading zero", unsigned, "01"],
    ["a negative leading zero", signed, "-01"],
    ["a decimal", unsigned, "1.5"],
    ["an exponent", unsigned, "1e3"],
    ["whitespace", unsigned, " 1"],
    ["an empty string", unsigned, ""],
    ["non-ASCII digits", unsigned, "١"],
    ["excessive length", unsigned, "1".repeat(20)],
    ["excessive signed length", signed, `-${"1".repeat(17)}`],
  ] as const)("rejects %s", (_label, definition, value) => {
    expect(() => validateAuditPayload(definition, { value })).toThrow(AuditPayloadError);
  });

  it.each([1500, 1500n, null, true])("never coerces the non-string %s", (value) => {
    expect(() => validateAuditPayload(unsigned, { value })).toThrow(AuditPayloadError);
  });

  it("rejects unknown fields beside it", () => {
    expect(() => validateAuditPayload(unsigned, { value: "1", other: "2" })).toThrow(/not declared/);
  });

  it("rejects invalid definitions", () => {
    expect(() => auditField.integerString({ maxLength: 0, allowNegative: false })).toThrow(AuditPayloadError);
    expect(() => auditField.integerString({ maxLength: 41, allowNegative: false })).toThrow(AuditPayloadError);
    expect(() => auditField.integerString({ maxLength: 1, allowNegative: true })).toThrow(AuditPayloadError);
    expect(() => auditField.integerString({ maxLength: 1.5, allowNegative: false })).toThrow(AuditPayloadError);
  });

  it("counts its declared worst case toward the 8 KiB limit", () => {
    const at40 = auditField.integerString({ maxLength: 40, allowNegative: true });
    // Braces (2) + per field: 6-character name + quotes, colon and comma (4) + 40 characters + quotes (42) = 52.
    // 2 + 157 * 52 = 8166 fits; 2 + 158 * 52 = 8218 does not.
    const named = (count: number) =>
      Object.fromEntries(Array.from({ length: count }, (_, i) => [`f${String(i).padStart(5, "0")}`, at40]));
    expect(() => {
      validateAuditFields(named(157));
    }).not.toThrow();
    const exceeds = named(158);
    expect(() => {
      validateAuditFields(exceeds);
    }).toThrow(/8192/);
  });

  it("is optional like any other kind", () => {
    const definition = { value: auditField.optional(auditField.integerString({ maxLength: 3, allowNegative: false })) };
    expect(validateAuditPayload(definition, {})).toEqual({});
    expect(validateAuditPayload(definition, { value: "100" })["value"]).toBe("100");
  });
});
