import { describe, expect, it } from 'vitest';
import { APP_MEMORY_PAGE_MAX_V1, appChannelStatusV1Schema, appControlActionV1Schema, appControlProjectionV1Schema, appControlQueryV1Schema, appControlReceiptV1Schema, appControlResultV1Schema } from './controls';

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

describe('Google connect from the app', () => {
  const connect = { view: 'connections', action: 'google.connect', value: 'calendar', revision, request_id: 'connect-0001' };

  it('starts a connect from the connections view, naming the feature in value', () => {
    expect(appControlActionV1Schema.safeParse(connect).success).toBe(true);
    expect(appControlActionV1Schema.safeParse({ ...connect, value: 'tasks' }).success).toBe(true);
  });

  it('rejects a connect outside the connections view or without a feature', () => {
    expect(appControlActionV1Schema.safeParse({ ...connect, view: 'day' }).success).toBe(false);
    const { value: _value, ...bare } = connect;
    expect(appControlActionV1Schema.safeParse(bare).success).toBe(false);
    expect(appControlActionV1Schema.safeParse({ ...connect, value: '' }).success).toBe(false);
    expect(appControlActionV1Schema.safeParse({ ...connect, value: 'x'.repeat(65) }).success).toBe(false);
    expect(appControlActionV1Schema.safeParse({ ...connect, action: 'google.disconnect' }).success).toBe(false);
  });

  it('returns the first-party link in the receipt navigation', () => {
    expect(appControlReceiptV1Schema.safeParse({ state: 'recorded', message: 'Google connect is ready to begin.', navigation: '/c/AAAAAAAAAAAAAAAAAAAAAA' }).success).toBe(true);
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

describe('account deletion from the app', () => {
  const remove = { view: 'account', action: 'account.delete', confirmation: 'DELETE', revision, request_id: 'delete-0001' };

  it('reads the account view and deletes from it with the typed confirmation', () => {
    expect(appControlQueryV1Schema.safeParse({ view: 'account' }).success).toBe(true);
    expect(appControlProjectionV1Schema.safeParse({ version: 1, state: 'available', revision, view: 'account', data: { deletion_available: true } }).success).toBe(true);
    expect(appControlActionV1Schema.safeParse(remove).success).toBe(true);
    expect(appControlResultV1Schema.safeParse({ request_id: 'delete-0001', receipt: { state: 'recorded', message: 'Removed.', signed_out: true }, duplicate: false }).success).toBe(true);
  });

  it('refuses a deletion without the exact confirmation, outside the account view, or carrying other fields', () => {
    const { confirmation: _confirmation, ...bare } = remove;
    for (const invalid of [bare, { ...remove, confirmation: 'delete' }, { ...remove, confirmation: 'DELETE ' }, { ...remove, view: 'connections' }, { ...remove, value: 'x' }, { ...remove, id: 'x' }])
      expect(appControlActionV1Schema.safeParse(invalid).success).toBe(false);
  });

  it('keeps the confirmation and the account view to account.delete', () => {
    expect(appControlActionV1Schema.safeParse({ view: 'day', action: 'timezone.set', value: 'Europe/London', confirmation: 'DELETE', revision, request_id: 'delete-0002' }).success).toBe(false);
    expect(appControlActionV1Schema.safeParse({ view: 'account', action: 'timezone.set', value: 'Europe/London', revision, request_id: 'delete-0003' }).success).toBe(false);
  });

  it('refuses extra keys in the account projection', () => {
    expect(appControlProjectionV1Schema.safeParse({ version: 1, state: 'available', revision, view: 'account', data: { deletion_available: true, email: 'a@example.test' } }).success).toBe(false);
    expect(appControlProjectionV1Schema.safeParse({ version: 1, state: 'available', revision, view: 'account', data: {} }).success).toBe(false);
  });
});

describe('day card latest delivery', () => {
  const card = { id: 'brief', name: 'Morning Brief', defaultTime: '07:30', time: '07:30', reason: 'planned', sent: true, pin: null };
  const latest = { message_id: 'entry-1', delivered_at: 1_791_700_000_000, excerpt: 'Good morning. Two meetings before noon.' };
  const day = (cards: object[]) => ({
    version: 1, state: 'available', revision, view: 'day',
    data: { timezone: 'Europe/London', date: '2026-10-11', cards, proactivity: { quiet_start: null, quiet_end: null, volume: 'normal' }, schedules: { daily_brief: true, followups: true, event_briefs: true, nightly: true, heartbeat: true } },
  });

  it('accepts a card without latest, with null, and with a recorded delivery', () => {
    for (const valid of [card, { ...card, latest: null }, { ...card, latest }, { ...card, latest: { ...latest, excerpt: 'x'.repeat(280) } }, { ...card, sent: false, latest }])
      expect(appControlProjectionV1Schema.safeParse(day([valid])).success).toBe(true);
  });

  it('refuses a malformed delivery', () => {
    const { excerpt: _excerpt, ...noExcerpt } = latest;
    for (const invalid of [
      { ...latest, excerpt: '' }, { ...latest, excerpt: 'x'.repeat(281) }, noExcerpt, { ...latest, text: 'full body' },
      { ...latest, delivered_at: 0 }, { ...latest, delivered_at: 1.5 }, { ...latest, delivered_at: '2026-10-11T07:30:00Z' },
      { ...latest, message_id: '' }, {},
    ]) expect(appControlProjectionV1Schema.safeParse(day([{ ...card, latest: invalid }])).success).toBe(false);
  });

  it('accepts a card state that agrees with sent, and a card without one', () => {
    for (const valid of [card, { ...card, state: 'sent' }, { ...card, state: 'skipped' }, { ...card, state: 'skipped', latest: null }, { ...card, state: 'sent', latest },
      { ...card, sent: false, state: 'pending' }, { ...card, sent: false, state: 'held' }, { ...card, sent: false, time: null, state: 'pending' }])
      expect(appControlProjectionV1Schema.safeParse(day([valid])).success).toBe(true);
  });

  it('refuses a card state that contradicts sent, or one outside the four', () => {
    for (const invalid of [{ ...card, sent: false, state: 'sent' }, { ...card, sent: false, state: 'skipped' }, { ...card, state: 'pending' }, { ...card, state: 'held' },
      { ...card, state: 'failed' }, { ...card, state: 'delivered' }, { ...card, state: '' }, { ...card, state: null }, { ...card, state: 1 }])
      expect(appControlProjectionV1Schema.safeParse(day([invalid])).success).toBe(false);
  });
});

describe('constellation view', () => {
  const header = { state: 'available', complete: true, unavailable_claim_count: 0 };
  const claim = {
    id: 'memory:claim:1', kind: 'routine', text: 'Walks after lunch', source: 'stated', origin: 'owner', status: 'active',
    evidence: { kind: 'writer_note', text: 'Said so on Monday' },
    source_reference: { state: 'unverified', link: null, visibility: 'withheld_unverified_pointer', retrievable: false },
    recorded_at: '2026-10-01', writer_seen_count: 2,
  };
  const node = {
    id: 'memory:node:1', type: 'interpretation', label: 'Afternoon reset', summary: 'A walk tends to precede a calmer afternoon', domain: 'work',
    stored_status: 'active', recorded_active_at: '2026-10-02', estimate: 0.6, estimate_kind: 'uncalibrated_model_estimate',
    support: { state: 'stored_links', claim_ids: ['memory:claim:1'], unavailable_count: 0, distinct_source_refs: 1, independent_observations: 'unverified' },
  };
  const link = { from: 'memory:node:1', to: 'memory:node:2', relation: 'improves', state: 'unverified_association', estimate: null, writer_evidence_count: 1, evidence_links: [] };
  const page = { limit: 10, returned: 1, total: 1, next_cursor: null };
  const view = (data: object) => ({ version: 1, state: 'available', revision, view: 'constellation', data: { version: 1, ...header, ...data } });
  const valid = [
    { memory_view: 'summary', counts: { claims: 1, interpretations: 1, associations: 0 } },
    { memory_view: 'claims', items: [claim], page },
    { memory_view: 'interpretations', items: [node], page: { ...page, next_cursor: 'eyJ2IjoxfQ' } },
    { memory_view: 'detail', kind: 'claim', item: claim, linked_interpretation_ids: ['memory:node:1'] },
    { memory_view: 'detail', kind: 'interpretation', item: node, support_claim_ids: ['memory:claim:1'], support_unavailable_count: 0 },
    { memory_view: 'pattern', center: node, nodes: [], associations: [link], showing: { nodes: 0, of_nodes: 1, links: 1, of_links: 1 }, truncated: false, omitted_links: 0, expand: { next_cursor: null, links_capped: false, capped_links_recoverable: false, capped_links: 0 } },
  ];

  it('accepts every sub-view, an unavailable graph and a purge-pending graph', () => {
    for (const data of valid) expect(appControlProjectionV1Schema.safeParse(view(data)).success).toBe(true);
    expect(appControlProjectionV1Schema.safeParse(view({ ...valid[0], state: 'unavailable', complete: false })).success).toBe(true);
    expect(appControlProjectionV1Schema.safeParse(view({ memory_view: 'claims', items: [], page: { ...page, returned: 0, total: 0 }, state: 'partial', complete: false, unavailable_claim_count: 2 })).success).toBe(true);
  });

  it('refuses console-only keys, a wrong sub-view shape and out-of-range values', () => {
    for (const data of [
      { ...valid[1], items: [{ ...claim, local_id: 1 }] }, { ...valid[2], items: [{ ...node, local_id: 1 }] }, { ...valid[0], actions: [] }, { ...valid[0], views: ['claims'] },
      { ...valid[1], items: [node] }, { ...valid[1], memory_view: 'interpretations' }, { ...valid[3], kind: 'interpretation' },
      { ...valid[2], items: [{ ...node, estimate: 1.5 }] }, { ...valid[5], associations: [{ ...link, writer_evidence_count: 0 }] },
      { ...valid[1], items: [{ ...claim, origin: 'model' }] }, { ...valid[0], state: 'stale' }, { ...valid[0], memory_view: 'graph' },
    ]) expect(appControlProjectionV1Schema.safeParse(view(data)).success).toBe(false);
  });

  it('takes pager keys only with view=constellation, within the page limit', () => {
    for (const query of [
      { view: 'constellation' }, { view: 'constellation', memory_view: 'claims', limit: String(APP_MEMORY_PAGE_MAX_V1) },
      { view: 'constellation', memory_view: 'interpretations', limit: '1', cursor: 'eyJ2IjoxLCJrIjoiY2xhaW1zIiwiYWZ0ZXIiOjF9' },
      { view: 'constellation', memory_view: 'detail', id: 'memory:claim:1' }, { view: 'constellation', memory_view: 'pattern', id: 'memory:node:1', max_nodes: '5', max_links: '5' },
    ]) expect(appControlQueryV1Schema.safeParse(query).success).toBe(true);
    for (const query of [
      { view: 'day', memory_view: 'claims' }, { view: 'activity', limit: '5' }, { view: 'account', id: 'memory:claim:1' },
      { view: 'constellation', memory_view: 'graph' }, { view: 'constellation', limit: '0' }, { view: 'constellation', limit: String(APP_MEMORY_PAGE_MAX_V1 + 1) },
      { view: 'constellation', limit: '1.5' }, { view: 'constellation', max_links: '-1' }, { view: 'constellation', cursor: 'a/b=' }, { view: 'constellation', id: '' },
      { view: 'constellation', trace_before: '1' },
    ]) expect(appControlQueryV1Schema.safeParse(query).success).toBe(false);
  });

  it('takes no actions', () => {
    expect(appControlActionV1Schema.safeParse({ view: 'constellation', action: 'timezone.set', value: 'UTC', revision, request_id: 'request-0009' }).success).toBe(false);
  });
});

describe('confirmed time zone', () => {
  const day = (extra: object) => ({
    version: 1, state: 'available', revision, view: 'day',
    data: { timezone: 'Europe/London', date: '2026-10-11', cards: [], proactivity: { quiet_start: null, quiet_end: null, volume: 'normal' }, schedules: { daily_brief: true, followups: true, event_briefs: true, nightly: true, heartbeat: true }, ...extra },
  });
  it('says whether the owner set the zone, and stays optional for a Worker that does not say', () => {
    for (const valid of [{}, { timezone_confirmed: true }, { timezone_confirmed: false }]) expect(appControlProjectionV1Schema.safeParse(day(valid)).success).toBe(true);
    for (const invalid of [{ timezone_confirmed: 'yes' }, { timezone_confirmed: null }, { timezone_confirmed: 1 }]) expect(appControlProjectionV1Schema.safeParse(day(invalid)).success).toBe(false);
  });
});

describe('signing out another device from the app', () => {
  const ref = `sess_${'c'.repeat(64)}`;
  const revoke = { view: 'connections', action: 'session.revoke', value: ref, revision, request_id: 'revoke-0001' };
  it('names the device by the session_ref its connections row carries', () => {
    expect(appControlActionV1Schema.safeParse(revoke).success).toBe(true);
    const item = { signed_in: '2026-10-12T20:00:00Z', until: '2026-11-11T20:00:00Z', current: false, session_ref: ref };
    expect(appControlProjectionV1Schema.safeParse(projection({ ...connections, sessions: { until: '2026-11-11T20:00:00Z', count: 1, items: [item] } })).success).toBe(true);
    const { session_ref: _ref, ...older } = item;
    expect(appControlProjectionV1Schema.safeParse(projection({ ...connections, sessions: { until: '2026-11-11T20:00:00Z', count: 1, items: [older] } })).success).toBe(true);
    expect(appControlProjectionV1Schema.safeParse(projection({ ...connections, sessions: { until: '2026-11-11T20:00:00Z', count: 1, items: [{ ...item, session_ref: 'sess_short' }] } })).success).toBe(false);
  });
  it('refuses a revoke without a session_ref, from another view, or carrying other fields', () => {
    expect(appControlActionV1Schema.safeParse({ ...revoke, value: undefined }).success).toBe(false);
    expect(appControlActionV1Schema.safeParse({ ...revoke, value: 'c'.repeat(64) }).success).toBe(false);
    expect(appControlActionV1Schema.safeParse({ ...revoke, view: 'day' }).success).toBe(false);
    expect(appControlActionV1Schema.safeParse({ ...revoke, id: 'telegram' }).success).toBe(false);
  });
});

describe('what Waldo is carrying and the open loops', () => {
  const day = (extra: object) => ({
    version: 1, state: 'available', revision, view: 'day',
    data: { timezone: 'Europe/London', date: '2026-10-13', cards: [], proactivity: { quiet_start: null, quiet_end: null, volume: 'normal' }, schedules: { daily_brief: true, followups: true, event_briefs: true, nightly: true, heartbeat: true }, ...extra },
  });
  const carried = { id: 'r1a2b3c4', title: 'Get the venue quote signed', state: 'open', next: { title: 'Send the quote to finance', holder: 'waldo' }, check_at: '2026-10-14T09:00' };
  const loop = { id: 'o1a2b3c4', title: 'Reply about the lease renewal', due: '2026-10-15', source: 'gmail' };
  const page = (items: object[], total = items.length) => ({ items, total });
  const parses = (extra: object) => appControlProjectionV1Schema.safeParse(day(extra)).success;

  it('carries open work with its next move, who holds it and when Waldo checks again, and stays optional', () => {
    for (const valid of [
      {}, { carrying: page([]), open_loops: page([]) },
      { carrying: page([carried, { ...carried, state: 'waiting', next: null, check_at: null }, { ...carried, state: 'uncertain', next: { title: 'Confirm the date', holder: 'owner' }, check_at: '2026-10-14' }], 7) },
      { carrying: page(Array.from({ length: 20 }, (_, i) => ({ ...carried, id: `r${i}` }))) },
    ]) expect(parses(valid), JSON.stringify(valid)).toBe(true);
  });

  it('refuses closed work, an unknown holder, a malformed check time, extra detail and an inconsistent count', () => {
    for (const invalid of [
      { carrying: null }, { carrying: { items: [] } }, { carrying: page([carried], 0) }, { carrying: page([carried], -1) }, { carrying: page([carried], 1.5) },
      { carrying: page(Array.from({ length: 21 }, (_, i) => ({ ...carried, id: `r${i}` }))) },
      { carrying: page([{ ...carried, state: 'done' }]) }, { carrying: page([{ ...carried, state: 'dropped' }]) },
      { carrying: page([{ ...carried, next: { title: 'Ask Priya', holder: 'priya' } }]) }, { carrying: page([{ ...carried, next: { holder: 'waldo' } }]) },
      { carrying: page([{ ...carried, next: { title: '', holder: 'waldo' } }]) }, { carrying: page([{ ...carried, title: 'x'.repeat(201) }]) },
      { carrying: page([{ ...carried, check_at: '2026-10-14 09:00' }]) }, { carrying: page([{ ...carried, check_at: 'tomorrow' }]) },
      { carrying: page([{ ...carried, intent: 'The full ask' }]) }, { carrying: page([{ ...carried, id: '' }]) },
    ]) expect(parses(invalid), JSON.stringify(invalid)).toBe(false);
  });

  it('lists open loops soonest first with where each came from, never the thread itself', () => {
    for (const valid of [{ open_loops: page([loop, { ...loop, due: '2026-10-15T17:30' }, { ...loop, due: null, source: 'chat' }], 12) }]) expect(parses(valid)).toBe(true);
    for (const invalid of [
      { open_loops: null }, { open_loops: page([{ ...loop, source: 'telegram' }]) }, { open_loops: page([{ ...loop, due: 'Friday' }]) },
      { open_loops: page([{ ...loop, thread_id: 'thread-1' }]) }, { open_loops: page([{ ...loop, title: '' }]) }, { open_loops: page([loop, loop], 1) },
    ]) expect(parses(invalid), JSON.stringify(invalid)).toBe(false);
  });
});
