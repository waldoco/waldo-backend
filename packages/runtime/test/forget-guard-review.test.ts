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
  it('holds when the escape spells a character the topic contains, in either case', async () => {
    const { hidesTopic } = await import('../src/memory/forget-guard');
    expect(hidesTopic('x \\u0057 y', 'code word')).toBe(true);
    expect(hidesTopic('x \\u0043 y', 'code word')).toBe(true);
    expect(hidesTopic('x \\ud83d y', 'plan \u{1F600}')).toBe(true);
  });
  it('lets an escape for a character the topic lacks pass, and still holds a malformed one', async () => {
    const { hidesTopic } = await import('../src/memory/forget-guard');
    expect(hidesTopic('moved \\u2013 see agenda', 'code word')).toBe(false);
    expect(hidesTopic('moved \\u20 see agenda', 'code word')).toBe(true);
    expect(hidesTopic('C:\\Users', 'code word')).toBe(true);
  });
});
