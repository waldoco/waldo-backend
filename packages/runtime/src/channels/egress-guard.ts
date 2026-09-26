// Egress guard (CONNECT_FLOW_DESIGN S1, hard security line): secret-bearing URLs never leave
// in model-authored text and never get persisted. Deterministic and NARROW by design - only
// provider-OAuth URLs, first-party connect tickets, our callbacks, and URLs carrying
// state/code/code_challenge. Ordinary links the owner shares are untouched.
const PATTERNS: readonly RegExp[] = [
  /https?:\/\/accounts\.google\.com\/o\/oauth2[^\s)"'<>]*/gi,
  /https?:\/\/[^\s)"'<>]*\/c\/[A-Za-z0-9_-]{22}(?![A-Za-z0-9_-])[^\s)"'<>]*/g,
  /https?:\/\/[^\s)"'<>]*\/c\/\?t=[A-Za-z0-9_-]{22}(?![A-Za-z0-9_-])[^\s)"'<>]*/g,
  /https?:\/\/[^\s)"'<>]*\/oauth\/[^\s)"'<>\/]*\/callback[^\s)"'<>]*/gi,
  /https?:\/\/[^\s)"'<>]*[?&](?:state|code|code_challenge)=[^\s)"'<>]*/gi,
];

export const redactSecretUrls = (text: string): { text: string; count: number } => {
  let count = 0;
  let out = text;
  for (const pattern of PATTERNS) {
    out = out.replace(pattern, () => {
      count += 1;
      return '[link removed]';
    });
  }
  return { text: out, count };
};

type Caller = (method: string, body: object) => Promise<unknown>;

// Wraps the Telegram caller: text-bearing sends are scrubbed before they leave.
export const egressGuardedCaller = (call: Caller, onRedact: (count: number, method: string) => void): Caller =>
  async (method, body) => {
    const b = body as Record<string, unknown>;
    if ((method === 'sendMessage' || method === 'editMessageText') && typeof b.text === 'string') {
      const { text, count } = redactSecretUrls(b.text);
      if (count > 0) {
        onRedact(count, method);
        return call(method, { ...b, text });
      }
    }
    return call(method, body);
  };
