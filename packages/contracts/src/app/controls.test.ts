import { describe, expect, it } from 'vitest';
import { APP_CONTROLS_PROACTIVE_SURFACE_REVISION, APP_PROACTIVE_SURFACE_RECEIPTS_V1, APP_AGENT_MAIL_HANDLE_INPUT_MAX_V1, APP_AGENT_MAIL_RECEIPTS_V1, APP_CLAIM_TEXT_MAX_V1, APP_CONTROLS_AGENT_MAIL_REVISION, APP_CONTROLS_IDENTITY_REVISION, APP_CONTROLS_MEMORY_REVISION, APP_IMESSAGE_ENROLL_RECEIPTS_V1, APP_PHONE_SET_RECEIPTS_V1, APP_MEMORY_PAGE_MAX_V1, APP_NODE_CORRECTION_MAX_V1, appChannelStatusV1Schema, appControlActionV1Schema, appControlProjectionV1Schema, appControlQueryV1Schema, appControlReceiptV1Schema, appControlResultV1Schema, APP_WELCOME_STAGES_V1, APP_WELCOME_STAGES_V5, appWelcomeBuildV1Schema } from './controls';

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
    expect(appControlReceiptV1Schema.safeParse({ state: 'recorded', message: 'Google connect is ready to begin.', navigation: '/c/AAAAAAAAAAAAAAAAAAAAAA?handoff=BBBBBBBBBBBBBBBBBBBBBB' }).success).toBe(true);
    expect(appControlReceiptV1Schema.safeParse({ state: 'recorded', message: 'Google connect is ready to begin.', navigation: '/c/AAAAAAAAAAAAAAAAAAAAAA', handoff: 'BBBBBBBBBBBBBBBBBBBBBB' }).success).toBe(false);
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
    expect(appControlProjectionV1Schema.safeParse({ version: 1, state: 'available', revision, view: 'account', data: { deletion_available: true, plan: 'free' } }).success).toBe(false);
    expect(appControlProjectionV1Schema.safeParse({ version: 1, state: 'available', revision, view: 'account', data: {} }).success).toBe(false);
  });
});

describe('controls revision 3: day-card state and Try again', () => {
  const card = { id: 'card:brief', name: 'The Brief', defaultTime: '08:00', time: '08:00', reason: 'planned', sent: false, pin: null };
  const day = (cards: object[]) => ({
    version: 1, state: 'available', revision, view: 'day',
    data: { timezone: 'Europe/London', date: '2026-10-27', cards, proactivity: { quiet_start: null, quiet_end: null, volume: 'normal' }, schedules: { daily_brief: true, followups: true, event_briefs: true, nightly: true, heartbeat: true } },
  });

  it('names a card being made, one that failed and one that is paused, unfinished, with a short reason and the tries left', () => {
    for (const state of ['generating', 'failed', 'paused'] as const)
      expect(appControlProjectionV1Schema.safeParse(day([{ ...card, state, state_reason: "Waldo couldn't reach its model this morning", retries_left: 3 }])).success).toBe(true);
    expect(appControlProjectionV1Schema.safeParse(day([{ ...card, sent: true, state: 'skipped', state_reason: "Waldo couldn't reach its model this morning", retries_left: 0 }])).success).toBe(true);
  });

  it('refuses a finished new state, an overlong reason and tries outside 0 to 3', () => {
    for (const invalid of [
      { ...card, sent: true, state: 'failed' }, { ...card, state: 'ready' },
      { ...card, state: 'failed', state_reason: 'x'.repeat(121) }, { ...card, state: 'failed', state_reason: '' },
      { ...card, retries_left: 4 }, { ...card, retries_left: -1 }, { ...card, retries_left: 1.5 },
    ]) expect(appControlProjectionV1Schema.safeParse(day([invalid])).success).toBe(false);
  });

  it('takes card.retry on the day view for one of the three cards, and nothing else', () => {
    const retry = { view: 'day', action: 'card.retry', id: 'card:brief', revision, request_id: 'request-0009' };
    for (const id of ['card:brief', 'card:midday', 'card:close']) expect(appControlActionV1Schema.safeParse({ ...retry, id }).success).toBe(true);
    for (const invalid of [
      { ...retry, id: 'card:nope' }, { ...retry, id: undefined }, { ...retry, view: 'connections' }, { ...retry, value: '08:00' }, { ...retry, volume: 'low' },
    ]) expect(appControlActionV1Schema.safeParse(invalid).success).toBe(false);
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

  it('takes the node actions, and they only it', () => {
    expect(appControlActionV1Schema.safeParse({ view: 'constellation', action: 'timezone.set', value: 'UTC', revision, request_id: 'request-0009' }).success).toBe(false);
    const act = (extra: object) => ({ view: 'constellation', revision, request_id: 'request-0010', ...extra });
    for (const valid of [
      act({ action: 'node.confirm', id: 'memory:node:7' }), act({ action: 'node.forget', id: 'memory:node:7' }),
      act({ action: 'node.correct', id: 'memory:node:7', value: 'Walks before lunch, not after' }),
      act({ action: 'node.correct', id: 'memory:node:7', value: 'x'.repeat(APP_NODE_CORRECTION_MAX_V1) }),
    ]) expect(appControlActionV1Schema.safeParse(valid).success).toBe(true);
    for (const invalid of [
      act({ action: 'node.confirm' }), act({ action: 'node.confirm', id: 'memory:claim:7' }), act({ action: 'node.forget', id: 'memory:node:0' }),
      act({ action: 'node.forget', id: 'memory:node:7', value: 'extra' }), act({ action: 'node.confirm', id: 'memory:node:7', volume: 'low' }),
      act({ action: 'node.correct', id: 'memory:node:7' }), act({ action: 'node.correct', id: 'memory:node:7', value: '   ' }),
      act({ action: 'node.correct', id: 'memory:node:7', value: 'x'.repeat(APP_NODE_CORRECTION_MAX_V1 + 1) }),
      { ...act({ action: 'node.forget', id: 'memory:node:7' }), view: 'day' },
    ]) expect(appControlActionV1Schema.safeParse(invalid).success).toBe(false);
  });

  const stages = { health: 'done', calendar: 'reading', mail: 'pending', web: 'skipped' };
  const welcome = { state: 'building', started_at: 1_761_400_000_000, finished_at: null, stages, nodes: 4 };
  it('carries the welcome build on the summary, and node sources and confirmation, all optional', () => {
    for (const data of [
      { ...valid[0], welcome }, { ...valid[0], welcome: { ...welcome, state: 'not_started', started_at: null, nodes: 0, stages: { health: 'pending', calendar: 'pending', mail: 'pending', web: 'pending' } } },
      { ...valid[0], welcome: { ...welcome, state: 'done', finished_at: 1_761_400_090_000, stages: { health: 'empty', calendar: 'revoked', mail: 'unavailable', web: 'skipped' } } },
      { ...valid[2], items: [{ ...node, sources: ['apple_health', 'calendar'], confirmation: 'waldos_read' }] },
      { ...valid[2], items: [{ ...node, sources: [], confirmation: 'confirmed' }] },
      { ...valid[4], item: { ...node, sources: ['gmail'], confirmation: 'waldos_read' } },
    ]) expect(appControlProjectionV1Schema.safeParse(view(data)).success).toBe(true);
    for (const data of [
      { ...valid[0], welcome: { ...welcome, state: 'failed' } }, { ...valid[0], welcome: { ...welcome, stages: { ...stages, web: 'failed' } } },
      { ...valid[0], welcome: { ...welcome, stages: { health: 'done', calendar: 'done', mail: 'done' } } }, { ...valid[0], welcome: { ...welcome, nodes: -1 } },
      { ...valid[0], welcome: { ...welcome, state: 'done', finished_at: null } }, { ...valid[0], welcome: { ...welcome, finished_at: 1 } },
      { ...valid[0], welcome: { ...welcome, state: 'not_started' } },
      { ...valid[2], items: [{ ...node, sources: ['web'] }] }, { ...valid[2], items: [{ ...node, confirmation: 'unverified' }] },
      { ...valid[1], welcome },
    ]) expect(appControlProjectionV1Schema.safeParse(view(data)).success).toBe(false);
  });
  it('takes no actions but the claim actions of controls revision 2', () => {
    expect(APP_CONTROLS_MEMORY_REVISION).toBe(2);
    for (const action of ['proactivity.set', 'channel.unlink', 'google.connect']) expect(appControlActionV1Schema.safeParse({ view: 'constellation', action, value: 'x', revision, request_id: 'request-0010' }).success).toBe(false);
  });

  it('shows a claim pinned to a block, unpinned, or without the field for revision 1', () => {
    for (const pinned of ['profile', 'facts', null, undefined]) expect(appControlProjectionV1Schema.safeParse(view({ ...valid[3], item: { ...claim, ...(pinned === undefined ? {} : { pinned }) } })).success).toBe(true);
    for (const pinned of ['', 'top', 1, true]) expect(appControlProjectionV1Schema.safeParse(view({ ...valid[1], items: [{ ...claim, pinned }] })).success, String(pinned)).toBe(false);
  });

  const act = (fields: object) => appControlActionV1Schema.safeParse({ view: 'constellation', revision, request_id: 'claim-0001', ...fields }).success;
  it('pins a claim to profile or facts, unpins it, and edits its text', () => {
    for (const valid of [
      { action: 'claim.pin', id: 'memory:claim:12', value: 'profile' }, { action: 'claim.pin', id: 'memory:claim:1', value: 'facts' },
      { action: 'claim.unpin', id: 'memory:claim:12' },
      { action: 'claim.edit', id: 'memory:claim:12', value: 'Runs on Tuesdays' }, { action: 'claim.edit', id: 'memory:claim:12', value: 'x'.repeat(APP_CLAIM_TEXT_MAX_V1) },
    ]) expect(act(valid), JSON.stringify(valid)).toBe(true);
  });

  it('refuses a claim action on another view, on an interpretation or a bad id, or with a bad value or extra fields', () => {
    for (const invalid of [
      { action: 'claim.pin', id: 'memory:claim:12', value: 'profile', view: 'day' }, { action: 'claim.pin', id: 'memory:node:12', value: 'profile' },
      { action: 'claim.pin', id: 'memory:claim:0', value: 'profile' }, { action: 'claim.pin', id: 'claim:12', value: 'profile' }, { action: 'claim.pin', value: 'profile' },
      { action: 'claim.pin', id: 'memory:claim:12' }, { action: 'claim.pin', id: 'memory:claim:12', value: 'top' },
      { action: 'claim.unpin', id: 'memory:claim:12', value: 'profile' }, { action: 'claim.unpin', id: 'memory:claim:12', volume: 'low' },
      { action: 'claim.edit', id: 'memory:claim:12' }, { action: 'claim.edit', id: 'memory:claim:12', value: '   ' },
      { action: 'claim.edit', id: 'memory:claim:12', value: 'x'.repeat(APP_CLAIM_TEXT_MAX_V1 + 1) },
      { action: 'claim.edit', id: 'memory:claim:12', value: 'Runs', confirmation: 'DELETE' }, { action: 'claim.forget', id: 'memory:claim:12' },
    ]) expect(act(invalid), JSON.stringify(invalid)).toBe(false);
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

describe("today's update cards", () => {
  const day = (extra: object) => ({
    version: 1, state: 'available', revision, view: 'day',
    data: { timezone: 'Europe/London', date: '2026-10-13', cards: [], proactivity: { quiet_start: null, quiet_end: null, volume: 'normal' }, schedules: { daily_brief: true, followups: true, event_briefs: true, nightly: true, heartbeat: true }, ...extra },
  });
  const update = { message_id: 'entry-9', delivered_at: 1_791_900_000_000, excerpt: 'The 3pm review moved to 4pm, so the afternoon block is shorter.' };
  const updates = (items: object[], total = items.length, checked_at: number | null = 1_791_900_600_000) => ({ updates: { items, total, checked_at } });
  const parses = (extra: object) => appControlProjectionV1Schema.safeParse(day(extra)).success;

  it('lists them like a card delivery with when Waldo last checked, and stays optional', () => {
    for (const valid of [
      {}, updates([]), updates([], 0, null), updates([update, { ...update, message_id: 'entry-8', excerpt: 'x'.repeat(280) }], 5),
      updates(Array.from({ length: 20 }, (_, i) => ({ ...update, message_id: `entry-${i}` })), 31),
    ]) expect(parses(valid), JSON.stringify(valid)).toBe(true);
  });

  it('refuses a malformed card, the full text, an inconsistent count and a check time that is not epoch ms', () => {
    const { excerpt: _excerpt, ...noExcerpt } = update;
    for (const invalid of [
      { updates: null }, { updates: { items: [], total: 0 } }, { updates: { items: [], checked_at: null } }, updates([update], 0), updates([], -1), updates([], 1.5),
      updates(Array.from({ length: 21 }, (_, i) => ({ ...update, message_id: `entry-${i}` })), 21),
      updates([{ ...update, excerpt: '' }]), updates([{ ...update, excerpt: 'x'.repeat(281) }]), updates([noExcerpt]), updates([{ ...update, text: 'the full card' }]),
      updates([{ ...update, source: 'gmail' }]), updates([{ ...update, message_id: '' }]), updates([{ ...update, delivered_at: 0 }]),
      updates([], 0, 0), updates([], 0, 1.5), updates([], 0, '2026-10-13T10:40:00Z' as unknown as number), { updates: { ...updates([]).updates, held: 2 } },
    ]) expect(parses(invalid), JSON.stringify(invalid)).toBe(false);
  });
});

describe('Granola from the app', () => {
  const connect = { view: 'connections', action: 'granola.connect', revision, request_id: 'granola-0001' };

  it('connects and disconnects from the connections view, naming nothing', () => {
    expect(appControlActionV1Schema.safeParse(connect).success).toBe(true);
    expect(appControlActionV1Schema.safeParse({ ...connect, action: 'granola.disconnect' }).success).toBe(true);
  });

  it('refuses another view, a server address or an id', () => {
    expect(appControlActionV1Schema.safeParse({ ...connect, view: 'day' }).success).toBe(false);
    expect(appControlActionV1Schema.safeParse({ ...connect, value: 'https://mcp.granola.ai/mcp' }).success).toBe(false);
    expect(appControlActionV1Schema.safeParse({ ...connect, action: 'granola.disconnect', id: 'connection-1' }).success).toBe(false);
    expect(appControlActionV1Schema.safeParse({ ...connect, volume: 'low' }).success).toBe(false);
    expect(appControlActionV1Schema.safeParse({ ...connect, action: 'granola.disconnect', confirmation: 'DELETE' }).success).toBe(false);
  });

  it('reads connections with or without Granola, so older Workers still parse', () => {
    expect(appControlProjectionV1Schema.safeParse(projection(connections)).success).toBe(true);
    expect(appControlProjectionV1Schema.safeParse(projection({ ...connections, granola: { connectAvailable: true, connection: null } })).success).toBe(true);
    expect(appControlProjectionV1Schema.safeParse(projection({ ...connections, granola: { connectAvailable: true, connection: { status: 'reauth_needed', connected_at: 1_761_400_000_000 } } })).success).toBe(true);
  });

  it('refuses a Granola state the app could misread', () => {
    expect(appControlProjectionV1Schema.safeParse(projection({ ...connections, granola: { connectAvailable: true, connection: { status: 'connected', connected_at: 1 } } })).success).toBe(false);
    expect(appControlProjectionV1Schema.safeParse(projection({ ...connections, granola: { connectAvailable: true, connection: null, email: 'owner@example.test' } })).success).toBe(false);
    expect(appControlProjectionV1Schema.safeParse(projection({ ...connections, granola: { connectAvailable: true } })).success).toBe(false);
  });
});

describe('catalogue apps from the app', () => {
  const connect = { view: 'connections', action: 'app.connect', id: 'notion', revision, request_id: 'app-connect-0001' };
  const tile = { id: 'notion', label: 'Notion', about: 'Search and read your pages and databases.', consent: 'Connecting here lets the tools Notion labels read-only run without asking.', connectAvailable: true, connection: null };
  const withApps = (apps: object[]) => projection({ ...connections, apps });

  it('connects and disconnects one tile by its catalogue id, from the connections view', () => {
    expect(appControlActionV1Schema.safeParse(connect).success).toBe(true);
    expect(appControlActionV1Schema.safeParse({ ...connect, action: 'app.disconnect', id: 'slack' }).success).toBe(true);
  });

  it.each([
    ['no id', { id: undefined }],
    ['an id that is not a catalogue id', { id: 'Notion' }],
    ['a server address in place of an id', { id: 'https://mcp.notion.com/mcp' }],
    ['a server address in value', { value: 'https://mcp.notion.com/mcp' }],
    ['another view', { view: 'day' }],
    ['a field it does not take', { volume: 'low' }],
    ['a confirmation', { confirmation: 'DELETE' }],
  ])('refuses an app action with %s', (_label, change) => {
    expect(appControlActionV1Schema.safeParse({ ...connect, ...change }).success).toBe(false);
    expect(appControlActionV1Schema.safeParse({ ...connect, action: 'app.disconnect', ...change }).success).toBe(false);
  });

  it('reads connections with or without apps, so older Workers still parse', () => {
    expect(appControlProjectionV1Schema.safeParse(withApps([])).success).toBe(true);
    expect(appControlProjectionV1Schema.safeParse(withApps([tile, { ...tile, id: 'granola', label: 'Granola', consent: null, connection: { status: 'reauth_needed', connected_at: 1_761_400_000_000 } }])).success).toBe(true);
  });

  it.each([
    ['an unknown status', { connection: { status: 'connected', connected_at: 1 } }],
    ['an empty label', { label: '' }],
    ['an empty consent (null means none)', { consent: '' }],
    ['a logo address', { logo: 'https://example.test/notion.png' }],
    ['the server address', { url: 'https://mcp.notion.com/mcp' }],
    ['no connection field', { connection: undefined }],
    ['an uppercase id', { id: 'Notion' }],
  ])('refuses a tile with %s', (_label, change) => {
    expect(appControlProjectionV1Schema.safeParse(withApps([{ ...tile, ...change }])).success).toBe(false);
  });

  it('carries revocation only on a recorded receipt', () => {
    for (const revocation of ['revoked', 'unsupported', 'failed']) expect(appControlReceiptV1Schema.safeParse({ state: 'recorded', message: 'Disconnected.', revocation }).success).toBe(true);
    expect(appControlReceiptV1Schema.safeParse({ state: 'rejected', message: 'No.', revocation: 'failed' }).success).toBe(false);
    expect(appControlReceiptV1Schema.safeParse({ state: 'recorded', message: 'Disconnected.', revocation: 'not_needed' }).success).toBe(false);
  });

  it('parses every example the app builds against', async () => {
    const fixture = (await import('./fixtures/connections-apps.v1.json')).default;
    const projections = [fixture.none_connected, fixture.one_active, fixture.one_reauth_needed];
    for (const example of projections) expect(appControlProjectionV1Schema.safeParse(example).success).toBe(true);
    expect(fixture.one_reauth_needed.data.apps.some((app) => app.connection?.status === 'reauth_needed')).toBe(true);
    expect(fixture.none_connected.data.apps.map((app) => app.id)).toEqual(['granola', 'notion', 'todoist', 'linear', 'slack']);
    for (const action of fixture.actions) expect(appControlActionV1Schema.safeParse(action).success).toBe(true);
    const results = [fixture.connect_result, fixture.already_connected_result, fixture.disconnect_revoked_result, fixture.disconnect_unsupported_result, fixture.disconnect_failed_result];
    for (const result of results) expect(appControlResultV1Schema.safeParse(result).success).toBe(true);
    expect(fixture.connect_result.receipt.navigation).toMatch(/^\/c\/[A-Za-z0-9_-]{22}\?handoff=[A-Za-z0-9_-]{22}$/);
    expect(fixture.already_connected_result.receipt).not.toHaveProperty('navigation');
    expect([fixture.disconnect_revoked_result, fixture.disconnect_unsupported_result, fixture.disconnect_failed_result].map((result) => result.receipt.revocation)).toEqual(['revoked', 'unsupported', 'failed']);
  });
});

describe('welcome constellation fixture', () => {
  it('parses every example the app builds against', async () => {
    const fixture = (await import('./fixtures/welcome-constellation.v1.json')).default;
    for (const projection of [fixture.summary_building, fixture.summary_done, fixture.interpretations_after_welcome, fixture.detail_node]) expect(appControlProjectionV1Schema.safeParse(projection).success).toBe(true);
    for (const action of fixture.actions) expect(appControlActionV1Schema.safeParse(action).success).toBe(true);
    expect(appControlResultV1Schema.safeParse(fixture.action_result).success).toBe(true);
  });

  it('carries the setup stage from revision 5 only as an added key; an unknown stage is refused', async () => {
    const fixture = (await import('./fixtures/welcome-constellation.v1.json')).default;
    const parsed = appControlProjectionV1Schema.safeParse(fixture.summary_setup_v5);
    expect(parsed.success).toBe(true);
    const welcome = fixture.summary_setup_v5.data.welcome;
    expect(welcome.stages.setup).toBe('done');
    expect(appWelcomeBuildV1Schema.safeParse({ ...welcome, stages: { ...welcome.stages, setup: undefined } }).success).toBe(true);
    expect(appWelcomeBuildV1Schema.safeParse({ ...welcome, stages: { ...welcome.stages, answers: 'done' } }).success).toBe(false);
    expect(APP_WELCOME_STAGES_V5).toEqual([...APP_WELCOME_STAGES_V1, 'setup']);
  });
});

describe('the phone view', () => {
  const send = { view: 'phone', action: 'phone.sms_send', revision, request_id: 'phone-0001' };
  const check = { view: 'phone', action: 'phone.sms_check', code: '424242', revision, request_id: 'phone-0002' };
  const data = { phone: '+919800000001', verified: false, sms: true, challenge: { state: 'pending', expires_at: 1_800_000_600, retry_at: null, checks_left: 5 }, actions: ['phone.sms_send', 'phone.sms_check'] };

  it('reads the number on file and acts on it with nothing but the code', () => {
    expect(appControlQueryV1Schema.safeParse({ view: 'phone' }).success).toBe(true);
    expect(appControlProjectionV1Schema.safeParse({ version: 1, state: 'available', revision, view: 'phone', data }).success).toBe(true);
    expect(appControlProjectionV1Schema.safeParse({ version: 1, state: 'available', revision, view: 'phone', data: { ...data, phone: null, challenge: null, actions: [] } }).success).toBe(true);
    expect(appControlActionV1Schema.safeParse(send).success).toBe(true);
    expect(appControlActionV1Schema.safeParse(check).success).toBe(true);
  });

  it('refuses a number, a malformed code, a code on a send, a check without one, or a phone action elsewhere', () => {
    for (const bad of [
      { ...send, value: '+14155550100' }, { ...send, id: '+14155550100' }, { ...send, phone: '+14155550100' }, { ...send, code: '424242' },
      { ...check, code: undefined }, { ...check, code: '4242' }, { ...check, code: '42424a' }, { ...check, code: ' 424242' },
      { ...send, view: 'connections' }, { ...check, view: 'account' }, { view: 'phone', action: 'timezone.set', value: 'UTC', revision, request_id: 'phone-0003' },
      { view: 'day', action: 'timezone.set', value: 'UTC', code: '424242', revision, request_id: 'phone-0004' },
    ]) expect(appControlActionV1Schema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it('refuses a malformed phone projection', () => {
    for (const bad of [{ ...data, phone: '98000 00001' }, { ...data, extra: true }, { ...data, actions: ['phone.sms_resend'] },
      { ...data, challenge: { ...data.challenge, state: 'sent' } }, { ...data, challenge: { ...data.challenge, checks_left: 6 } }, { ...data, challenge: { ...data.challenge, retry_at: undefined } }])
      expect(appControlProjectionV1Schema.safeParse({ version: 1, state: 'available', revision, view: 'phone', data: bad }).success, JSON.stringify(bad)).toBe(false);
  });

  const set = { view: 'phone', action: 'phone.set', value: '+919800000001', revision, request_id: 'phone-0005' };
  it('sets the number on file with phone.set, which carries the E.164 number in value and nothing else', () => {
    expect(appControlActionV1Schema.safeParse(set).success).toBe(true);
    expect(appControlProjectionV1Schema.safeParse({ version: 1, state: 'available', revision, view: 'phone', data: { ...data, phone: null, challenge: null, actions: ['phone.set'] } }).success).toBe(true);
  });

  it('sets up the number on file for iMessage with imessage.enroll, which carries nothing and is the phone view\'s alone', () => {
    const enroll = { view: 'phone', action: 'imessage.enroll', revision, request_id: 'phone-0009' };
    expect(appControlActionV1Schema.safeParse(enroll).success).toBe(true);
    expect(appControlProjectionV1Schema.safeParse({ version: 1, state: 'available', revision, view: 'phone', data: { ...data, actions: ['phone.set', 'imessage.enroll'] } }).success).toBe(true);
    for (const bad of [{ ...enroll, value: '+919800000001' }, { ...enroll, code: '424242' }, { ...enroll, id: 'imessage' }, { ...enroll, view: 'connections' }]) {
      expect(appControlActionV1Schema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    const messages = Object.values(APP_IMESSAGE_ENROLL_RECEIPTS_V1).map(receipt => receipt.message);
    expect(new Set(messages).size).toBe(messages.length);
    for (const message of messages) expect(message).not.toMatch(/\d/);
  });

  it('names the ways this server proves a number, and how the linked iMessage relates to it, without the handle', () => {
    const phone = (extra: Record<string, unknown>) => appControlProjectionV1Schema.safeParse({ version: 1, state: 'available', revision, view: 'phone', data: { ...data, ...extra } }).success;
    for (const proof of [[], ['sms'], ['imessage'], ['sms', 'imessage']]) expect(phone({ proof })).toBe(true);
    for (const from of ['none', 'number', 'email', 'other_number']) expect(phone({ proof: ['imessage'], imessage_from: from })).toBe(true);
    for (const bad of [{ proof: ['whatsapp'] }, { proof: 'sms' }, { proof: [null] }, { imessage_from: 'woof@heywaldo.in' }, { imessage_from: '0001' }, { imessage_from: null }]) {
      expect(phone(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('refuses a phone.set without a number, with a malformed one, with anything else, or elsewhere', () => {
    for (const bad of [
      { ...set, value: undefined }, { ...set, value: '' }, { ...set, value: '9800000001' }, { ...set, value: '+91 98000 00001' }, { ...set, value: '+0919800000001' },
      { ...set, value: '+9198' }, { ...set, value: `+91${'9'.repeat(14)}` }, { ...set, value: ' +919800000001' },
      { ...set, code: '424242' }, { ...set, id: 'phone' }, { ...set, confirmation: 'DELETE' }, { ...set, view: 'account' },
    ]) expect(appControlActionV1Schema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it('names one receipt per phone.set outcome, none of which repeats the number', () => {
    const receipts = Object.values(APP_PHONE_SET_RECEIPTS_V1);
    for (const receipt of receipts) expect(appControlReceiptV1Schema.parse(receipt)).toEqual(receipt);
    expect(new Set(receipts.map(receipt => receipt.message)).size).toBe(receipts.length);
    expect(APP_PHONE_SET_RECEIPTS_V1.set.state).toBe('recorded');
    expect(APP_PHONE_SET_RECEIPTS_V1.taken.state).toBe('rejected');
    expect(receipts.map(receipt => receipt.message).join(' ')).not.toMatch(/\d/);
  });
});

describe('controls revision 7: who the owner is, and Google disconnect', () => {
  const account = (data: object) => appControlProjectionV1Schema.safeParse({ version: 1, state: 'available', revision, view: 'account', data }).success;
  const day = (extra: object) => appControlProjectionV1Schema.safeParse({ version: 1, state: 'available', revision, view: 'day', data: { timezone: 'UTC', date: '2026-10-28', cards: [], proactivity: { quiet_start: null, quiet_end: null, volume: 'normal' },
    schedules: { daily_brief: true, followups: true, event_briefs: true, nightly: true, heartbeat: true }, ...extra } }).success;
  const disconnect = { view: 'connections', action: 'google.disconnect', id: 'conn-1', revision, request_id: 'google-disc-01' };

  it('is revision 7', () => expect(APP_CONTROLS_IDENTITY_REVISION).toBe(7));

  it('names the owner on the day view and on the account view, with the sign-in email and a verified phone', () => {
    expect(day({ name: 'Priya' })).toBe(true);
    expect(account({ deletion_available: true, name: 'Priya', email: 'priya@example.test', phone: '+919876543210' })).toBe(true);
    expect(account({ deletion_available: true, email: 'priya@example.test' })).toBe(true);
  });

  it('refuses an empty or oversized name, a malformed email or an unformatted phone', () => {
    expect(day({ name: '' })).toBe(false);
    expect(day({ name: 'x'.repeat(81) })).toBe(false);
    expect(account({ deletion_available: true, name: '' })).toBe(false);
    expect(account({ deletion_available: true, email: 'not-an-email' })).toBe(false);
    expect(account({ deletion_available: true, phone: '9876543210' })).toBe(false);
  });

  it('disconnects one Google account from the connections view, naming it in id and nothing else', () => {
    expect(appControlActionV1Schema.safeParse(disconnect).success).toBe(true);
  });

  it('refuses a Google disconnect without an id, from another view, or carrying anything else', () => {
    const { id: _id, ...bare } = disconnect;
    for (const action of [bare, { ...disconnect, id: '' }, { ...disconnect, id: 'x'.repeat(257) }, { ...disconnect, view: 'day' }, { ...disconnect, value: 'calendar' }, { ...disconnect, volume: 'low' }, { ...disconnect, confirmation: 'DELETE' }, { ...disconnect, code: '123456' }])
      expect(appControlActionV1Schema.safeParse(action).success).toBe(false);
  });
});

describe('the agent_mail view', () => {
  const claim = { view: 'agent_mail', action: 'agent_mail.claim', value: 'priya', notice: '2026-10-31', revision, request_id: 'mail-0001' };
  const release = { view: 'agent_mail', action: 'agent_mail.release', revision, request_id: 'mail-0002' };
  const notice = { version: '2026-10-31', text: 'What your Waldo address receives, and what Waldo keeps.' };
  const data = { enabled: true, domain: 'mail.example.invalid', handle: 'priya', address: 'priya@mail.example.invalid', rule: 'pending', notice, display_name: "Waldo, Priya's assistant", actions: ['agent_mail.claim', 'agent_mail.release'] };
  const unclaimed = { enabled: true, domain: 'mail.example.invalid', notice, display_name: 'Waldo', actions: ['agent_mail.claim'] };
  const off = { enabled: false, display_name: 'Waldo', actions: [] };
  const shows = (shown: object) => appControlProjectionV1Schema.safeParse({ version: 1, state: 'available', revision, view: 'agent_mail', data: shown }).success;

  it('is revision 10', () => expect(APP_CONTROLS_AGENT_MAIL_REVISION).toBe(10));

  it('reads the address, each rule state, and the notice a claim accepts', () => {
    expect(appControlQueryV1Schema.safeParse({ view: 'agent_mail' }).success).toBe(true);
    for (const rule of ['pending', 'live', 'failed', 'unknown']) expect(shows({ ...data, rule }), rule).toBe(true);
    for (const shown of [unclaimed, off, { ...data, rule_reason: 'not_configured' }]) expect(shows(shown), JSON.stringify(shown)).toBe(true);
  });

  it('refuses a rule state outside the four, and fields that do not belong together', () => {
    for (const bad of [{ ...data, rule: 'releasing' }, { ...data, rule: null }, { ...data, rule: 'LIVE' }, { ...data, extra: true }, { ...data, actions: ['agent_mail.rename'] },
      { ...data, display_name: '' }, { ...data, enabled: undefined }, { ...data, handle: null }, { ...unclaimed, rule: 'live' }, { ...unclaimed, handle: 'priya' },
      { ...data, rule: 'live', rule_reason: 'not_configured' }, { ...data, notice: undefined }, { ...off, domain: 'mail.example.invalid' }, { ...data, notice: { ...notice, version: 'v 1' } }])
      expect(shows(bad), JSON.stringify(bad)).toBe(false);
  });

  it('a claim names the handle and the notice version; a release names nothing', () => {
    expect(appControlActionV1Schema.safeParse(claim).success).toBe(true);
    expect(appControlActionV1Schema.safeParse({ ...claim, value: 'x'.repeat(APP_AGENT_MAIL_HANDLE_INPUT_MAX_V1) }).success).toBe(true);
    expect(appControlActionV1Schema.safeParse(release).success).toBe(true);
    for (const bad of [
      { ...claim, value: undefined }, { ...claim, value: '  ' }, { ...claim, value: 'x'.repeat(APP_AGENT_MAIL_HANDLE_INPUT_MAX_V1 + 1) }, { ...claim, notice: undefined }, { ...claim, notice: 'v 1' }, { ...claim, id: 'priya' },
      { ...claim, code: '424242' }, { ...release, value: 'priya' }, { ...release, notice: '2026-10-31' }, { ...release, id: 'priya' }, { ...claim, view: 'account' }, { ...release, view: 'phone' },
      { view: 'agent_mail', action: 'phone.set', value: '+14155550100', revision, request_id: 'mail-0003' },
    ]) expect(appControlActionV1Schema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it('every receipt reads apart from the others', () => {
    const messages = Object.values(APP_AGENT_MAIL_RECEIPTS_V1).map(receipt => receipt.message);
    expect(new Set(messages).size).toBe(messages.length);
    expect(APP_AGENT_MAIL_RECEIPTS_V1.unknown.state).toBe('unconfirmed');
  });
});

describe('where Waldo writes first, from the day view', () => {
  const set = (extra: object = {}) => ({ view: 'day', action: 'proactive_surface.set', value: 'whatsapp', revision, request_id: 'surface-0001', ...extra });
  const day = (extra: object) => ({
    version: 1, state: 'available', revision, view: 'day',
    data: { timezone: 'Europe/London', date: '2026-10-11', cards: [], proactivity: { quiet_start: null, quiet_end: null, volume: 'normal' }, schedules: { daily_brief: true, followups: true, event_briefs: true, nightly: true, heartbeat: true }, ...extra },
  });
  it('is revision 11', () => expect(APP_CONTROLS_PROACTIVE_SURFACE_REVISION).toBe(11));
  it('names one of the first run\'s surfaces in value, from the day view, and nothing else', () => {
    for (const value of ['app', 'whatsapp', 'both', 'app_imessage']) expect(appControlActionV1Schema.safeParse(set({ value })).success).toBe(true);
    for (const bad of [set({ value: undefined }), set({ value: 'telegram' }), set({ value: 'WhatsApp' }), set({ value: '' }), set({ view: 'connections' }), set({ view: 'account' }),
      set({ id: 'whatsapp' }), set({ volume: 'low' }), set({ confirmation: 'DELETE' }), set({ code: '123456' }), set({ notice: '2026-10-31' })]) expect(appControlActionV1Schema.safeParse(bad).success).toBe(false);
  });
  it('the day view says where Waldo writes and what can be chosen, and stays optional for a build below 11', () => {
    for (const valid of [{}, { proactive_surface: { value: 'app', choices: ['app'] } }, { proactive_surface: { value: 'whatsapp', choices: ['app', 'whatsapp', 'both'] } },
      // A chat unlinked since it was chosen is still named, though it is no longer offered.
      { proactive_surface: { value: 'both', choices: ['app'] } }]) expect(appControlProjectionV1Schema.safeParse(day(valid)).success).toBe(true);
    for (const invalid of [{ proactive_surface: { value: 'app', choices: [] } }, { proactive_surface: { value: 'app', choices: ['app', 'app'] } }, { proactive_surface: { value: 'telegram', choices: ['app'] } },
      { proactive_surface: { value: 'app' } }, { proactive_surface: { value: 'app', choices: ['app'], linked: true } }, { proactive_surface: 'app' }]) expect(appControlProjectionV1Schema.safeParse(day(invalid)).success).toBe(false);
  });
  it('has one fixed receipt per outcome, each a receipt the app can parse, with distinct messages', () => {
    for (const receipt of Object.values(APP_PROACTIVE_SURFACE_RECEIPTS_V1)) expect(appControlReceiptV1Schema.safeParse(receipt).success).toBe(true);
    const messages = Object.values(APP_PROACTIVE_SURFACE_RECEIPTS_V1).map(receipt => receipt.message);
    expect(new Set(messages).size).toBe(messages.length);
    expect([APP_PROACTIVE_SURFACE_RECEIPTS_V1.saved.state, APP_PROACTIVE_SURFACE_RECEIPTS_V1.whatsapp_not_linked.state]).toEqual(['recorded', 'rejected']);
  });
});
