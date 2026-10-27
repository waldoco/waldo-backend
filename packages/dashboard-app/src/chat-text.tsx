import { useMemo, type ReactNode } from 'react';
import { wordReveal, type Reveal, type RevealMode } from './chat-reveal';

// The Markdown Waldo's replies use, drawn as React elements: never as HTML, so a reply cannot inject markup.
// Paragraphs, line breaks, lists, quotes, headings as strong lines, fenced and inline code, bold, italic and
// http(s) links. Anything else stays as the literal characters Waldo wrote.
const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+?\*\*)|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|(\*[^*\s][^*\n]*?\*)|(_[^_\s][^_\n]*?_)/g;

const anchor = (url: string, label: ReactNode, key: string) => <a key={key} href={url} target="_blank" rel="noopener noreferrer">{label}</a>;
// The text inside a delimiter of `edge` characters on each side.
const inside = (text: string, edge: number) => text.slice(edge, text.length - edge);

// The words drawn so far, counted in drawing order, and which of them are still fading in (chat-reveal.ts).
type Words = { n: number; reveal?: Reveal };
const fading = (node: ReactNode, n: number, delay: number) => <span key={`w${n}`} className="word-in" style={{ animationDelay: `${delay}ms` }}>{node}</span>;

// A run of plain text: a word still fading is its own span, the rest stays one string.
function words(text: string, w: Words): ReactNode[] {
  const out: ReactNode[] = [];
  let plain = '';
  for (const token of text.split(/(\s+)/)) {
    if (!token) continue;
    if (/^\s/.test(token)) { plain += token; continue; }
    const delay = w.reveal?.(w.n) ?? null;
    if (delay === null) plain += token;
    else { if (plain) out.push(plain); plain = ''; out.push(fading(token, w.n, delay)); }
    w.n += 1;
  }
  if (plain) out.push(plain);
  return out;
}
// Something drawn whole (inline code, a link, a code block) counts as one word.
function unit(node: ReactNode, w: Words): ReactNode {
  const delay = w.reveal?.(w.n) ?? null;
  const n = w.n++;
  return delay === null ? node : fading(node, n, delay);
}

export function inline(text: string, key = 'i', w: Words = { n: 0 }): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0, n = 0;
  for (const match of text.matchAll(INLINE)) {
    const start = match.index ?? 0;
    if (start > at) out.push(...words(text.slice(at, start), w));
    const [whole, code, bold, label, url, bare, star, under] = match;
    const k = `${key}-${n++}`;
    if (code) out.push(unit(<code key={k}>{inside(code, 1)}</code>, w));
    else if (bold) out.push(<strong key={k}>{inline(inside(bold, 2), k, w)}</strong>);
    else if (label && url) out.push(unit(anchor(url, label, k), w));
    else if (bare) out.push(unit(anchor(bare, bare, k), w));
    else if (star || under) out.push(<em key={k}>{words(inside((star ?? under)!, 1), w)}</em>);
    else out.push(...words(whole, w));
    at = start + whole.length;
  }
  if (at < text.length) out.push(...words(text.slice(at), w));
  return out;
}

const lines = (text: string, key: string, w: Words) => text.split('\n').flatMap((line, i) => i === 0 ? inline(line, `${key}-${i}`, w) : [<br key={`${key}-br${i}`}/>, ...inline(line, `${key}-${i}`, w)]);
const BULLET = /^\s*[-*•]\s+/, NUMBER = /^\s*\d{1,3}[.)]\s+/;

function block(chunk: string, key: string, w: Words): ReactNode {
  const rows = chunk.split('\n');
  if (rows.every(row => BULLET.test(row))) return <ul key={key}>{rows.map((row, i) => <li key={i}>{inline(row.replace(BULLET, ''), `${key}-${i}`, w)}</li>)}</ul>;
  if (rows.every(row => NUMBER.test(row))) return <ol key={key} start={Number(/\d+/.exec(rows[0]!)![0])}>{rows.map((row, i) => <li key={i}>{inline(row.replace(NUMBER, ''), `${key}-${i}`, w)}</li>)}</ol>;
  if (rows.every(row => /^\s*>/.test(row))) return <blockquote key={key}>{lines(rows.map(row => row.replace(/^\s*>\s?/, '')).join('\n'), key, w)}</blockquote>;
  const heading = /^#{1,6}\s+(.+)$/.exec(chunk.trim());
  if (heading && rows.length === 1) return <p key={key} className="chat-heading-line"><strong>{inline(heading[1]!, key, w)}</strong></p>;
  return <p key={key}>{lines(chunk, key, w)}</p>;
}

function draw(text: string, w: Words): ReactNode[] {
  const out: ReactNode[] = [];
  const fence = /```[^\n]*\n([\s\S]*?)(?:```|$)/g;
  let at = 0, n = 0;
  const prose = (part: string) => { for (const chunk of part.split(/\n\s*\n/)) if (chunk.trim()) out.push(block(chunk.replace(/^\n+|\n+$/g, ''), `b${n++}`, w)); };
  for (const match of text.matchAll(fence)) {
    prose(text.slice(at, match.index));
    out.push(unit(<pre key={`b${n++}`}><code>{match[1]!.replace(/\n$/, '')}</code></pre>, w));
    at = (match.index ?? 0) + match[0].length;
  }
  prose(text.slice(at));
  return out;
}

const wordCount = (text: string) => { const w: Words = { n: 0 }; draw(text, w); return w.n; };

// `reveal` draws a reply as it is written: the words that just arrived fade in (chat-reveal.ts).
export function ChatText({ text, reveal: mode }: { text: string; reveal?: RevealMode }) {
  const streaming = !!mode;
  const count = useMemo(() => (streaming ? wordCount(text) : 0), [text, streaming]);
  const reveal = wordReveal(text, count, mode, wordCount);
  return <>{draw(text, { n: 0, reveal })}</>;
}
