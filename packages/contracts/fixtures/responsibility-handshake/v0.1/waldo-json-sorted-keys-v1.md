# waldo-json-sorted-keys-v1

This document is the normative specification for the canonical JSON bytes used by responsibility-handshake v0.1 digests. Its serialization profile is compatible with the JSON Canonicalization Scheme in RFC 8785.

## Input

The input is an admitted I-JSON data-model value: null, boolean, well-formed Unicode string, finite IEEE-754 binary64 number, array, or object with unique well-formed Unicode string keys. A caller that starts from JSON text MUST reject duplicate object keys before canonicalization. Lone UTF-16 surrogates, non-finite numbers, sparse arrays, cycles, and non-JSON values MUST be rejected. Canonical request digests MUST run command-specific admission before this algorithm.

## Transformation

1. Preserve array element order and recursively transform every element.
2. Sort every object's keys lexicographically by their raw UTF-16 code units, comparing unsigned 16-bit units and treating the shorter key as first when one is a prefix. Do not use locale-aware ordering, Unicode scalar ordering, case folding, or Unicode normalization.
3. Recursively transform each object value after ordering its key.
4. Serialize the transformed value with ECMAScript `JSON.stringify` semantics and no replacer, indentation, or trailing newline:
   - emit no insignificant whitespace;
   - escape quotation mark and reverse solidus;
   - use the short escapes `\b`, `\t`, `\n`, `\f`, and `\r`;
   - escape other U+0000 through U+001F code units as lowercase `\u00xx`;
   - emit every other character without Unicode normalization;
   - serialize finite numbers with ECMAScript Number-to-string semantics, including negative zero as `0`.

## Digest

Encode the canonical JSON string as UTF-8 without a byte-order mark. Compute SHA-256 over those exact bytes and represent it as `sha256:` followed by 64 lowercase hexadecimal digits.

The companion `canonicalization-vectors.json` file is normative conformance evidence. Its `inputJson` fields are raw JSON text, not pre-normalized objects. An implementation MUST match every positive vector and reject every negative vector before producing or comparing request digests.
