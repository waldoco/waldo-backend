// One presentation for every worker-rendered HTML page outside the dashboard app, drawn
// from the dashboard's own tokens: warm canvas, white tiles, hairlines, ink primary action.
// Presentation only. Callers keep their own headers, status codes, forms and security.

export const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const SPOTS = [
  'M12.0455 8.19435C8.5546 8.63273 6.68628 1.37044 10.4049 0.0167778C14.1721 -0.400611 15.7586 7.09811 12.0455 8.19435Z',
  'M8.3092 10.5135C6.58923 13.9893 -0.949651 11.5404 0.0997341 7.32816C2.00498 3.60923 9.58249 6.4543 8.3092 10.5135Z',
  'M16.2786 9.83065C13.9189 7.43667 17.1194 2.50187 20.161 4.61989C22.6742 7.23047 19.1635 12.07 16.2786 9.83065Z',
  'M17.6058 13.2603C18.102 11.0572 22.6427 11.375 22.6197 13.8989C22.0525 16.2652 17.4372 15.7294 17.6058 13.2603Z',
  'M14.9478 15.3381C16.0796 14.5281 18.5029 18.2428 17.5123 19.5964C16.2774 20.4397 13.8966 16.5483 14.9478 15.3381Z',
  'M12.4438 16.4828C13.658 16.5976 13.532 19.6799 12.1468 19.9149C10.8424 19.7685 11.0872 16.6145 12.4438 16.4828Z',
  'M8.14378 17.1963C7.28218 17.5051 6.42602 17.6249 5.54174 17.3248C4.67747 17.041 4.12053 16.212 4.48021 15.3153C4.77929 14.5697 5.47458 14.0913 6.18381 13.7831C9.6415 12.3095 11.8426 15.68 8.14378 17.1963Z',
];
const MARK = `<svg class="waldo-mark" width="18" height="16" viewBox="0 0 23 20" fill="currentColor" aria-hidden="true">${SPOTS.map((d) => `<path d="${d}"/>`).join('')}</svg>`;

export const STANDALONE_CSS = `:root{--font:-apple-system,BlinkMacSystemFont,'SF Pro Text','SF Pro',system-ui,'Segoe UI',sans-serif;--canvas:#f4f3f0;--tile:#fff;--on-ink:#fff;--ink:#1a1a1a;--t2:#6b6b68;--t3:#8a8985;--hair:rgba(26,26,26,.08);--hair-strong:rgba(26,26,26,.16);--fill:rgba(26,26,26,.04);--fill-2:rgba(26,26,26,.07);--action:#2388ff;--green-soft:rgba(34,197,94,.12);--red-soft:rgba(244,63,94,.1);--r-card:20px;--r-inner:12px;--medium:500;--semibold:600;font-family:var(--font);font-synthesis:none;color:var(--ink);background:var(--canvas)}
*{box-sizing:border-box}
[hidden]{display:none!important}
body{margin:0;background:var(--canvas);font-size:15px;line-height:1.45;-webkit-font-smoothing:antialiased;overflow-wrap:anywhere}
p{margin:0 0 10px;color:var(--t2)}
a{color:var(--ink);text-decoration:underline;text-decoration-color:var(--hair-strong);text-underline-offset:3px}
a:hover{text-decoration-color:var(--ink)}
:focus-visible{outline:2px solid var(--action);outline-offset:2px}
h1,h2,h3{color:var(--ink);margin:0}
h1{font-size:clamp(1.65rem,1.35rem + 1vw,2rem);font-weight:var(--semibold);letter-spacing:-.025em;line-height:1.15}
h2{font-size:15px;font-weight:var(--semibold);letter-spacing:-.01em;line-height:1.3;margin-bottom:8px}
h3{font-size:15px;font-weight:var(--medium);margin:0 0 4px}
strong{font-weight:var(--medium);color:var(--ink)}
.label,.meta,.help{font-size:12.5px;color:var(--t3)}
.skip-link{position:fixed;top:-100px;left:12px;padding:10px 16px;z-index:60;background:var(--tile);border-radius:999px;box-shadow:0 0 0 .5px var(--hair-strong)}
.skip-link:focus{top:12px}
.topbar{background:var(--canvas)}
.topbar-inner{display:flex;align-items:center;justify-content:space-between;gap:16px;max-width:960px;min-height:60px;margin:0 auto;padding:0 28px}
.brand{display:inline-flex;align-items:center;gap:8px;color:var(--ink);font-size:16px;font-weight:var(--medium);letter-spacing:-.01em;text-decoration:none}
.back-link{display:inline-flex;align-items:center;min-height:36px;font-size:13.5px;font-weight:var(--medium);color:var(--t2);text-decoration:none}
.back-link:hover{color:var(--ink)}
main{display:block;max-width:960px;margin:0 auto;padding:0 28px 24px}
footer{max-width:960px;margin:0 auto;padding:24px 28px 48px}
footer p{font-size:12px;color:var(--t3);margin:0}
.page-heading{padding:32px 0 24px;max-width:44rem}
.page-heading .label{display:block;margin-bottom:8px}
.page-heading p{margin:10px 0 0;max-width:56ch}
.tile{background:var(--tile);border-radius:var(--r-card);box-shadow:0 0 0 .5px var(--hair);padding:20px;margin:0 0 12px;min-width:0}
.tile>:last-child{margin-bottom:0}
.section-title{margin:24px 0 10px}
button,.button-link{font:inherit;font-size:14px;font-weight:var(--medium);line-height:1.2;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:38px;padding:9px 18px;border:0;border-radius:999px;text-decoration:none;background:var(--fill-2);color:var(--ink)}
button:hover:not(:disabled){background:rgba(26,26,26,.11)}
button.primary,.button-link{background:var(--ink);color:var(--on-ink)}
button.primary:hover:not(:disabled),.button-link:hover{background:#333331}
button.danger{background:var(--red-soft);color:#be123c}
button.danger:hover:not(:disabled){background:rgba(244,63,94,.16)}
button:disabled{opacity:.4;cursor:not-allowed}
form{margin:0}
.stack{display:grid;gap:12px}
label{display:grid;gap:6px;font-size:12.5px;color:var(--t3);min-width:0}
input,select{font:inherit;font-size:14.5px;color:var(--ink);min-height:38px;padding:7px 12px;border:0;border-radius:10px;background:var(--fill);box-shadow:inset 0 0 0 .5px var(--hair-strong);width:100%;max-width:100%;min-width:0}
input[type=file]{padding:8px 12px}
input:focus,select:focus{box-shadow:inset 0 0 0 1px var(--ink)}
.fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
.actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:14px 0 0}
.chip{display:inline-flex;align-items:center;gap:6px;flex:none;font-size:12px;font-weight:var(--medium);line-height:1;color:var(--t2);background:var(--fill-2);border-radius:999px;padding:6px 10px;white-space:nowrap}
.chip.positive{color:#15803d;background:var(--green-soft)}
.chip.negative{color:#be123c;background:var(--red-soft)}
.chips{display:flex;gap:6px;flex-wrap:wrap;list-style:none;padding:0;margin:0}
.count{display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:20px;padding:0 6px;border-radius:999px;background:var(--fill-2);font-size:11.5px;font-weight:var(--medium);color:var(--t2);font-variant-numeric:tabular-nums}
.row-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 12px}
.row-head h2,.row-head h3{margin:0;min-width:0}
.facts{display:grid;grid-template-columns:110px minmax(0,1fr);gap:8px 16px;margin:0;font-size:14px}
.facts dt{font-size:12.5px;color:var(--t3);padding-top:1px}
.facts dd{margin:0;color:var(--ink);min-width:0}
.records{list-style:none;margin:0;padding:0}
.records>li{padding:14px 0;border-top:.5px solid var(--hair)}
.records>li:first-child{border-top:0;padding-top:4px}
.records>li:last-child{padding-bottom:0}
.inset{padding:14px 16px;background:var(--canvas);border-radius:var(--r-inner);margin:14px 0 0}
.inset>:last-child{margin-bottom:0}
.notice{background:var(--fill-2);border-radius:var(--r-inner);padding:12px 16px;margin:0 0 14px;font-size:13.5px;color:var(--ink)}
.notice.alert{background:var(--red-soft)}
.secret{display:block;padding:14px 16px;background:var(--canvas);border-radius:var(--r-inner);box-shadow:inset 0 0 0 .5px var(--hair-strong);font:500 15px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink);overflow-wrap:anywhere;user-select:all;margin:0 0 14px}
.empty{color:var(--t2);margin:0}
.time{font-variant-numeric:tabular-nums}
.card main{max-width:440px;padding-top:24px}
.card main.tile{margin:24px auto;padding:28px 24px}
.card .card-body{padding:28px 24px}
.card h1{font-size:1.5rem;margin-bottom:10px}
.card form{display:grid;gap:12px}
.card form+form,.card form+p,.card p+form{margin-top:14px}
.card form button{width:100%}
.card input{font-size:16px;min-height:44px}
.card label{font-size:13px;color:var(--t2)}
.card ol{padding-left:20px;margin:0 0 12px;color:var(--t2)}
.status-mark{display:grid;place-items:center;width:36px;height:36px;border-radius:50%;margin:0 0 14px;background:var(--fill-2);color:var(--t2);font-weight:var(--semibold)}
.status-mark.positive{background:var(--green-soft);color:#15803d}
.status-mark.negative{background:var(--red-soft);color:#be123c}
.reading main{max-width:760px}
.reading article{font-size:16px;line-height:1.6;color:var(--ink)}
.reading article h2{font-size:1.2rem;margin:28px 0 8px}
.reading article h3,.reading article h4,.reading article h5,.reading article h6{font-size:1rem;font-weight:var(--semibold);margin:22px 0 6px}
.reading article p{margin:0 0 12px;color:var(--ink)}
.reading article ul{padding-left:22px;margin:0 0 12px}
.reading article li{margin:4px 0}
.reading article pre{margin:0 0 12px;padding:14px 16px;background:var(--canvas);border-radius:var(--r-inner);font:13.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
.reading article code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.92em;background:var(--fill-2);border-radius:5px;padding:1px 4px}
.reading article pre code{background:none;padding:0;font-size:inherit}
.reading article>:first-child{margin-top:0}
.viewer{display:block;width:100%;height:min(78vh,860px);min-height:420px;border:0;border-radius:var(--r-inner);background:var(--canvas);box-shadow:inset 0 0 0 .5px var(--hair-strong);margin:0 0 14px}
@media(max-width:860px){.topbar-inner,main,footer{padding-left:22px;padding-right:22px}}
@media(max-width:640px){
body{font-size:15.5px}
.topbar-inner{min-height:54px;padding:0 16px}
main,footer{padding-left:16px;padding-right:16px}
.page-heading{padding:20px 0 18px}
.tile{padding:18px 16px}
.card main.tile{margin:8px 16px 24px;padding:24px 18px}
.card .card-body{padding:24px 18px}
.card main{padding-top:8px}
button,.button-link{min-height:44px}
input,select{min-height:44px}
.facts{grid-template-columns:1fr;gap:2px}
.facts dd{margin-bottom:10px}
.actions{flex-direction:column;align-items:stretch}
.actions button,.actions .button-link,.actions form{width:100%}
.actions form button{width:100%}
.row-head{flex-wrap:wrap}
.viewer{height:70vh;min-height:360px}
}
@media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}`;

type Layout = 'utility' | 'card' | 'reading';
type PageInput = Readonly<{
  title: string;
  body: string;
  layout?: Layout;
  // Signed-in pages link home; sign-in and public result pages do not pretend to a session.
  home?: boolean;
  back?: Readonly<{ href: string; label: string }> | null;
  footer?: string;
  nonce?: string;
  robots?: string;
  // Attributes for <main>, such as a class.
  main?: string;
  tail?: string;
}>;

// Returns a complete HTML document. Every interpolated value in `body` must already be escaped.
export const standalonePage = ({ title, body, layout = 'utility', home = layout !== 'card', back, footer, nonce, robots = 'noindex', main = '', tail = '' }: PageInput): string => {
  const brand = home ? `<a class="brand" href="/console" aria-label="Waldo dashboard home">${MARK}<span aria-hidden="true">Waldo</span></a>` : `<span class="brand">${MARK}<span>Waldo</span></span>`;
  const backLink = back === undefined ? (home ? `<a class="back-link" href="/console">Back to dashboard</a>` : '') : back ? `<a class="back-link" href="${escapeHtml(back.href)}">${escapeHtml(back.label)}</a>` : '';
  const style = nonce ? `<style nonce="${escapeHtml(nonce)}">` : '<style>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="${escapeHtml(robots)}"><title>${escapeHtml(title)}</title>${style}${STANDALONE_CSS}</style></head><body class="${layout}">${layout === 'card' ? '' : '<a class="skip-link" href="#main">Skip to content</a>'}<header class="topbar"><div class="topbar-inner">${brand}${backLink}</div></header><main id="main"${main ? ` ${main}` : ''}>${body}</main>${footer ? `<footer><p>${footer}</p></footer>` : ''}${tail}</body></html>`;
};

export const pageHeading = (title: string, lede = '', label = ''): string =>
  `<div class="page-heading">${label ? `<span class="label">${escapeHtml(label)}</span>` : ''}<h1>${escapeHtml(title)}</h1>${lede ? `<p>${escapeHtml(lede)}</p>` : ''}</div>`;

export type Tone = 'neutral' | 'positive' | 'negative';
// A short outcome card: a mark, a title, honest copy and the actions that follow.
export const resultCard = (input: Readonly<{ tone?: Tone; title: string; body: string; actions?: string; alert?: boolean }>): string => {
  const tone = input.tone ?? 'neutral';
  const mark = tone === 'positive' ? '&#10003;' : tone === 'negative' ? '!' : 'i';
  return `<section class="tile card-body" role="${input.alert ?? tone === 'negative' ? 'alert' : 'status'}"><div class="status-mark ${tone}" aria-hidden="true">${mark}</div><h1>${escapeHtml(input.title)}</h1>${input.body}${input.actions ? `<div class="actions">${input.actions}</div>` : ''}</section>`;
};

// ISO timestamps read as "2026-10-11 10:00 UTC"; anything unparseable stays literal.
export const isoMinute = (value: string | null | undefined, empty = 'Never'): string => {
  if (!value) return empty;
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return value;
  return `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
};

export const HTML_PAGE_HEADERS = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' } as const;

// Browser navigations ask for HTML; fetch/API callers ask for JSON or nothing. Only the former get a styled page.
export const wantsHtml = (accept: string | null): boolean => (accept ?? '').toLowerCase().includes('text/html');
