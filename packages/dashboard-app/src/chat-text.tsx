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
const fading = (node: ReactNode, n: number) => <span key={`w${n}`} className="word-in">{node}</span>;

// A run of plain text: a word still fading is its own span, the rest stays one string.
function words(text: string, w: Words): ReactNode[] {
  const out: ReactNode[] = [];
  let plain = '';
  for (const token of text.split(/(\s+)/)) {
    if (!token) continue;
    if (/^\s/.test(token)) { plain += token; continue; }
    if (!w.reveal?.(w.n)) plain += token;
    else { if (plain) out.push(plain); plain = ''; out.push(fading(token, w.n)); }
    w.n += 1;
  }
  if (plain) out.push(plain);
  return out;
}
// Something drawn whole (inline code, a link, a code block) counts as one word.
function unit(node: ReactNode, w: Words): ReactNode {
  const n = w.n++;
  return w.reveal?.(n) ? fading(node, n) : node;
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

// `tail` is drawn after the block's last word, in its line: the caret while the reply is being written.
function block(chunk: string, key: string, w: Words, tail?: ReactNode): ReactNode {
  const rows = chunk.split('\n');
  const item = (row: string, i: number) => <li key={i}>{inline(row, `${key}-${i}`, w)}{i === rows.length - 1 && tail}</li>;
  if (rows.every(row => BULLET.test(row))) return <ul key={key}>{rows.map((row, i) => item(row.replace(BULLET, ''), i))}</ul>;
  if (rows.every(row => NUMBER.test(row))) return <ol key={key} start={Number(/\d+/.exec(rows[0]!)![0])}>{rows.map((row, i) => item(row.replace(NUMBER, ''), i))}</ol>;
  if (rows.every(row => /^\s*>/.test(row))) return <blockquote key={key}>{lines(rows.map(row => row.replace(/^\s*>\s?/, '')).join('\n'), key, w)}{tail}</blockquote>;
  const heading = /^#{1,6}\s+(.+)$/.exec(chunk.trim());
  if (heading && rows.length === 1) return <p key={key} className="chat-heading-line"><strong>{inline(heading[1]!, key, w)}</strong>{tail}</p>;
  return <p key={key}>{lines(chunk, key, w)}{tail}</p>;
}

// Blocks are drawn in order, so words are counted in order; only the last is given `tail`.
function draw(text: string, w: Words, tail?: ReactNode): ReactNode[] {
  const blocks: ((tail?: ReactNode) => ReactNode)[] = [];
  const fence = /```[^\n]*\n([\s\S]*?)(?:```|$)/g;
  let at = 0, n = 0;
  const prose = (part: string) => {
    for (const chunk of part.split(/\n\s*\n/)) {
      if (!chunk.trim()) continue;
      const key = `b${n++}`;
      blocks.push(end => block(chunk.replace(/^\n+|\n+$/g, ''), key, w, end));
    }
  };
  for (const match of text.matchAll(fence)) {
    prose(text.slice(at, match.index));
    const key = `b${n++}`, code = match[1]!.replace(/\n$/, '');
    blocks.push(end => unit(<pre key={key}><code>{code}</code>{end}</pre>, w));
    at = (match.index ?? 0) + match[0].length;
  }
  prose(text.slice(at));
  return blocks.map((drawBlock, i) => drawBlock(i === blocks.length - 1 ? tail : undefined));
}

const wordCount = (text: string) => { const w: Words = { n: 0 }; draw(text, w); return w.n; };

// `reveal` draws a reply as it is written: each chunk fades in as it arrives (chat-reveal.ts), and a `live` reply ends in a caret. The
// caret's glyph is drawn by CSS after a space, so it wraps alone and never pushes a word down: when it goes, nothing above it moves.
export function ChatText({ text, reveal: mode }: { text: string; reveal?: RevealMode }) {
  const streaming = !!mode;
  const count = useMemo(() => (streaming ? wordCount(text) : 0), [text, streaming]);
  const reveal = wordReveal(text, count, mode, wordCount);
  const caret = mode && 'live' in mode ? <span className="chat-caret" aria-hidden="true"/> : undefined;
  return <>{draw(text, { n: 0, reveal }, caret)}</>;
}
