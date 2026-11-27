import { describe, expect, it } from 'vitest';
import { ownerPush, PUSHES, type PushKind } from '../src/channels/expo-push';
import { prepPushBody } from '../src/channels/event-briefs';

// A prep note on the app raises its own push. Pushes for unasked messages keep no daily count (the owner's ruling of 27
// November): whether to send at all is the model's call, and each message pushes once.
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

  it('keeps no daily count: a busy day\'s prep notes, copies and day cards each push', async () => {
    const h = harness();
    for (let i = 0; i < 30; i++) await h.push('prep');
    for (const kind of ['copy', 'brief', 'approval'] as PushKind[]) await h.push(kind, kind === 'approval' ? 'appr_0123456789abcdef0123456789abcdef' : undefined);
    expect(h.sent).toHaveLength(33);
    expect(h.codes).not.toContain('daily_limit');
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
    expect(prepPushBody({ title: 'Design review', start, timezone: 'Asia/Kolkata', named: true })).toBe('Prep: Design review at 10:30am');
  });

  it('never carries an email address, a link, a health value, or an empty or overlong title', () => {
    expect(prepPushBody({ title: 'Sync with asha@example.test and ben@example.test', start, timezone: 'UTC', named: true })).toBe(PUSHES.prep.body);
    expect(prepPushBody({ title: 'Verify your account at evil.co/x', start, timezone: 'UTC', named: true })).toBe(PUSHES.prep.body);
    expect(prepPushBody({ title: 'Call zoom.us/j/8812345678?pwd=Xy12ab', start, timezone: 'UTC', named: true })).toBe(PUSHES.prep.body);
    expect(prepPushBody({ title: 'Verify at evil\uff0eco/login', start, timezone: 'UTC', named: true })).toBe(PUSHES.prep.body);
    expect(prepPushBody({ title: 'Recovery chat: HRV 42 ms', start, timezone: 'UTC', named: true })).toBe(PUSHES.prep.body);
    expect(prepPushBody({ title: 'asha@example.test', start, timezone: 'UTC', named: true })).toBe(PUSHES.prep.body);
    expect(prepPushBody({ title: undefined, start, timezone: 'UTC', named: true })).toBe(PUSHES.prep.body);
    expect(prepPushBody({ title: 'x'.repeat(200), start, timezone: 'UTC', named: true }).length).toBeLessThanOrEqual('Prep:  at 5am'.length + 60);
  });
});
