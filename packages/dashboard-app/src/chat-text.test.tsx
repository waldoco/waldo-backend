import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatText } from './chat-text';

const html = (text: string) => renderToStaticMarkup(<ChatText text={text}/>);

describe('drawing Waldo’s replies', () => {
  it('never turns reply text into markup', () => {
    const out = html('<img src=x onerror=alert(1)> **<b>bold</b>** [x](javascript:alert(1))');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('<b>');
    expect(out).not.toContain('href="javascript');
    expect(out).toContain('&lt;img');
  });
  it('links only http and https, opened apart from the console', () => {
    const out = html('See [the venue](https://example.test/a) or https://example.test/b. Not ftp://example.test');
    expect(out).toContain('<a href="https://example.test/a" target="_blank" rel="noopener noreferrer">the venue</a>');
    expect(out).toContain('<a href="https://example.test/b" target="_blank" rel="noopener noreferrer">https://example.test/b</a>.');
    expect(out).not.toContain('href="ftp');
  });
  it('keeps paragraphs, line breaks, lists, quotes and code', () => {
    const out = html('Plan:\nfirst line\n\n- one\n- **two**\n\n1. a\n2. b\n\n> quoted\n\n```\nconst x = 1;\n```\nUse `npm`.');
    expect(out).toContain('<p>Plan:<br/>first line</p>');
    expect(out).toContain('<ul><li>one</li><li><strong>two</strong></li></ul>');
    expect(out).toContain('<ol start="1"><li>a</li><li>b</li></ol>');
    expect(out).toContain('<blockquote>quoted</blockquote>');
    expect(out).toContain('<pre><code>const x = 1;</code></pre>');
    expect(out).toContain('<code>npm</code>');
  });
  it('leaves an unclosed fence as code rather than losing it', () => {
    expect(html('```\nhalf')).toContain('<pre><code>half</code></pre>');
  });
});
