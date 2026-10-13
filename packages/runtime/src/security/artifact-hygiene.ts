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
// hides it. Digits after a keyword, or before "is your … code", are taken as a code whatever they are: catching a
// code comes before relaying it accurately, so an id or a date there is quarantined too.
// Extraction first turns each whitespace run into one space or one newline, so a gap is one character. A gap may be
// a newline, so a code can join digits that start the next row: the code stays hidden and the relay carries them.
const GAP = String.raw`[ \n]`;
const SEP = String.raw`(?:-|${GAP})`;
const EVEN = String.raw`\d{3}${SEP}\d{3}|\d{4}${SEP}\d{4}|\d{2}(?:${GAP}\d{2}){1,3}|\d(?:${GAP}\d){3,7}`;
const CODE = String.raw`(?<code>${EVEN}|(?=\d{1,4}${SEP}\d)\d(?:${SEP}?\d){3,7}|\d{4,8})(?!\d)`;
// Before "is your", nothing anchors where a code starts. An uneven split would reach back into digits ending the line
// before ("$12.99" then "092893 is your code" relayed 99092893), so only even splits and the plain run apply. A split
// starts at a word boundary, so it never takes digits from a token like "Acme2024"; a plain run may start right
// after a word ("Hello482913 is your code").
const CODE_BEFORE = String.raw`(?<code>\b(?:${EVEN})|\d{4,8})(?!\d)`;
// Characters that render nothing: the soft hyphen, the combining grapheme joiner, zero-width spaces and joiners,
// direction marks, embeddings and isolates, the word joiner and invisible operators. They are dropped, so a keyword or
// a link they split reads whole. Between two digits outside a link they decide how the digits read: a run no longer
// than a code joins ("45­53­6­6"), so a short code is relayed with digits beside it ("4829​2026"); a longer run
// is split at them ("482913​2026").
const INVISIBLE = String.raw`[\u00ad\u034f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069]`;
// It starts only where a digit run starts: tried from inside a long run, it backtracked quadratically.
const INVISIBLE_SPLIT_DIGITS = new RegExp(String.raw`(?<!\d)\d+(?:${INVISIBLE}+\d+)+`, 'g');
const INVISIBLE_ANYWHERE = new RegExp(`${INVISIBLE}+`, 'g');
const CODE_MAX_DIGITS = 8;
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

// In this order. Google's SMS/mail prefix form keeps its prefix in the relay; "… is your code" comes before the
// keyword forms, which would otherwise take its noun and the digits after it ("482913 is your code\n13 10 2026").
const OTPS: readonly RegExp[] = [
  new RegExp(String.raw`\bG-\d{6}\b`, 'g'),
  // "123456 is your Google verification code", "123-456 is your WhatsApp code", "482913is your code". The code may
  // start right after a word ("Hello482913 is your code"), and the keyword may run into the next word.
  new RegExp(String.raw`(?<!\d)` + CODE_BEFORE + String.raw`\s*is\s+your\s+(?:[\w-]+\s){0,3}(?:code|passcode|otp)`, 'gi'),
  // "Your Google verification code is 123456", "login code: 123-456", "security code 123456".
  // Glue on either side of a word must not hide a code, since a table cell can end right against the next one:
  // the phrase starts at the adjective, even mid-word ("Xverification pin 123456"), and the noun may follow it
  // directly ("verificationcode"). Scanning a vendor word before the adjective also cost time on every word start.
  new RegExp(String.raw`(?:verification|one[- ]?time|login|log[- ]?in|sign[- ]?in|security|authentication|confirmation|access)\s*(?:code|passcode|pin|otp)` + KEYWORD_END + LEAD + CODE, 'gi'),
  // "code: 123456", "OTP: 123456", "passcode is 123456" - the bare form, no vendor adjective needed. It starts
  // mid-word too ("Enter thiscode: 482913"), so a postcode or barcode followed by digits is quarantined as well.
  new RegExp(String.raw`(?:code|otp|passcode)` + KEYWORD_END + BARE_LEAD + CODE, 'gi'),
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
  // Invisible characters go first, except between two digits. Links come next and lose the rest of theirs, so a link
  // is whole before any digits are split. Then digits joined by invisible characters are joined or split, and each
  // whitespace run becomes one character: a newline if it breaks a line, else a space. That bounds every gap a code
  // can be split by, whatever the source formatting. Text with no artifact comes back untouched.
  const digit = (char: string | undefined) => char !== undefined && char >= '0' && char <= '9';
  const linked = text.replace(INVISIBLE_ANYWHERE, (run: string, at: number) => digit(text[at - 1]) && digit(text[at + run.length]) ? run : '')
    .replace(URL_RUN, (run) => {
      // The first matching kind names the link, which relays whole.
      const url = run.replace(INVISIBLE_ANYWHERE, '');
      const link = LINKS.find(({ re }) => re.test(url));
      return link ? take(link.kind, url) : url;
    });
  let redacted = linked.replace(INVISIBLE_SPLIT_DIGITS, (run) => run.replace(INVISIBLE_ANYWHERE, run.replace(INVISIBLE_ANYWHERE, '').length > CODE_MAX_DIGITS ? ' ' : ''))
    .replace(/\s+/g, (run) => (/[\n\r\u2028\u2029]/.test(run) ? '\n' : ' '));
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
