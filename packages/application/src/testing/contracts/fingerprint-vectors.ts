import { BusinessDate } from "@tali/domain";
import type { CanonicalCommand, CommandObject } from "../../idempotency/canonical-command.js";
import { canonicalCommandEncoding, canonicalEnum, canonicalSet } from "../../idempotency/canonical-command.js";

/**
 * Fingerprint framing version 1 test vectors (specification:
 * `src/idempotency/fingerprint-framing-v1.md`). The frame bytes were written
 * by hand from the specification and the digests were computed with an
 * independent SHA-256 implementation (.NET System.Security.Cryptography,
 * checked against the FIPS 180-2 "abc" vector). They are constants: never
 * regenerate them from the adapter under test.
 */
export interface FingerprintVector {
  readonly name: string;
  readonly command: () => CanonicalCommand;
  readonly frameHex: string;
  readonly digestHex: string;
}

const vector = (command: CommandObject): CanonicalCommand =>
  canonicalCommandEncoding({ operation: "test.vector.v1", commandSchemaVersion: 1, command });

const HEADER = "54465001530000000e746573742e766563746f722e7631490000000131";

export const FINGERPRINT_V1_VECTORS: readonly FingerprintVector[] = [
  {
    name: "empty object",
    command: () => vector({}),
    frameHex: `${HEADER}4f00000000`,
    digestHex: "28c42cac6443b894c8dec1f144ac3ff4466423fbc01f7a06bf45bf10132793d3",
  },
  {
    name: "key ordering",
    command: () => vector({ b: "2", a: "1" }),
    frameHex: `${HEADER}4f0000000200000001615300000001310000000162530000000132`,
    digestHex: "760df64b292fa04a6c8402e2dfc5c37f5566dce9fa0b82e2eb5ef7323e58e59a",
  },
  {
    name: "explicit null (differs from absent)",
    command: () => vector({ a: null }),
    frameHex: `${HEADER}4f0000000100000001614e`,
    digestHex: "c4058af36eec9f53470f9ff7341a4a87f4670563ec0f69a67bf475e52ad1b183",
  },
  {
    name: "integers (safe integer, bigint, negative)",
    command: () => vector({ n: 42, b: 42n, m: -7 }),
    frameHex: `${HEADER}4f00000003000000016247000000023432000000016d49000000022d37000000016e49000000023432`,
    digestHex: "c8ecbdf1187549fb76ab677ca762d95a966ffa7d585a222f0aa791cec8ef7f15",
  },
  {
    name: "Unicode NFC (decomposed input)",
    command: () => vector({ s: "e\u0301" }),
    frameHex: `${HEADER}4f0000000100000001735300000002c3a9`,
    digestHex: "8a19258f67111475864655ebfa71480e60d99eb34e09fe99dfb71f466da99807",
  },
  {
    name: "multibyte UTF-8 value (3- and 4-byte sequences)",
    command: () => vector({ s: "\u20A6\u{1F600}" }),
    frameHex: `${HEADER}4f0000000100000001735300000007e282a6f09f9880`,
    digestHex: "3c272c6e60e3b20f665c67dd6b66fe6ba60ee60853cf5901126b80cde5e5275a",
  },
  {
    name: "multibyte UTF-8 key with a boolean",
    command: () => vector({ "\u20A6": true }),
    frameHex: `${HEADER}4f0000000100000003e282a64201`,
    digestHex: "666780a7ab1a98b56d7d580f3fa7eb549ff12e25d99d053e17a765310efa5723",
  },
  {
    name: "ordered array [A, B]",
    command: () => vector({ l: ["A", "B"] }),
    frameHex: `${HEADER}4f00000001000000016c4100000002530000000141530000000142`,
    digestHex: "b742b7f551e8cd479da889b8f0dd5d6b2d49776d36e46c01dec0886a03bfd492",
  },
  {
    name: "ordered array [B, A]",
    command: () => vector({ l: ["B", "A"] }),
    frameHex: `${HEADER}4f00000001000000016c4100000002530000000142530000000141`,
    digestHex: "cfef84d275bf5aca85c6c188c10a73a6ec154ff52e2479bc11a56d96210a6e8d",
  },
  {
    name: "unordered set {B, A}",
    command: () => vector({ s: canonicalSet(["B", "A"]) }),
    frameHex: `${HEADER}4f0000000100000001735500000002530000000141530000000142`,
    digestHex: "f4d8b98cd1776565cd817c644c1a8c053dda824c6374b97c6b25c92af86b7ebe",
  },
  {
    name: "set ordered by bytes, not locale",
    command: () => vector({ s: canonicalSet(["a", "B"]) }),
    frameHex: `${HEADER}4f0000000100000001735500000002530000000142530000000161`,
    digestHex: "a034386eda994151336bc887883650ca9c67db3f16bcc490ff4f7daabe653081",
  },
  {
    name: "set ordered by encoded element (length prefix first)",
    command: () => vector({ s: canonicalSet(["aa", "b"]) }),
    frameHex: `${HEADER}4f000000010000000173550000000253000000016253000000026161`,
    digestHex: "a91da1904c4d112590fe7f5b8f1c922709b946e2a1d63d27f68bbc4eed034d02",
  },
  {
    name: "nesting with business date, enum, array, null, zero and instant",
    command: () =>
      vector({
        o: {
          when: new Date("2026-09-29T08:00:00.000Z"),
          kind: canonicalEnum("OWNER"),
          list: [true, null, 0],
          day: BusinessDate.parse("2026-09-29"),
        },
      }),
    frameHex:
      `${HEADER}4f00000001000000016f4f0000000400000003646179590000000a323032362d30392d3239` +
      "000000046b696e6445000000054f574e4552000000046c697374410000000342014e490000000130" +
      "000000047768656e4400000018323032362d30392d32395430383a30303a30302e3030305a",
    digestHex: "4b9ca896d907571571ade2b099a961bd5870da2582fc6d69cae49ac78d4f2708",
  },
  {
    name: "business.create.v1 command",
    command: () =>
      canonicalCommandEncoding({
        operation: "business.create.v1",
        commandSchemaVersion: 1,
        command: { name: "Duka la Amani", currencyCode: "KES", timeZone: "Africa/Nairobi" },
      }),
    frameHex:
      "544650015300000012627573696e6573732e6372656174652e76314900000001314f00000003" +
      "0000000c63757272656e6379436f646553000000034b4553000000046e616d65530000000d44756b61206c6120416d616e69" +
      "0000000874696d655a6f6e65530000000e4166726963612f4e6169726f6269",
    digestHex: "ac4f41b5fab21919086919fb0c5b1bfe76945ec15bd50cce6ad8870917c27d46",
  },
];
