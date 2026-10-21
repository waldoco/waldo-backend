import type { ReactNode } from 'react';

// The Markdown Waldo's replies use, drawn as React elements: never as HTML, so a reply cannot inject markup.
// Paragraphs, line breaks, lists, quotes, headings as strong lines, fenced and inline code, bold, italic and
// http(s) links. Anything else stays as the literal characters Waldo wrote.
const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+?\*\*)|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|(\*[^*\s][^*\n]*?\*)|(_[^_\s][^_\n]*?_)/g;

const anchor = (url: string, label: ReactNode, key: string) => <a key={key} href={url} target="_blank" rel="noopener noreferrer">{label}</a>;
// The text inside a delimiter of `edge` characters on each side.
const inside = (text: string, edge: number) => text.slice(edge, text.length - edge);

export function inline(text: string, key = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0, n = 0;
  for (const match of text.matchAll(INLINE)) {
    const start = match.index ?? 0;
    if (start > at) out.push(text.slice(at, start));
    const [whole, code, bold, label, url, bare, star, under] = match;
    const k = `${key}-${n++}`;
    if (code) out.push(<code key={k}>{inside(code, 1)}</code>);
    else if (bold) out.push(<strong key={k}>{inline(inside(bold, 2), k)}</strong>);
    else if (label && url) out.push(anchor(url, label, k));
    else if (bare) out.push(anchor(bare, bare, k));
    else if (star || under) out.push(<em key={k}>{inside((star ?? under)!, 1)}</em>);
    else out.push(whole);
    at = start + whole.length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

const lines = (text: string, key: string) => text.split('\n').flatMap((line, i) => i === 0 ? inline(line, `${key}-${i}`) : [<br key={`${key}-br${i}`}/>, ...inline(line, `${key}-${i}`)]);
const BULLET = /^\s*[-*•]\s+/, NUMBER = /^\s*\d{1,3}[.)]\s+/;

function block(chunk: string, key: string): ReactNode {
  const rows = chunk.split('\n');
  if (rows.every(row => BULLET.test(row))) return <ul key={key}>{rows.map((row, i) => <li key={i}>{inline(row.replace(BULLET, ''), `${key}-${i}`)}</li>)}</ul>;
  if (rows.every(row => NUMBER.test(row))) return <ol key={key} start={Number(/\d+/.exec(rows[0]!)![0])}>{rows.map((row, i) => <li key={i}>{inline(row.replace(NUMBER, ''), `${key}-${i}`)}</li>)}</ol>;
  if (rows.every(row => /^\s*>/.test(row))) return <blockquote key={key}>{lines(rows.map(row => row.replace(/^\s*>\s?/, '')).join('\n'), key)}</blockquote>;
  const heading = /^#{1,6}\s+(.+)$/.exec(chunk.trim());
  if (heading && rows.length === 1) return <p key={key} className="chat-heading-line"><strong>{inline(heading[1]!, key)}</strong></p>;
  return <p key={key}>{lines(chunk, key)}</p>;
}

export function ChatText({ text }: { text: string }) {
  const out: ReactNode[] = [];
  const fence = /```[^\n]*\n([\s\S]*?)(?:```|$)/g;
  let at = 0, n = 0;
  const prose = (part: string) => { for (const chunk of part.split(/\n\s*\n/)) if (chunk.trim()) out.push(block(chunk.replace(/^\n+|\n+$/g, ''), `b${n++}`)); };
  for (const match of text.matchAll(fence)) {
    prose(text.slice(at, match.index));
    out.push(<pre key={`b${n++}`}><code>{match[1]!.replace(/\n$/, '')}</code></pre>);
    at = (match.index ?? 0) + match[0].length;
  }
  prose(text.slice(at));
  return <>{out}</>;
}
