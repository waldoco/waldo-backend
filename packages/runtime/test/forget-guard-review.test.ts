import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { claimStore } from '../src/memory/claims';
import { hidesTopic } from '../src/memory/forget-guard';
import { conversationForgetSources } from '../src/channels/conversation-store';

const at = '2026-10-03T12:00:00Z';

it('guard unit: a topic containing a tab/newline is spelled by \\t / \\n in JSON and must hold', () => {
  expect(hidesTopic(JSON.stringify({ a: 'alpha\tbeta' }), 'alpha\tbeta')).toBe(true);
  expect(hidesTopic(JSON.stringify({ a: 'alpha\nbeta' }), 'alpha\nbeta')).toBe(true);
});

it('cleanup projection (memory_backups) with a tab-bearing topic must not read clean', async () => {
  await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('review-tab-topic')), (_i, state) => {
    const store = claimStore(state.storage.sql);
    const topic = 'alpha\tbeta secret';
    store.backup('fixture', { detail: `note ${topic} tail` }, at);
    store.beginTopicCoverage(topic, at);
    const r = store.forgetSources(topic);
    expect(r.incomplete || r.sources.length > 0).toBe(true);
    expect(store.purge([], at, [topic]).ready).toBe(false);
  });
});

it('conversation store: JSON-escaped topic in a payload is held (unguarded forgetSources)', async () => {
  await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('review-conv')), async (_i, state) => {
    const entry = { id: 'e1', ownerId: 'owner', chatId: 'c', parentId: null, threadAnchorId: null, surface: 's', modelPayload: '{"t":"DLD-\\u0032026 secret"}', appPayload: 'x', modelProjection: { mode: 'include' } };
    await state.storage.put('conv:e1', entry);
    const r = await conversationForgetSources(state.storage as never, 'DLD-2026 secret');
    expect(r.incomplete || r.sources.length > 0).toBe(true);
  });
});

it('end to end: non-strict JSON (trailing comma) hiding a tab-bearing topic behind \\t must not settle clean', async () => {
  await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('review-tab-json5')), (_i, state) => {
    const store = claimStore(state.storage.sql);
    const topic = 'alpha\tbeta secret';
    store.backup('fixture', { detail: 'x' }, at);
    state.storage.sql.exec('UPDATE memory_backups SET payload = ?', '{"detail":"note alpha\\tbeta secret tail",}');
    store.beginTopicCoverage(topic, at);
    const r = store.forgetSources(topic);
    expect(r.incomplete || r.sources.length > 0).toBe(true);
    expect(store.purge([], at, [topic]).ready).toBe(false);
  });
});

const convHold = async (name: string, payload: string, topic: string) => runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name)), async (_i, state) => {
  await state.storage.put('conv:e1', { id: 'e1', ownerId: 'owner', chatId: 'c', parentId: null, threadAnchorId: null, surface: 's', modelPayload: payload, appPayload: 'x', modelProjection: { mode: 'include' } });
  const r = await conversationForgetSources(state.storage as never, topic);
  return r.incomplete;
});
it('conversation prose with a Windows path or a \\u in code does not hold an unrelated forget', async () => {
  expect(await convHold('review-conv-path', 'my files are in C:\\Users\\me\\docs and the regex is \\u0041+', 'unrelated topic here')).toBe(false);
});
it('conversation JSON-shaped payload with an escaped topic still holds, including non-strict JSON', async () => {
  expect(await convHold('review-conv-json', '{"t":"DLD-\\u0032026 secret"}', 'DLD-2026 secret')).toBe(true);
  expect(await convHold('review-conv-json5', '{t:"DLD-\\u0032026 secret"}', 'DLD-2026 secret')).toBe(true);
  expect(await convHold('review-conv-array', '["DLD-\\u0032026 secret"]', 'DLD-2026 secret')).toBe(true);
});

describe('hidesTopic unicode escapes', () => {
  it('holds exactly when the decoded string carries the topic, by the same fold as carriesTopic', async () => {
    const { hidesTopic, carriesTopic } = await import('../src/memory/forget-guard');
    const cases: Array<[string, string]> = [
      ['x \\u0057 y', 'code word'], ['x \\u0077 y', 'code word'], ['\u03b1\\u03a3', '\u03b1\u03c2'], ['I\\u0307', 'i\u0307'],
      ['\\u212a', 'k'], ['a \\u0000 b', 'a\u0000b'], ['\\u0063ode \\u2013 note', 'code'], ['moved \\u2013 see agenda', 'code word'],
      ['e\\u0301', 'e'], ['a\\u00a0b', 'a b'], ['\\uff43ode', 'code'], ['stra\\u00dfe', 'strasse'], ['\\ufb01le', 'file'], ['x \\u0057 y plus \\u2013', 'code word'],
    ];
    for (const [value, topic] of cases) {
      const decoded = value.replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
      expect(hidesTopic(value, topic), `${value} / ${topic}`).toBe(carriesTopic(decoded, topic));
    }
  });
  it('pins the sigma and dotted-I fail-open found in review, and keeps malformed escapes held', async () => {
    const { hidesTopic } = await import('../src/memory/forget-guard');
    expect(hidesTopic('\u03b1\\u03a3', '\u03b1\u03c2')).toBe(true);
    expect(hidesTopic('moved \\u2013 see agenda', 'code word')).toBe(false);
    expect(hidesTopic('moved \\u20 see agenda', 'code word')).toBe(true);
    expect(hidesTopic('C:\\Users', 'code word')).toBe(true);
    expect(hidesTopic('x \\U0057 y', 'code word')).toBe(true);
  });
});

describe('hidesTopic decodes simple escapes too (review round 2)', () => {
  it('matches a real JSON parse where a skipped tab or newline changes final-sigma context', async () => {
    const { hidesTopic, carriesTopic } = await import('../src/memory/forget-guard');
    for (const [json, topic] of [['"\\t\\u03a3"', '\u03c3'], ['"\\n\\u03a3"', '\u03c3'], ['"\\"\\u03a3"', '\u03c3'], ['"\\t\\u0130"', 'i\u0307'], ['"\\t\\u03a3"', '\u03c2']] as const) {
      const inner = json.slice(1, -1);
      expect(hidesTopic(inner, topic), `${inner} / ${topic}`).toBe(carriesTopic(JSON.parse(json) as string, topic) && !carriesTopic(inner, topic) || (inner.includes('\\u') && carriesTopic(JSON.parse(json) as string, topic)));
    }
    expect(hidesTopic('\\t\\u03a3', '\u03c3')).toBe(true);
    expect(hidesTopic('\\n\\u03a3', '\u03c3')).toBe(true);
  });
  it('pins double-encoded escapes: the guard reads one level, like the consumers', async () => {
    const { hidesTopic } = await import('../src/memory/forget-guard');
    expect(hidesTopic('\\\\u0041', 'a')).toBe(false);
  });
  it('a benign escape with no effect on the topic still passes', async () => {
    const { hidesTopic } = await import('../src/memory/forget-guard');
    expect(hidesTopic('line one\\nline two', 'code word')).toBe(false);
  });
});
