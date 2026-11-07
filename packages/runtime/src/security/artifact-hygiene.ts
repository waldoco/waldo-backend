import { asciiDigits } from './decimal-digits.ts';

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
// A separator is a gap, or a hyphen or dash (fullwidth, non-breaking and minus included) with at most one space on each
// side ("482 - 913"). A dot, middle dot, bullet or katakana middle dot joins only two halves of three or four digits
// ("482.913"): between shorter groups it is a price ("12.50").
const GAP = String.raw`[ \n]`;
const DASH = String.raw`[-\u2010\u2011\u2013\u2014\u2212\uff0d]`;
const DOT = String.raw`[.\u00b7\u2022\u30fb]`;
const SEP = String.raw`(?: ?${DASH} ?|${GAP})`;
const HALVES_SEP = String.raw`(?: ?(?:${DASH}|${DOT}) ?|${GAP})`;
const EVEN = String.raw`\d{3}${HALVES_SEP}\d{3}|\d{4}${HALVES_SEP}\d{4}|\d{2}(?:${SEP}\d{2}){1,3}|\d(?:${SEP}\d){3,7}`;
const CODE = String.raw`(?<code>${EVEN}|(?=\d{1,4}${SEP}\d)\d(?:${SEP}?\d){3,7}|\d{4,8})(?!\d)`;
// Before "is your", nothing anchors where a code starts. An uneven split would reach back into digits ending the line
// before ("$12.99" then "092893 is your code" relayed 99092893), so only even splits and the plain run apply. A split
// starts at a word boundary, so it never takes digits from a token like "Acme2024"; a plain run may start right
// after a word ("Hello482913 is your code"). Digits joined by an invisible character are already one run, so
// "Acme2024\u200b5209" is taken whole.
const CODE_BEFORE = String.raw`(?<code>\b(?:${EVEN})|\d{4,8})(?!\d)`;
// Characters that render nothing: the soft hyphen, the combining grapheme joiner, zero-width spaces and joiners,
// direction marks, embeddings and isolates, the word joiner and invisible operators. They are dropped, so a keyword or
// a link they split reads whole. Between two digits outside a link they decide how the digits read: a run no longer
// than a code joins ("45­53­6­6"), so a short code is relayed with digits beside it ("4829​2026"); a longer run
// is split at them ("482913​2026").
// The Hangul filler and the musical format characters (U+1D173 to U+1D17A, a surrogate pair) render nothing as well.
const INVISIBLE = String.raw`(?:[\u00ad\u034f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\u3164]|\ud834[\udd73-\udd7a])`;
// It starts only where a digit run starts: tried from inside a long run, it backtracked quadratically.
const INVISIBLE_SPLIT_DIGITS = new RegExp(String.raw`(?<!\d)\d+(?:${INVISIBLE}+\d+)+`, 'g');
const INVISIBLE_ANYWHERE = new RegExp(`${INVISIBLE}+`, 'g');
const CODE_MAX_DIGITS = 8;
// The keyword may run straight into the code ("Verification code482913") when its table cell had no separator.
const KEYWORD_END = String.raw`(?![a-z])`;

// Between a keyword and its code: whitespace, then an optional "is" (itself optionally followed by ":" or "-"), ":"
// or "-", then an optional "#", each owning the whitespace after it. Adjacent optional whitespace runs backtracked
// cubically on a long run of spaces after a keyword; in this form every optional part starts with a literal, so it
// matches in one pass. A hyphen may be a minus sign ("error code -4821"); the digits are still taken as a code.
const LEAD = String.raw`\s*(?:is\s*(?:[:-]\s*)?|[:-]\s*)?(?:#\s*)?`;

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
  // A link that carries the code itself ("verify?code=482913") signs in with one click. Its host or path says so: a shop's
  // "product?code=4821" is a product code.
  { kind: 'magic_link', re: /^(?=https?:\/\/[^\s"'<>)\]?#]*(?:verif|log-?in|sign-?in|auth|confirm|activat|magic))https?:\/\/[^\s"'<>)\]]*[?&](?:code|otp|passcode|verification[-_]?code)=\d{4,8}(?![^&#])/i },
];

// The word right before a bare "code" that makes it something other than a one-time code ("promo code", "referral code").
// It never vetoes an OTP or passcode, or a code a one-time word names ("your gift card verification code"). A PIN code or
// a card's code is a credential, so neither word is here.
const OTHER_CODES = String.raw`(?:number|order|promo|promotional|discount|coupon|voucher|gift|referral|invite|tracking|reference|booking|dress|qr|bar|zip|area|post|postal|source|country|dial(?:ling)?)`;
// "Pincode", "Postcode", "Zip code", "Barcode", "Unicode" name a postal or product number, not a one-time code. "PIN code" is
// still taken: it can be a card's.
const COMPOUND_CODE = String.raw`(?<!(?:pin|post|zip|bar|uni)|\b(?:zip|postal?)\s)`;

// In this order. Google's SMS/mail prefix form keeps its prefix in the relay; "… is your code" comes before the
// keyword forms, which would otherwise take its noun and the digits after it ("482913 is your code\n13 10 2026").
const OTPS: readonly RegExp[] = [
  new RegExp(String.raw`\bG-\d{6}\b`, 'g'),
  // "123456 is your Google verification code", "123-456 is your WhatsApp code", "482913is your code". The code may
  // start right after a word ("Hello482913 is your code"), and the keyword may run into the next word.
  // A code in brackets or quotes, or with up to five words before its noun ("is your Acme Cloud Platform verification code").
  new RegExp(String.raw`(?<!\d)["'(\[\u201c\u2018]?` + CODE_BEFORE + String.raw`["')\]\u201d\u2019]?\s*is\s+your\s+(?:(?:[\w-]+\s){0,5}(?:otp|passcode)|(?:[\w-]+\s){0,4}(?!${OTHER_CODES}\s)[\w-]+\s+code|code)`, 'gi'),
  // "Your Google verification code is 123456", "login code: 123-456", "security code 123456".
  // Glue on either side of a word must not hide a code, since a table cell can end right against the next one:
  // the phrase starts at the adjective, even mid-word ("Xverification pin 123456"), and the noun may follow it
  // directly ("verificationcode"). Scanning a vendor word before the adjective also cost time on every word start.
  new RegExp(String.raw`(?:(?:verification|one[- ]?time|login|log[- ]?in|sign[- ]?in|security|authentication|confirmation|access)\s*(?:code|passcode|pin|otp)|one[- ]?time\s*password)` + KEYWORD_END + LEAD + CODE, 'gi'),
  // "code: 123456", "OTP: 123456", "passcode is 123456" - the bare form, no vendor adjective needed. It starts
  // mid-word too ("Enter thiscode: 482913"), except in a postal or product compound ("Pincode: 560001").
  new RegExp(String.raw`(?:${COMPOUND_CODE}code|otp|passcode)` + KEYWORD_END + LEAD + CODE, 'gi'),
];

// A code alone on its line (a table row of its own), on the line right after one that names a one-time code but shows none
// ("Use this code to sign in:", "Your verification code is below."); blank lines between them are already gone. A bracketed
// or dashed note may follow it ("482913 (expires in 10 minutes)"). Only wording that names a one-time code arms it: a promo,
// dress, QR or bar code, or "code" inside a word ("Barcode", "Unicode"), does not, nor a line that already shows its code
// ("Use this code at checkout: SAVE20"), or the price, year or time on the next line would be taken.
const STANDALONE_CODE = new RegExp(String.raw`^[ ("'\u201c]*(?<code>${EVEN}|\d{4,8})(?!\d)[ )"'.\u201d]*(?:(?:\(|${DASH} )[^\n]*)?$`);
const NAMES_CODE = new RegExp(String.raw`(?:\b(?:verification|one[- ]?time|login|log[- ]?in|sign[- ]?in|security|authentication|access)\s*(?:code|passcode|pin|otp)|\b(?:your|this|the\s+following)\s+(?:code|passcode|otp)|\bcode\s+below|\b(?:otp|passcode)|\bone[- ]?time\s*password)` + KEYWORD_END, 'i');
const MARKER_START = '[quarantined: ';
const SHOWS_CODE = /\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{4,}\b/;

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
  const folded = asciiDigits(text);
  const linked = folded.replace(INVISIBLE_ANYWHERE, (run: string, at: number) => digit(folded[at - 1]) && digit(folded[at + run.length]) ? run : '')
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
  let armed = false;
  redacted = redacted.split('\n').map((line) => {
    const code = armed ? STANDALONE_CODE.exec(line)?.groups?.code : undefined;
    armed = code === undefined && NAMES_CODE.test(line) && !line.includes(MARKER_START) && !SHOWS_CODE.test(line);
    return code === undefined ? line : line.replace(code, take('otp', code.replace(/\s/g, '')));
  }).join('\n');
  return artifacts.length === 0 ? { text, artifacts: [] } : { text: redacted, artifacts };
};

// True when nothing meaningful survives the redaction - the whole message was the artifact.
export const onlyArtifacts = (q: Quarantine): boolean =>
  q.kinds.length > 0 && q.text.replace(/\[(?:quarantined): [^\]]+\]/g, '').trim() === '';
