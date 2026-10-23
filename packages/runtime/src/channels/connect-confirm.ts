// The stop on a bearer connect link (a chat's /c/<ticket>, the app's WHOOP start link) before it hands the browser to the
// provider. Anyone holding the link can open it, so a forwarded link would put the opener's account in the sender's
// Waldo: the page names whose Waldo the account joins, by a masked hint only, and the browser goes on only when the
// person presses Continue. Continue is a same-origin POST, so a link unfurler or prefetcher that GETs the link never
// redirects, binds or spends the ticket.
const escape = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

// The directory masks the owner's email; anything that is not that exact shape is dropped rather than shown, so a full
// address never reaches the page even if the mask were lost upstream.
const MASKED = /^[^\s@]•••@[^\s@]{1,253}$/u;
export const ownerHint = (value: unknown): string | null => (typeof value === 'string' && MASKED.test(value) ? value : null);

// A cross-site form or script cannot trigger Continue: browsers name the submitting page's origin on a form POST. The
// page's referrer policy is same-origin, not no-referrer, because no-referrer makes browsers send Origin: null.
export const confirmedHere = (request: Request): boolean => request.method === 'POST' && request.headers.get('origin') === new URL(request.url).origin;

// form-action also names the provider's origin: browsers apply it to the redirect a submitted form follows.
export const confirmPage = (input: Readonly<{ provider: string; providerOrigin: string; hint: string | null; cancel: string }>): Response => {
  const whose = input.hint ? `the Waldo of <strong>${escape(input.hint)}</strong>` : 'the Waldo that sent this link';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect ${escape(input.provider)} - Waldo</title>
<style>:root{color-scheme:light dark;--bg:#f7f7f5;--card:#fff;--ink:#1c1c1a;--muted:#6b6b66;--btn:#2a6fdb}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1f1f1d;--ink:#ecece8;--muted:#a3a39c;--btn:#5b93f0}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,sans-serif}
main{box-sizing:border-box;width:min(420px,calc(100vw - 32px));background:var(--card);border-radius:16px;padding:32px 24px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.08)}
h1{font-size:22px;margin:0 0 8px}p{margin:0 0 16px;color:var(--muted)}strong{color:var(--ink)}form{margin:0}
.button{display:inline-block;margin-top:8px;padding:12px 20px;border:0;border-radius:10px;background:var(--btn);color:#fff;text-decoration:none;font:inherit;font-weight:bold;cursor:pointer}.cancel{display:inline-block;margin-top:16px;color:var(--muted)}</style></head>
<body><main><h1>Connect ${escape(input.provider)}?</h1><p>This connects your ${escape(input.provider)} account to ${whose}.</p><p>Continue only if that is your Waldo. If someone sent you this link, cancel: continuing would give their Waldo your ${escape(input.provider)} data.</p>
<form method="post"><button class="button" type="submit">Continue to ${escape(input.provider)}</button></form><a class="cancel" href="${escape(input.cancel)}">Cancel</a></main></body></html>`;
  return new Response(html, { status: 200, headers: {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'same-origin',
    'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' ${input.providerOrigin}`,
  } });
};
