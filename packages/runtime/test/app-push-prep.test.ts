import { describe, expect, it } from 'vitest';
import { ownerPush, PROACTIVE_PUSH_DAILY_LIMIT, PUSH_DAILY_LIMIT, PUSHES, type PushKind } from '../src/channels/expo-push';
import { prepPushBody } from '../src/channels/event-briefs';

// A prep note on the app raises its own push. It never spends the day cards' budget; non-card pushes have their own ceiling,
// a backstop against a runaway sender, while whether to send at all stays the model's call.
const INSTALLATION = '0f1e2d3c-4b5a-4968-8776-655443322110';
const harness = () => {
  const kv = new Map<string, unknown>();
  const sent: { body: string; data: Record<string, unknown> }[] = [];
  const codes: string[] = [];
  const push = ownerPush({
    accessToken: 'synthetic-expo-access', kv: { get: <T>(key: string) => kv.get(key) as T | undefined, put: (key, value) => { kv.set(key, value); } },
    targets: async () => [{ installation_id: INSTALLATION, device_epoch: 1, token: 'ExponentPushToken[synthetic]' }], retire: async () => true,
    send: (async (_url: string, init?: RequestInit) => {
      for (const message of JSON.parse(String(init?.body)) as { body: string; data: Record<string, unknown> }[]) sent.push({ body: message.body, data: message.data });
      return Response.json({ data: [{ status: 'ok', id: 'ticket' }] });
    }) as typeof fetch,
    today: () => '2026-10-03', quiet: () => false, log: code => { codes.push(code); },
  });
  return { push, sent, codes };
};

describe('the prep push', () => {
  it('carries the pre_activity_spot trigger, and the fixed line unless a body is given', async () => {
    const h = harness();
    await h.push('prep');
    await h.push('prep', undefined, 'Prep: Design review at 10:30');
    expect(h.sent).toEqual([
      { body: 'Waldo has a note before your next meeting', data: { trigger: 'pre_activity_spot' } },
      { body: 'Prep: Design review at 10:30', data: { trigger: 'pre_activity_spot' } },
    ]);
  });

  it('has its own daily ceiling, and spends none of the day cards\' budget', async () => {
    const h = harness();
    for (let i = 0; i < PROACTIVE_PUSH_DAILY_LIMIT + 2; i++) await h.push('prep');
    expect(h.sent).toHaveLength(PROACTIVE_PUSH_DAILY_LIMIT);
    expect(h.codes.filter(code => code === 'daily_limit')).toHaveLength(2);
    for (const kind of ['brief', 'approval'] as PushKind[]) await h.push(kind, kind === 'approval' ? 'appr_0123456789abcdef0123456789abcdef' : undefined);
    expect(h.sent.slice(PROACTIVE_PUSH_DAILY_LIMIT).map(message => message.data.trigger)).toEqual(['brief', 'approval']);
  });

  it('day cards keep their own budget whatever prep pushes went out', async () => {
    const h = harness();
    for (let i = 0; i < PUSH_DAILY_LIMIT; i++) await h.push('brief');
    await h.push('brief');
    await h.push('prep');
    expect(h.sent.map(message => message.data.trigger)).toEqual([...Array(PUSH_DAILY_LIMIT).fill('brief'), 'pre_activity_spot']);
  });

  it('keeps its fixed text in the push table', () => {
    expect(PUSHES.prep).toEqual({ body: 'Waldo has a note before your next meeting', data: { trigger: 'pre_activity_spot' } });
  });
});

describe('the prep push body', () => {
  const start = '2026-10-03T05:00:00Z';

  it('is the fixed line, with no title, while names are off', () => {
    expect(prepPushBody({ title: 'Design review with Asha', start, timezone: 'Asia/Kolkata', named: false })).toBe(PUSHES.prep.body);
  });

  it('names the meeting and its local start when names are on', () => {
    expect(prepPushBody({ title: 'Design review', start, timezone: 'Asia/Kolkata', named: true })).toBe('Prep: Design review at 10:30');
  });

  it('never carries an email address, a link, a health value, or an empty or overlong title', () => {
    expect(prepPushBody({ title: 'Sync with asha@example.test and ben@example.test', start, timezone: 'UTC', named: true })).toBe(PUSHES.prep.body);
    expect(prepPushBody({ title: 'Verify your account at evil.co/x', start, timezone: 'UTC', named: true })).toBe(PUSHES.prep.body);
    expect(prepPushBody({ title: 'Call zoom.us/j/8812345678?pwd=Xy12ab', start, timezone: 'UTC', named: true })).toBe(PUSHES.prep.body);
    expect(prepPushBody({ title: 'Recovery chat: HRV 42 ms', start, timezone: 'UTC', named: true })).toBe(PUSHES.prep.body);
    expect(prepPushBody({ title: 'asha@example.test', start, timezone: 'UTC', named: true })).toBe(PUSHES.prep.body);
    expect(prepPushBody({ title: undefined, start, timezone: 'UTC', named: true })).toBe(PUSHES.prep.body);
    expect(prepPushBody({ title: 'x'.repeat(200), start, timezone: 'UTC', named: true }).length).toBeLessThanOrEqual('Prep:  at 05:00'.length + 60);
  });
});
