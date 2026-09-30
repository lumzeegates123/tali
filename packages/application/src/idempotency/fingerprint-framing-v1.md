# Fingerprint framing, version 1

Status: normative for `fingerprintVersion = 1` (ADR-004 section 4). Implemented by
`packages/integrations/src/platform/crypto/fingerprint-framing.ts`; test vectors in
`src/testing/contracts/fingerprint-vectors.ts`, checked against the real adapter by
`describeFingerprintHasherContract`.

A request fingerprint is `SHA-256(frame)`, where `frame` is the byte string defined here for a
`CanonicalCommand`. The frame is never JSON: JSON text depends on key order, number formatting and
escaping choices, so equal commands could hash differently. Every value is written with an explicit
type tag and explicit byte lengths, so no two different commands share a frame.

A version never changes once used. Any change to the bytes produced for any command is a new
version, recorded in stored idempotency records next to the digest.

## Pipeline

1. The application builds the canonical representation (`canonicalCommandEncoding`): text is
   normalized to Unicode NFC, absent optional fields are omitted, `null` is kept, object keys are
   sorted, sets are marked as sets, and instants, business dates, enums and integers get their own
   kinds. No floating-point numbers exist in the model.
2. The adapter frames it as below and rejects anything the framing does not define.
3. The adapter hashes the frame with SHA-256 from `node:crypto`.

## Primitives

- `u32(n)`: `n` as an unsigned 32-bit big-endian integer (4 bytes). Every length and count uses it.
- `text(s)`: `u32(byte length)` followed by the UTF-8 bytes of `s`. `s` must be well-formed
  Unicode (no lone surrogates) and already in NFC; otherwise the frame is refused.
- Byte order: unsigned lexicographic comparison of bytes; a proper prefix sorts first.

## Frame

```text
frame = 54 46 50 01            "TFP" and the framing version byte 0x01
        53 text(operation)     the operation name, e.g. "business.create.v1"
        49 text(digits)        commandSchemaVersion as decimal digits (a positive safe integer)
        object(command)        the command body, which must be an object
```

## Values

| Tag | Byte | Kind             | Payload                                                                        |
| --- | ---- | ---------------- | ------------------------------------------------------------------------------ |
| N   | 4E   | null             | none                                                                           |
| B   | 42   | boolean          | one byte, `00` false or `01` true                                              |
| E   | 45   | enum             | `text(token)`, token matching `[A-Za-z0-9_.:-]{1,64}`                          |
| S   | 53   | string           | `text(s)`                                                                      |
| I   | 49   | safe integer     | `text(decimal digits)`: `0` or `-?[1-9][0-9]*`, within the safe-integer range  |
| G   | 47   | bigint           | `text(decimal digits)`, same syntax, at most 1024 characters                   |
| D   | 44   | instant          | `text(YYYY-MM-DDTHH:mm:ss.sssZ)`, UTC with milliseconds                        |
| Y   | 59   | business date    | `text(YYYY-MM-DD)`, a real calendar date                                       |
| A   | 41   | ordered array    | `u32(count)`, then each element's encoding in array order                      |
| U   | 55   | unordered set    | `u32(count)`, then the element encodings sorted by byte order; no duplicates   |
| O   | 4F   | object           | `u32(count)`, then per entry `text(key)` and the value's encoding              |

Rules:

- Object keys are strictly increasing by the byte order of their UTF-8 bytes (not by locale or
  UTF-16 code units); a duplicate or out-of-order key is refused.
- A safe integer and a bigint with the same digits differ (tags `I` and `G`), as do an enum and a
  string with the same text (tags `E` and `S`).
- An explicit `null` (`N`) differs from an absent field (no entry at all).
- Set elements are compared by their complete encodings, tag and length prefix included, so
  `{"aa", "b"}` frames `b` first.
- Nesting deeper than 32 levels is refused.

## Test vectors

The vectors in `fingerprint-vectors.ts` cover the empty object, key ordering, `null` versus absent,
safe integers, bigints and negative numbers, NFC normalization, multibyte UTF-8 values and keys,
ordered arrays in both orders, sets (including byte order and length-prefix order), nesting with
every scalar kind, and a real `business.create.v1` command. Their frames were written by hand from
this document and their digests computed with an independent SHA-256 implementation. They are
constants and are never regenerated from the adapter under test.
