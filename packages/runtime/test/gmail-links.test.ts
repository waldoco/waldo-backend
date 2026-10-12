import { describe, expect, it } from 'vitest';
import { b64url, googleClient } from '../src/connectors/google';
import { googleHandlers } from '../src/tools/live/google';

// Synthetic mail only. Rendering HTML keeps an anchor's text and drops its target, so the targets a
// reader could follow are listed after the body, within parsing bounds.
const encode = (text: string) => b64url(new TextEncoder().encode(text));
const thread = (html: string) => googleClient({ clientId: 'c', clientSecret: 's', redirectUri: 'https://example.invalid' }, { refresh_token: 'r' }, (async (input: RequestInfo | URL) =>
  String(input).includes('oauth2') ? Response.json({ access_token: 'a' }) : Response.json({ messages: [{ id: 'm1', internalDate: '1791417600000', payload: { mimeType: 'text/html', headers: [], body: { data: encode(html) } } }] })) as typeof fetch);
const body = async (html: string) => (await thread(html).threadPage!('t', 10)).messages[0]!.body;
const zoom = 'https://zoom.example.test/j/123?pwd=synthetic';
const reset = 'https://auth.example.com/verify?token=synthetic-reset-9f2c&type=recovery';

describe('the links list after an HTML body', () => {
  it('lists each followable link once with its text, and leaves out mail, image-only, over-long and verification links', async () => {
    const html = `<p>Hi, the agenda is below. <a href="${zoom}">Join the meeting</a>.</p>
      <p><a href="mailto:asha@example.test">Email Asha</a> <a href="https://cdn.example.test/promo"><img src="https://cdn.example.test/p.png"></a>
      <a href="https://example.test/${'x'.repeat(300)}">Long tracking link</a> <a href="${zoom}">join again</a>
      <a href="${reset}">Reset your password</a> <a href="https://docs.example.test/d/plan">https://docs.example.test/d/plan</a></p>`;
    const [text, list, ...rest] = (await body(html)).split('\n\nLinks:\n');
    expect(text).toContain('Hi, the agenda is below. Join the meeting.');
    expect(rest).toEqual([]);
    expect(list).toBe(`- Join the meeting: ${zoom}\n- https://docs.example.test/d/plan`);
  });

  it('shows the list to a reader that does not opt in to full bodies, and to readThread', async () => {
    const html = `<p><a href="${zoom}">Join the meeting</a></p>`;
    const client = thread(html);
    expect((await client.threadPage!('t', 10)).messages[0]!.body).toContain(`Links:\n- Join the meeting: ${zoom}`);
    expect((await client.readThread('t', 10))[0]!.body).toContain(`Links:\n- Join the meeting: ${zoom}`);
  });

  it('lists at most 20 links in at most 2,000 characters, with each link text cut to 100 characters', async () => {
    const many = Array.from({ length: 30 }, (_, i) => `<a href="https://example.test/p/${i}">Page ${i}</a>`).join(' ');
    const listed = (await body(`<p>${many}</p>`)).split('\nLinks:\n')[1]!.split('\n');
    expect(listed).toHaveLength(20);
    expect(listed[19]).toBe('- Page 19: https://example.test/p/19');
    const wide = Array.from({ length: 20 }, (_, i) => `<a href="https://example.test/${'w'.repeat(200)}/${i}">Wide ${i}</a>`).join(' ');
    const list = (await body(`<p>${wide}</p>`)).split('\nLinks:\n')[1]!;
    expect(list.length).toBeLessThanOrEqual(2_000);
    expect(list.split('\n').length).toBeGreaterThan(1);
    const label = (await body(`<p><a href="${zoom}">${'Join '.repeat(40)}</a></p>`)).split('\nLinks:\n')[1]!;
    expect(label).toBe(`- ${'Join '.repeat(20).trim()}: ${zoom}`);
  });

  it('adds no list to a body with no followable link', async () => {
    expect(await body(`<p>Plain note. <a href="mailto:asha@example.test">Email Asha</a></p>`)).toBe('Plain note. Email Asha');
  });

  it('keeps a verification link out of the list while read_thread still relays it from the scan', async () => {
    const relays: unknown[] = [];
    const [handler] = googleHandlers({ client: async () => thread(`<p><a href="${reset}">Reset your password</a> <a href="${zoom}">Join</a></p>`) }, { propose: async () => '', proposeSendEmail: async () => '', record: () => {} } as never,
      { timezone: 'UTC', now: () => new Date() }, async (_from, artifacts) => { relays.push(artifacts); return true; }).filter(h => h.name === 'read_thread');
    const result = await handler!.handle({ thread_id: 't', limit: 10 } as never);
    const shown = JSON.stringify(result);
    expect(shown).toContain(`Links:\\n- Join: ${zoom}`);
    expect(shown).not.toContain('synthetic-reset');
    expect(relays).toEqual([[{ kind: 'password_reset', value: reset }]]);
  });
});
