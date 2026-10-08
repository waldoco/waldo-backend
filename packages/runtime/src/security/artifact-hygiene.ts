// E1 (issue #150): deterministic quarantine of verification artifacts - OTP codes, password-reset
// and magic-link URLs - at communication ingress, BEFORE content reaches model-visible context.
// This is a hard security boundary (an artifact in context is lethal-trifecta fuel: private data +
// untrusted content + an exfil channel), so the filter is a fixed pattern set by design - judgment
// stays with the model everywhere else. Fail-closed is the correct bias here: a false positive
// costs the owner a trip to the source app, where the item stays fully inspectable; a false
// negative hands a live credential to whatever else is in context.
//
// Redaction happens at the ingress boundary itself, so every downstream consumer - episodes,
// traces, logs - only ever sees the redacted form. No raw artifact is persisted anywhere.

export type ArtifactKind = 'otp' | 'magic_link' | 'password_reset';

export type Quarantine = Readonly<{
  text: string;
  kinds: readonly ArtifactKind[];
}>;

export const artifactMarker = (kind: ArtifactKind): string => `[quarantined: ${kind} artifact - view in the source app]`;

// A code is digits only: 4-8 plain digits ("123456") or the split form ("123-456"). Alphanumeric
// order/tracking ids never match.
const CODE = String.raw`(?:\d{3}-\d{3}|\d{4,8})`;

// URL boundary: stop at whitespace or the punctuation that commonly wraps a pasted link.
const URL_TAIL = String.raw`[^\s"'<>)\]]*`;

const PATTERNS: ReadonlyArray<{ kind: ArtifactKind; re: RegExp }> = [
  // Supabase (and lookalike) token endpoints carry the live bearer in the query string.
  { kind: 'magic_link', re: new RegExp(String.raw`https?://[^\s"'<>)\]]*/auth/v\d+/verify${URL_TAIL}`, 'gi') },
  // recovery is the password-reset artifact; it runs before the generic token patterns so a
  // recovery URL is labeled (and logged) as what it is.
  { kind: 'password_reset', re: new RegExp(String.raw`https?://[^\s"'<>)\]]*[?&]type=recovery${URL_TAIL}`, 'gi') },
  { kind: 'magic_link', re: new RegExp(String.raw`https?://[^\s"'<>)\]]*[?&]type=(?:magiclink|signup|email_change|invite)${URL_TAIL}`, 'gi') },
  { kind: 'magic_link', re: new RegExp(String.raw`https?://[^\s"'<>)\]]*[?&]token_hash=${URL_TAIL}`, 'gi') },
  { kind: 'password_reset', re: new RegExp(String.raw`https?://[^\s"'<>)\]]*(?:/reset[-_]?password|/password[-_]?reset|reset[-_]?token=|confirmation[-_]?token=)${URL_TAIL}`, 'gi') },
  // "Your Google verification code is 123456", "login code: 123-456", "security code 123456".
  {
    kind: 'otp',
    re: new RegExp(String.raw`\b[\w-]*\s?(?:verification|one[- ]?time|login|log[- ]?in|sign[- ]?in|security|authentication|confirmation|access)\s+(?:code|passcode|pin|otp)\b\s*(?:is|:|-)?\s*#?\s*` + CODE + String.raw`\b`, 'gi'),
  },
  // "OTP: 123456", "passcode is 123456" - the bare form, no vendor adjective needed. Bare "code" is
  // not here: "postal code: 560001" and "error code 5001" are not credentials. "verification code",
  // "login code" etc. stay covered by the vendor-adjective pattern above.
  { kind: 'otp', re: new RegExp(String.raw`\b(?:otp|passcode)\b\s*(?:is|:)?\s*#?\s*` + CODE + String.raw`\b`, 'gi') },
  // Google's SMS/mail prefix form runs first: "G-123456 is your Google verification code" would
  // otherwise lose its prefix to the generic "is your" pattern below before extraction sees it.
  { kind: 'otp', re: new RegExp(String.raw`\bG-\d{6}\b`, 'g') },
  // "123456 is your Google verification code", "123-456 is your WhatsApp code".
  { kind: 'otp', re: new RegExp(String.raw`\b` + CODE + String.raw`\s+is\s+your\s+(?:[\w-]+\s){0,3}(?:code|passcode|otp)\b`, 'gi') },
];

// Replace every artifact match with a typed marker. Returns the redacted text plus the distinct
// kinds found; an empty kinds array means the text passed through untouched (same string identity).
export const quarantineArtifacts = (text: string): Quarantine => {
  const extracted = extractArtifacts(text);
  const kinds = [...new Set(extracted.artifacts.map((artifact) => artifact.kind))].sort();
  return kinds.length === 0 ? { text, kinds: [] } : { text: extracted.text, kinds };
};

export type ExtractedArtifact = Readonly<{ kind: ArtifactKind; value: string }>;

// Owner-ruled OTP parity (September 27, 2026 WhatsApp ruling, superseding the #150 keep-quarantined
// posture for the mail read path): the same fixed patterns, but the matched value is captured so the
// artifact can be relayed to the owner directly on his chat channel - the Instinct behavior ("read
// the code out of mail for me") without the artifact ever entering model context or persistence.
// Duplicates (a code restated in subject + body) collapse by value.
export const extractArtifacts = (text: string): { text: string; artifacts: readonly ExtractedArtifact[] } => {
  let redacted = text;
  const seen = new Set<string>();
  const artifacts: ExtractedArtifact[] = [];
  for (const { kind, re } of PATTERNS) {
    redacted = redacted.replace(re, (match) => {
      // OTP patterns match the surrounding phrase ("Your login code is 123456"); the relay value
      // is the code itself. Links relay whole. The G- prefix form must be tried first - its six
      // digits would otherwise match the plain-digit alternative.
      const value = kind === 'otp' ? (match.match(/G-\d{6}|\d{3}-\d{3}|\d{4,8}/)?.[0] ?? match) : match;
      if (!seen.has(value)) {
        seen.add(value);
        artifacts.push({ kind, value });
      }
      return artifactMarker(kind);
    });
  }
  return artifacts.length === 0 ? { text, artifacts: [] } : { text: redacted, artifacts };
};

// True when nothing meaningful survives the redaction - the whole message was the artifact.
export const onlyArtifacts = (q: Quarantine): boolean =>
  q.kinds.length > 0 && q.text.replace(/\[(?:quarantined): [^\]]+\]/g, '').trim() === '';
