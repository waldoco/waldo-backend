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

// A code is 4-8 digits only. Mail laid out in table cells renders it split by whitespace or a hyphen, in groups of
// any size. The even splits come first, so they relay exactly; after a keyword, then any split whose first group
// has at most four digits, joined up to eight; then the plain run. So "1234 5678" is never cut to "1234", and
// "482913 10" stays "482913". A code ends where no digit follows, so text glued after it ("482913Expires") never
// hides it. Alphanumeric order/tracking ids never match.
// Extraction first turns each whitespace run into one space or one newline, so a gap is one character. A gap may be
// a newline, so a code can join digits that start the next row: the code stays hidden and the relay carries them.
const GAP = String.raw`[ \n]`;
const SEP = String.raw`(?:-|${GAP})`;
const EVEN = String.raw`\d{3}${SEP}\d{3}|\d{4}${SEP}\d{4}|\d{2}(?:${GAP}\d{2}){1,3}|\d(?:${GAP}\d){3,7}`;
const CODE = String.raw`(?<code>${EVEN}|(?=\d{1,4}${SEP}\d)\d(?:${SEP}?\d){3,7}|\d{4,8})(?!\d)`;
// Before "is your", nothing anchors where a code starts, and an uneven split would reach back into digits ending the
// line before ("$12.99" then "092893 is your code" relayed 99092893). Even splits and the plain run only.
const CODE_BEFORE = String.raw`(?<code>${EVEN}|\d{4,8})(?!\d)`;
// The keyword may run straight into the code ("Verification code482913") when its table cell had no separator.
const KEYWORD_END = String.raw`(?![a-z])`;

// Between a keyword and its code: whitespace, then an optional "is", ":" or "-", then an optional "#", each
// owning the whitespace after it. Three adjacent optional whitespace runs backtracked cubically on a long run of
// spaces after a keyword; this form matches the same text in one pass.
const LEAD = String.raw`\s*(?:(?:is|:|-)\s*)?(?:#\s*)?`;
const BARE_LEAD = String.raw`\s*(?:(?:is|:)\s*)?(?:#\s*)?`;

// URL boundary: stop at whitespace or the punctuation that commonly wraps a pasted link.
const URL_TAIL = String.raw`[^\s"'<>)\]]*`;

// A link artifact is a whole URL run: from its first "http(s)://" to the URL boundary. Each link pattern is
// tested once per run, anchored at its start. Tried from every "https://" inside one long run, the patterns
// backtracked quadratically; a run matches from its first start whenever it matches from a later one.
const URL_RUN = new RegExp(String.raw`https?://${URL_TAIL}`, 'gi');
const LINKS: ReadonlyArray<{ kind: Exclude<ArtifactKind, 'otp'>; re: RegExp }> = [
  // Supabase (and lookalike) token endpoints carry the live bearer in the query string.
  { kind: 'magic_link', re: /^https?:\/\/[^\s"'<>)\]]*\/auth\/v\d+\/verify/i },
  // recovery is the password-reset artifact; it runs before the generic token patterns so a
  // recovery URL is labeled (and logged) as what it is.
  { kind: 'password_reset', re: /^https?:\/\/[^\s"'<>)\]]*[?&]type=recovery/i },
  { kind: 'magic_link', re: /^https?:\/\/[^\s"'<>)\]]*[?&]type=(?:magiclink|signup|email_change|invite)/i },
  { kind: 'magic_link', re: /^https?:\/\/[^\s"'<>)\]]*[?&]token_hash=/i },
  { kind: 'password_reset', re: /^https?:\/\/[^\s"'<>)\]]*(?:\/reset[-_]?password|\/password[-_]?reset|reset[-_]?token=|confirmation[-_]?token=)/i },
];

const OTPS: readonly RegExp[] = [
  // "Your Google verification code is 123456", "login code: 123-456", "security code 123456".
  // The phrase starts at the adjective, even mid-word: text glued onto it ("Xverification pin 123456") must not
  // hide the code, and scanning a vendor word before it cost time on every word start.
  new RegExp(String.raw`(?:verification|one[- ]?time|login|log[- ]?in|sign[- ]?in|security|authentication|confirmation|access)\s+(?:code|passcode|pin|otp)` + KEYWORD_END + LEAD + CODE, 'gi'),
  // "code: 123456", "OTP: 123456", "passcode is 123456" - the bare form, no vendor adjective needed.
  new RegExp(String.raw`\b(?:code|otp|passcode)` + KEYWORD_END + BARE_LEAD + CODE, 'gi'),
  // Google's SMS/mail prefix form runs first: "G-123456 is your Google verification code" would
  // otherwise lose its prefix to the generic "is your" pattern below before extraction sees it.
  new RegExp(String.raw`\bG-\d{6}\b`, 'g'),
  // "123456 is your Google verification code", "123-456 is your WhatsApp code", "482913is your code".
  new RegExp(String.raw`\b` + CODE_BEFORE + String.raw`\s*is\s+your\s+(?:[\w-]+\s){0,3}(?:code|passcode|otp)\b`, 'gi'),
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
  const seen = new Set<string>();
  const artifacts: ExtractedArtifact[] = [];
  const take = (kind: ArtifactKind, value: string): string => {
    if (!seen.has(value)) {
      seen.add(value);
      artifacts.push({ kind, value });
    }
    return artifactMarker(kind);
  };
  // Invisible characters go first: zero-width spaces and joiners, the word joiner and the soft hyphen split a code
  // without showing. Then each whitespace run becomes one character: a newline if it breaks a line, else a space.
  // That bounds every gap a code can be split by, whatever the source formatting. Text with no artifact comes back
  // untouched.
  const normalized = text.replace(/[\u00ad\u200b-\u200d\u2060]/g, '').replace(/\s+/g, (run) => (/[\n\r\u2028\u2029]/.test(run) ? '\n' : ' '));
  // Links relay whole; the first matching kind names the run.
  let redacted = normalized.replace(URL_RUN, (url) => {
    const link = LINKS.find(({ re }) => re.test(url));
    return link ? take(link.kind, url) : url;
  });
  for (const re of OTPS) {
    // OTP patterns match the surrounding phrase ("Your login code is 123456"); the relay value is the code itself,
    // from its own capture, never a digit elsewhere in the phrase. The G- prefix form relays whole.
    redacted = redacted.replace(re, (match: string, ...rest: unknown[]) => {
      const groups = rest.at(-1);
      const code = typeof groups === 'object' && groups !== null ? (groups as Record<string, string | undefined>).code : undefined;
      return take('otp', code === undefined ? match : code.replace(/\s/g, ''));
    });
  }
  return artifacts.length === 0 ? { text, artifacts: [] } : { text: redacted, artifacts };
};

// True when nothing meaningful survives the redaction - the whole message was the artifact.
export const onlyArtifacts = (q: Quarantine): boolean =>
  q.kinds.length > 0 && q.text.replace(/\[(?:quarantined): [^\]]+\]/g, '').trim() === '';
