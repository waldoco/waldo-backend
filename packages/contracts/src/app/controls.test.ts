import { describe, expect, it } from 'vitest';
import { appChannelStatusV1Schema, appControlActionV1Schema, appControlProjectionV1Schema, appControlReceiptV1Schema } from './controls';

const revision = 'f'.repeat(64);
const connections = {
  google: { connectAvailable: false, accounts: [] },
  telegram: { linked: true, unlinkAvailable: true },
  sessions: { until: '2026-10-10T20:00:00Z', count: 1, items: [] },
};
const projection = (data: object) => ({ version: 1, state: 'available', revision, view: 'connections', data });

describe('channel link actions', () => {
  it('adds channel.unlink, naming a messaging channel in id', () => {
    for (const id of ['telegram', 'whatsapp', 'imessage']) {
      expect(appControlActionV1Schema.safeParse({ view: 'connections', action: 'channel.unlink', id, revision, request_id: 'request-0002' }).success).toBe(true);
    }
  });

  it('leaves link start to its own non-durable route', () => {
    expect(appControlActionV1Schema.safeParse({ view: 'connections', action: 'channel.link_start', id: 'telegram', revision, request_id: 'request-0002' }).success).toBe(false);
  });

  it('rejects a channel action without a messaging channel, and leaves existing actions unchanged', () => {
    const base = { view: 'connections', action: 'channel.unlink', revision, request_id: 'request-0002' };
    expect(appControlActionV1Schema.safeParse(base).success).toBe(false);
    expect(appControlActionV1Schema.safeParse({ ...base, id: 'app' }).success).toBe(false);
    expect(appControlActionV1Schema.safeParse({ ...base, id: 'slack' }).success).toBe(false);
    expect(appControlActionV1Schema.safeParse({ ...base, action: 'channel.link' }).success).toBe(false);
    expect(appControlActionV1Schema.safeParse({ view: 'day', action: 'proactivity.set', volume: 'low', revision, request_id: 'request-0003' }).success).toBe(true);
    expect(appControlActionV1Schema.safeParse({ view: 'day', action: 'timezone.set', id: 'anything', value: 'UTC', revision, request_id: 'request-0004' }).success).toBe(true);
  });

  it('keeps the receipt states the app already parses', () => {
    expect(appControlReceiptV1Schema.shape.state.options).toEqual(['recorded', 'incomplete', 'rejected', 'unconfirmed']);
  });
});

describe('channel status in the connections view', () => {
  it('parses the projection with and without channels', () => {
    expect(appControlProjectionV1Schema.safeParse(projection(connections)).success).toBe(true);
    const channels = [
      { channel: 'telegram', state: 'linked', masked_label: '@sh•••' },
      { channel: 'whatsapp', state: 'pending', masked_label: null },
      { channel: 'imessage', state: 'unlinked', masked_label: null },
    ];
    expect(appControlProjectionV1Schema.safeParse(projection({ ...connections, channels })).success).toBe(true);
    expect(appControlProjectionV1Schema.safeParse(projection({ ...connections, channels: [channels[0], channels[0]] })).success).toBe(false);
  });

  it('shows a masked label exactly while a binding keeps addressing', () => {
    expect(appChannelStatusV1Schema.safeParse({ channel: 'telegram', state: 'blocked', masked_label: '@sh•••' }).success).toBe(true);
    expect(appChannelStatusV1Schema.safeParse({ channel: 'telegram', state: 'linked', masked_label: null }).success).toBe(false);
    expect(appChannelStatusV1Schema.safeParse({ channel: 'telegram', state: 'unlinked', masked_label: '@sh•••' }).success).toBe(false);
    expect(appChannelStatusV1Schema.safeParse({ channel: 'telegram', state: 'pending', masked_label: '@sh•••' }).success).toBe(false);
  });

  it('rejects unknown channels and states and extra keys', () => {
    expect(appChannelStatusV1Schema.safeParse({ channel: 'app', state: 'linked', masked_label: 'x' }).success).toBe(false);
    expect(appChannelStatusV1Schema.safeParse({ channel: 'telegram', state: 'bound', masked_label: 'x' }).success).toBe(false);
    expect(appChannelStatusV1Schema.safeParse({ channel: 'telegram', state: 'linked', masked_label: 'x', chat_id: '42' }).success).toBe(false);
  });
});
