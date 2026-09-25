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
  // "your code is 123456", "OTP: 123456" - the bare form, no vendor adjective needed.
  { kind: 'otp', re: new RegExp(String.raw`\b(?:code|otp|passcode)\b\s*(?:is|:)?\s*#?\s*` + CODE + String.raw`\b`, 'gi') },
  // "123456 is your Google verification code", "123-456 is your WhatsApp code".
  { kind: 'otp', re: new RegExp(String.raw`\b` + CODE + String.raw`\s+is\s+your\s+(?:[\w-]+\s){0,3}(?:code|passcode|otp)\b`, 'gi') },
  // Google's SMS/mail prefix form: "G-123456 is your Google verification code".
  { kind: 'otp', re: new RegExp(String.raw`\bG-\d{6}\b`, 'g') },
];

// Replace every artifact match with a typed marker. Returns the redacted text plus the distinct
// kinds found; an empty kinds array means the text passed through untouched (same string identity).
export const quarantineArtifacts = (text: string): Quarantine => {
  let redacted = text;
  const kinds = new Set<ArtifactKind>();
  for (const { kind, re } of PATTERNS) {
    redacted = redacted.replace(re, () => {
      kinds.add(kind);
      return artifactMarker(kind);
    });
  }
  return kinds.size === 0 ? { text, kinds: [] } : { text: redacted, kinds: [...kinds].sort() };
};

// True when nothing meaningful survives the redaction - the whole message was the artifact.
export const onlyArtifacts = (q: Quarantine): boolean =>
  q.kinds.length > 0 && q.text.replace(/\[(?:quarantined): [^\]]+\]/g, '').trim() === '';
