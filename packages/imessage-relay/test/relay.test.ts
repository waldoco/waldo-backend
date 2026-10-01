import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RelayStore } from '../src/store';
import { SignedRelay, signRelayRequest } from '../src/relay';
import { syntheticIMessageBinding, syntheticIMessageEvents } from '../../contracts/src/channels/imessage-v1-fixtures';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const policy = { maxRecords: 32, maxSpoolBytes: 20000, maxRequestBytes: 4000, signatureMaxAgeMs: 1000, heartbeatExpiryMs: 1000, mutationDeadlineMs: 20, source: 'synthetic test policy, not a live default' };
const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), 'waldo-imessage-')); dirs.push(dir);
  const file = join(dir, 'relay.sqlite'); const store = new RelayStore(file);
  const account = { binding: syntheticIMessageBinding, key: 'synthetic-signing-key-only' };
  const relay = new SignedRelay(store, policy, () => account, () => 1000);
  const raw = JSON.stringify(syntheticIMessageEvents.text);
  const headers = signRelayRequest(raw, { version: 1, bridgeId: account.binding.bridgeId, accountId: account.binding.accountId, atMs: 1000, nonce: 'fixture-nonce' }, account.key);
  return { file, store, relay, raw, headers, account };
};
it('durably admits once before ACK, retaining cursor and conflict evidence across restart', () => {
  const f = fixture();
  expect(f.relay.admit(f.raw, f.headers)).toMatchObject({ state: 'admitted' });
  f.store.close();
  const reopened = new RelayStore(f.file);
  try {
    const relay = new SignedRelay(reopened, policy, () => f.account, () => 1000);
    expect(relay.admit(f.raw, f.headers)).toMatchObject({ state: 'duplicate' });
    expect(relay.cursor(f.account.binding.bridgeId, f.account.binding.accountId, 'fixture-generation')).toBe('1');
    const changed = JSON.stringify({ ...syntheticIMessageEvents.text, text: 'conflicting bytes' });
    expect(() => relay.admit(changed, signRelayRequest(changed, { ...f.headers, nonce: 'new-nonce' }, f.account.key))).toThrow('conflict');
    expect(reopened.snapshot().events).toHaveLength(1);
  } finally { reopened.close(); }
});

import { vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { disabledIMessageCapabilities, iMessageResultSchema, type IMessageCapabilities, type IMessageResult } from '@waldo/contracts';
import { syntheticIMessageCommand } from '../../contracts/src/channels/imessage-v1-fixtures';
import { MockTransport, ImsgRelayTransport } from '../src/transport';
const signed = (f: ReturnType<typeof fixture>, input: unknown, nonce: string, atMs = 1000) => {
  const raw = JSON.stringify(input);
  return { raw, headers: signRelayRequest(raw, { version: 1, bridgeId: f.account.binding.bridgeId, accountId: f.account.binding.accountId, atMs, nonce }, f.account.key) };
};
const heartbeat = (f: ReturnType<typeof fixture>, generation = 'fixture-generation', status = 'online') => {
  const r = signed(f, { version: 1, bridgeId: f.account.binding.bridgeId, accountId: f.account.binding.accountId, databaseGeneration: generation, status }, `heartbeat-${generation}-${status}`);
  f.relay.heartbeat(r.raw, r.headers);
};
const caps = (): IMessageCapabilities => {
  const c = disabledIMessageCapabilities(syntheticIMessageBinding.bridgeId, syntheticIMessageBinding.accountId);
  return { ...c, readiness: 'ready', features: Object.fromEntries(Object.entries(c.features).map(([k, v]) => [k, { ...v, receive: true, send: true, exactTarget: true, verified: true, probeReference: 'synthetic-probe-only' }])) as IMessageCapabilities['features'] };
};
const commandRequest = (f: ReturnType<typeof fixture>, commandId = 'fixture-command') => signed(f, { ...syntheticIMessageCommand(), commandId }, `nonce-${commandId}`);

it('authenticates raw bytes before malformed JSON and rejects stale, future, wrong key/account and oversized requests', () => {
  const f = fixture();
  try {
    expect(() => f.relay.admit('{', f.headers)).toThrow('authentication');
    expect(() => f.relay.admit(f.raw, { ...f.headers, atMs: 0 })).toThrow('authentication');
    const stale = signRelayRequest(f.raw, { ...f.headers, atMs: 0 }, f.account.key);
    const lateRelay = new SignedRelay(f.store, policy, () => f.account, () => 2001);
    expect(() => lateRelay.admit(f.raw, stale)).toThrow('stale');
    expect(() => f.relay.admit(f.raw, signRelayRequest(f.raw, { ...f.headers, atMs: 1001 }, f.account.key))).toThrow('stale');
    expect(() => f.relay.admit(f.raw, signRelayRequest(f.raw, f.headers, 'wrong-key'))).toThrow('authentication');
    expect(() => f.relay.admit(f.raw, { ...f.headers, accountId: 'other-account' })).toThrow('authentication');
    expect(() => f.relay.admit('x'.repeat(policy.maxRequestBytes + 1), f.headers)).toThrow('too large');
    expect(f.store.snapshot().events).toEqual([]);
  } finally { f.store.close(); }
});
it('rejects nonce reuse across signed event identities without changing the cursor', () => {
  const f = fixture();
  try {
    f.relay.admit(f.raw, f.headers);
    const r = signed(f, { ...syntheticIMessageEvents.text, eventId: 'other-event', cursor: { ...syntheticIMessageEvents.text.cursor, value: '2' } }, 'fixture-nonce');
    expect(() => f.relay.admit(r.raw, r.headers)).toThrow('nonce replay');
    expect(f.relay.cursor(f.headers.bridgeId, f.headers.accountId, 'fixture-generation')).toBe('1');
  } finally { f.store.close(); }
});
it('backpressure never ACKs or advances cursor and duplicates remain readable at capacity', () => {
  const f = fixture();
  try {
    const relay = new SignedRelay(f.store, { ...policy, maxRecords: 2 }, () => f.account, () => 1000);
    relay.admit(f.raw, f.headers);
    expect(relay.admit(f.raw, f.headers).state).toBe('duplicate');
    const next = signed(f, { ...syntheticIMessageEvents.text, eventId: 'full-event', cursor: { ...syntheticIMessageEvents.text.cursor, value: '2' } }, 'full-nonce');
    expect(() => relay.admit(next.raw, next.headers)).toThrow('backpressure');
    expect(relay.cursor(f.headers.bridgeId, f.headers.accountId, 'fixture-generation')).toBe('1');
    const tooSmall = new SignedRelay(f.store, { ...policy, maxSpoolBytes: 1 }, () => f.account, () => 1000);
    expect(() => tooSmall.admit(next.raw, next.headers)).toThrow('backpressure');
    expect(f.store.snapshot().events).toHaveLength(1);
  } finally { f.store.close(); }
});
it('real SQLite write failure rolls back event, nonce and cursor instead of ACKing', () => {
  const f = fixture(); const faults = new DatabaseSync(f.file);
  try {
    faults.exec("CREATE TRIGGER reject_state BEFORE UPDATE ON relay_state BEGIN SELECT RAISE(ABORT,'synthetic storage failure'); END");
    expect(() => f.relay.admit(f.raw, f.headers)).toThrow('synthetic storage failure');
    expect(f.store.snapshot().events).toEqual([]);
    expect(f.store.snapshot().nonces).toEqual([]);
    expect(f.relay.cursor(f.headers.bridgeId, f.headers.accountId, 'fixture-generation')).toBeNull();
  } finally { faults.close(); f.store.close(); }
});
it('database replacement invalidates cursor while retaining pending old-generation evidence', () => {
  const f = fixture();
  try {
    f.relay.admit(f.raw, f.headers);
    const replaced = signed(f, { ...syntheticIMessageEvents.text, eventId: 'replacement-event', cursor: { databaseGeneration: 'replacement-generation', value: '1' } }, 'replacement-nonce');
    expect(() => f.relay.admit(replaced.raw, replaced.headers)).toThrow('generation mismatch');
    heartbeat(f, 'replacement-generation');
    expect(f.relay.cursor(f.headers.bridgeId, f.headers.accountId, 'fixture-generation')).toBeNull();
    expect(f.relay.cursor(f.headers.bridgeId, f.headers.accountId, 'replacement-generation')).toBeNull();
    expect(f.relay.admit(replaced.raw, replaced.headers).state).toBe('admitted');
    expect(f.store.snapshot().events).toHaveLength(2);
  } finally { f.store.close(); }
});
it('cloud admission loss and mismatched receipts retain spool; replay commits cloud admission once', async () => {
  const f = fixture();
  try {
    f.relay.admit(f.raw, f.headers);
    await expect(f.relay.flush(async () => { throw new Error('fixture network loss'); })).rejects.toThrow('network loss');
    await expect(f.relay.flush(async () => ({ admitted: true, eventId: 'wrong', digest: 'wrong' }))).rejects.toThrow('receipt mismatch');
    expect(f.store.snapshot().events[0]?.state).toBe('pending');
    const cloud = new Set<string>(); let lose = true;
    const admitCloud = async (body: string) => {
      const event = JSON.parse(body); const digest = createHash('sha256').update(body).digest('hex');
      cloud.add(event.eventId);
      if (lose) { lose = false; throw new Error('lost ACK after durable cloud admission'); }
      return { admitted: true as const, eventId: event.eventId, digest };
    };
    await expect(f.relay.flush(admitCloud)).rejects.toThrow('lost ACK');
    await f.relay.flush(admitCloud);
    expect(cloud.size).toBe(1);
    expect(f.store.snapshot().events[0]).toMatchObject({ state: 'acknowledged', bytes: 0 });
    expect(f.store.snapshot().events[0]?.body).toBeUndefined();
    expect(f.relay.admit(f.raw, f.headers).state).toBe('duplicate');
  } finally { f.store.close(); }
});
it('signed heartbeats expire honestly and old nonce/timestamp replays cannot reconnect', () => {
  const f = fixture(); let now = 1000; const relay = new SignedRelay(f.store, policy, () => f.account, () => now);
  try {
    expect(relay.online(f.headers.bridgeId, f.headers.accountId)).toBe(false);
    const b = signed(f, { version: 1, bridgeId: f.headers.bridgeId, accountId: f.headers.accountId, databaseGeneration: 'fixture-generation', status: 'online' }, 'beat1');
    relay.heartbeat(b.raw, b.headers);
    expect(relay.online(f.headers.bridgeId, f.headers.accountId)).toBe(true);
    now = 1001;
    const next = signed(f, JSON.parse(b.raw), 'beat2', now); relay.heartbeat(next.raw, next.headers);
    const reuse = signed(f, JSON.parse(b.raw), 'beat1', now);
    expect(() => relay.heartbeat(reuse.raw, reuse.headers)).toThrow('nonce replay');
    expect(() => relay.heartbeat(b.raw, b.headers)).toThrow();
    now = 2002; expect(relay.online(f.headers.bridgeId, f.headers.accountId)).toBe(false);
  } finally { f.store.close(); }
});
it('offline and unverified transport never start a native mutation', async () => {
  const f = fixture(); const r = commandRequest(f); const transport = new MockTransport(caps());
  try {
    expect(await f.relay.execute(r.raw, r.headers, transport)).toMatchObject({ state: 'rejected', disposition: 'not_started', reason: 'relay_offline' });
    heartbeat(f);
    const unverified = new MockTransport(disabledIMessageCapabilities(f.headers.bridgeId, f.headers.accountId));
    expect(await f.relay.execute(r.raw, r.headers, unverified)).toMatchObject({ state: 'rejected', disposition: 'not_started' });
    expect(transport.executions).toBe(0); expect(unverified.executions).toBe(0);
  } finally { f.store.close(); }
});
it('persists immutable command before fixture execution and never reexecutes a local_recorded command', async () => {
  const f = fixture(); heartbeat(f); const r = commandRequest(f);
  const transport = new MockTransport(caps(), async c => {
    expect(f.store.snapshot().commands[0]).toMatchObject({ state: 'started', command: c, body: r.raw });
    return { version: 1, commandId: c.commandId, target: c.target, state: 'local_recorded', messageGuid: 'fixture-native-guid', evidence: { kind: 'local_database', reference: 'synthetic-local-row' } };
  });
  try {
    expect(await f.relay.execute(r.raw, r.headers, transport)).toMatchObject({ state: 'local_recorded' });
    expect(await f.relay.execute(r.raw, r.headers, transport)).toMatchObject({ state: 'local_recorded' });
    expect(transport.executions).toBe(1);
    const changed = signed(f, { ...JSON.parse(r.raw), text: 'changed command bytes' }, 'changed-command');
    await expect(f.relay.execute(changed.raw, changed.headers, transport)).rejects.toThrow('command conflict');
  } finally { f.store.close(); }
});
it('mutation timeout persists poison, late success cannot clear it, and read work stays available', async () => {
  const f = fixture(); heartbeat(f); const r = commandRequest(f); let finish!: (r: IMessageResult) => void;
  const transport = new MockTransport(caps(), () => new Promise(resolve => { finish = resolve; }));
  try {
    expect(await f.relay.execute(r.raw, r.headers, transport)).toMatchObject({ state: 'unknown', disposition: 'still_in_flight' });
    const next = commandRequest(f, 'next-command');
    expect(await f.relay.execute(next.raw, next.headers, transport)).toMatchObject({ state: 'rejected', disposition: 'not_started', reason: 'mutation_lane_poisoned' });
    finish(iMessageResultSchema.parse({ version: 1, commandId: 'fixture-command', target: syntheticIMessageCommand().target, state: 'local_recorded', messageGuid: 'late-guid', evidence: { kind: 'local_database', reference: 'late-row' } }));
    await Promise.resolve();
    expect(f.store.snapshot().commands[0]?.state).toBe('quarantined');
    expect(transport.executions).toBe(1);
    expect((await transport.probe()).readiness).toBe('ready');
    expect(await transport.history('fixture-generation', '1')).toEqual({ generation: 'fixture-generation', cursor: '1', events: [] });
  } finally { f.store.close(); }
});
it('reopening a started journal quarantines it without native execution', async () => {
  const f = fixture(); heartbeat(f); const request = commandRequest(f); const command = syntheticIMessageCommand();
  f.store.transaction(state => { state.commands.push({ identity: JSON.stringify([f.headers.bridgeId, f.headers.accountId, command.commandId]), bridgeId: f.headers.bridgeId, accountId: f.headers.accountId, nonce: request.headers.nonce, digest: createHash('sha256').update(request.raw).digest('hex'), body: request.raw, bytes: Buffer.byteLength(request.raw), command, state: 'started', result: { version: 1, commandId: command.commandId, target: command.target, state: 'started' } }); });
  f.store.close(); const reopened = new RelayStore(f.file);
  try {
    const relay = new SignedRelay(reopened, policy, () => f.account, () => 1000); const transport = new MockTransport(caps());
    expect(await relay.execute(request.raw, request.headers, transport)).toMatchObject({ state: 'unknown', reason: 'recovered_started_mutation' });
    expect(transport.executions).toBe(0);
  } finally { reopened.close(); }
});
it('probed exact-target and optional media/native features are each required', async () => {
  const f = fixture(); heartbeat(f);
  try {
    for (const feature of ['text', 'files', 'native_voice', 'formatting', 'effects', 'replies'] as const) {
      const c = syntheticIMessageCommand(); if (c.operation !== 'send') throw new Error('fixture send');
      const command = { ...c, commandId: `gate-${feature}`, target: { ...c.target, messageGuid: 'exact-target', partIndex: 0 }, attachments: [{ ...syntheticIMessageEvents.audio.attachments[0], nativeVoice: true }], formatting: [{ start: 0, length: 1, style: 'bold' }], effect: 'fixture-effect' };
      const cap = caps(); cap.features[feature].verified = false;
      const transport = new MockTransport(cap); const r = signed(f, command, `gate-${feature}`);
      expect(await f.relay.execute(r.raw, r.headers, transport)).toMatchObject({ state: 'rejected', reason: 'capability_unverified' }); expect(transport.executions).toBe(0);
    }
    const c = syntheticIMessageCommand(); if (c.operation !== 'send') throw new Error('fixture send');
    const reaction = { version: 1, commandId: 'reaction', ownerId: c.ownerId, binding: c.binding, target: { ...c.target, messageGuid: 'exact-target', partIndex: 2 }, service: 'iMessage', allowSMSFallback: false, operation: 'react', action: 'add', reaction: { kind: 'custom', emoji: '🦉' } };
    const cap = caps(); cap.features.custom_reactions.exactTarget = false; const transport = new MockTransport(cap); const r = signed(f, reaction, 'reaction');
    expect(await f.relay.execute(r.raw, r.headers, transport)).toMatchObject({ state: 'rejected' }); expect(transport.executions).toBe(0);
  } finally { f.store.close(); }
});
it('imsg skeleton parses matched JSON-RPC status, keeps live features off and refuses native history/mutation', async () => {
  const calls: string[] = [];
  const transport = new ImsgRelayTransport('fixture-bridge', 'fixture-account', async line => {
    calls.push(line); const request = JSON.parse(line);
    return JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocol_version: 1, version: 'pinned-fixture', methods: ['status', 'send'], supported_methods: ['status', 'send'], database: { ready: true } } });
  });
  expect((await transport.probe()).readiness).toBe('unverified');
  expect((await transport.probe()).features.text.send).toBe(false);
  await expect(transport.history('fixture-generation', null)).rejects.toThrow('unverified');
  expect(await transport.execute(syntheticIMessageCommand())).toMatchObject({ state: 'rejected', disposition: 'not_started' });
  expect(calls.every(line => JSON.parse(line).method === 'status' && line.endsWith('\n'))).toBe(true);
  const bad = new ImsgRelayTransport('fixture-bridge', 'fixture-account', async () => JSON.stringify({ jsonrpc: '2.0', id: 'wrong', result: {} }));
  await expect(bad.probe()).rejects.toThrow('unavailable');
});
it('bounded probe timeout is proved not_started rather than mutation uncertainty', async () => {
  const f = fixture(); heartbeat(f); const r = commandRequest(f);
  const transport = new MockTransport(caps()); vi.spyOn(transport, 'probe').mockImplementation(() => new Promise(() => {}));
  try { expect(await f.relay.execute(r.raw, r.headers, transport)).toMatchObject({ state: 'rejected', disposition: 'not_started', reason: 'probe_unavailable' }); expect(transport.executions).toBe(0); }
  finally { f.store.close(); }
});
it.each(['identical', 'conflicting'])('transactional dedupe fences %s concurrent commands after a delayed probe', async kind => {
  const f = fixture(); heartbeat(f); const first = commandRequest(f);
  const second = signed(f, { ...JSON.parse(first.raw), ...(kind === 'conflicting' ? { text: 'different signed bytes' } : {}) }, 'second-concurrent-nonce');
  const transport = new MockTransport(caps()); let probes = 0; let release!: (c: IMessageCapabilities) => void;
  vi.spyOn(transport, 'probe').mockImplementation(async () => {
    if (++probes === 2) return new Promise(resolve => { release = resolve; });
    return caps();
  });
  try {
    const one = f.relay.execute(first.raw, first.headers, transport);
    const two = f.relay.execute(second.raw, second.headers, transport);
    await one; release(caps());
    if (kind === 'conflicting') await expect(two).rejects.toThrow('command conflict');
    else expect(await two).toMatchObject({ state: 'local_recorded' });
    expect(transport.executions).toBe(1); expect(f.store.snapshot().commands).toHaveLength(1);
  } finally { f.store.close(); }
});
it('sticker files require their own verified native capability', async () => {
  const f = fixture(); heartbeat(f); const c = syntheticIMessageCommand(); if (c.operation !== 'send') throw new Error('fixture send');
  const command = { ...c, attachments: [{ ...syntheticIMessageEvents.multipleFiles.attachments[0], kind: 'sticker' }] };
  const r = signed(f, command, 'sticker-nonce'); const cap = caps(); cap.features.stickers.send = false; cap.features.stickers.verified = false;
  const transport = new MockTransport(cap);
  try { expect(await f.relay.execute(r.raw, r.headers, transport)).toMatchObject({ state: 'rejected', reason: 'capability_unverified' }); expect(transport.executions).toBe(0); }
  finally { f.store.close(); }
});
it('all eight signed synthetic event shapes spool without becoming owner turns', () => {
  const f = fixture();
  try {
    for (const [name, event] of Object.entries(syntheticIMessageEvents)) {
      const request = signed(f, event, `shape-${name}`); expect(f.relay.admit(request.raw, request.headers).state).toBe('admitted');
    }
    expect(f.store.snapshot().events).toHaveLength(8);
  } finally { f.store.close(); }
});
it('a poisoned account cannot poison an independently bound account lane', async () => {
  const f = fixture(); const other = { binding: { ...f.account.binding, accountId: 'second-account', ownerId: 'second-owner', presenceId: 'second-presence', subject: 'second@example.invalid' }, key: 'second-synthetic-key' };
  const relay = new SignedRelay(f.store, policy, (_bridge, account) => account === f.account.binding.accountId ? f.account : other, () => 1000);
  const sign = (input: unknown, account: typeof f.account, nonce: string) => {
    const body = JSON.stringify(input); return { body, h: signRelayRequest(body, { version: 1, bridgeId: account.binding.bridgeId, accountId: account.binding.accountId, atMs: 1000, nonce }, account.key) };
  };
  try {
    for (const account of [f.account, other]) {
      const b = sign({ version: 1, bridgeId: account.binding.bridgeId, accountId: account.binding.accountId, databaseGeneration: 'fixture-generation', status: 'online' }, account, 'heartbeat'); relay.heartbeat(b.body, b.h);
    }
    const original = commandRequest(f);
    const poison = new MockTransport(caps(), async c => ({ version: 1, commandId: c.commandId, target: c.target, state: 'unknown', disposition: 'may_have_completed', reason: 'fixture-uncertainty' }));
    expect(await relay.execute(original.raw, original.headers, poison)).toMatchObject({ state: 'unknown' });
    const c = syntheticIMessageCommand(); const independent = { ...c, ownerId: other.binding.ownerId, binding: other.binding, target: { ...c.target, accountId: other.binding.accountId } };
    const r = sign(independent, other, 'independent-command'); const cap = caps(); cap.accountId = other.binding.accountId; const transport = new MockTransport(cap);
    expect(await relay.execute(r.body, r.h, transport)).toMatchObject({ state: 'local_recorded' }); expect(transport.executions).toBe(1);
    const spoof = sign({ ...independent, ownerId: f.account.binding.ownerId }, other, 'cross-owner'); await expect(relay.execute(spoof.body, spoof.h, transport)).rejects.toThrow(); expect(transport.executions).toBe(1);
  } finally { f.store.close(); }
});
it('command journal failure starts no transport, and mismatched native receipt quarantines', async () => {
  const f = fixture(); heartbeat(f); const transport = new MockTransport(caps()); const r = commandRequest(f); const faults = new DatabaseSync(f.file);
  try {
    faults.exec("CREATE TRIGGER reject_command BEFORE UPDATE ON relay_state BEGIN SELECT RAISE(ABORT,'synthetic command persistence failure'); END");
    await expect(f.relay.execute(r.raw, r.headers, transport)).rejects.toThrow('persistence failure'); expect(transport.executions).toBe(0);
    faults.exec('DROP TRIGGER reject_command');
    const dishonest = new MockTransport(caps(), async c => ({ version: 1, commandId: 'wrong-command', target: c.target, state: 'local_recorded', messageGuid: 'wrong-result', evidence: { kind: 'local_database', reference: 'fixture-result' } }));
    expect(await f.relay.execute(r.raw, r.headers, dishonest)).toMatchObject({ state: 'unknown' }); expect(f.store.snapshot().commands[0]?.state).toBe('quarantined');
  } finally { faults.close(); f.store.close(); }
});
it('proved not_started rejection permits a new explicit command but never silently retries the old one', async () => {
  const f = fixture(); heartbeat(f); const transport = new MockTransport(caps(), async c => ({ version: 1, commandId: c.commandId, target: c.target, state: 'rejected', disposition: 'not_started', reason: 'fixture-permission-denied' }));
  try {
    const first = commandRequest(f); expect(await f.relay.execute(first.raw, first.headers, transport)).toMatchObject({ state: 'rejected' });
    expect(await f.relay.execute(first.raw, first.headers, transport)).toMatchObject({ state: 'rejected' }); expect(transport.executions).toBe(1);
    const next = commandRequest(f, 'explicit-next-command'); expect(await f.relay.execute(next.raw, next.headers, transport)).toMatchObject({ state: 'rejected' }); expect(transport.executions).toBe(2);
  } finally { f.store.close(); }
});
it('rejects trusted group targets until owner audience policy exists, without GUID guessing', async () => {
  const f = fixture(); heartbeat(f); const account = { ...f.account, binding: { ...f.account.binding, conversationKind: 'group' as const } };
  const relay = new SignedRelay(f.store, policy, () => account, () => 1000);
  const c = syntheticIMessageCommand(); const r = signed(f, { ...c, binding: account.binding }, 'group-target'); const transport = new MockTransport(caps());
  try { expect(await relay.execute(r.raw, r.headers, transport)).toMatchObject({ state: 'rejected', disposition: 'not_started', reason: 'group_audience_unavailable' }); expect(transport.executions).toBe(0); }
  finally { f.store.close(); }
});
it('revocation while probing prevents journaling or execution', async () => {
  const f = fixture(); heartbeat(f); let permitted = true;
  const relay = new SignedRelay(f.store, policy, () => permitted ? f.account : null, () => 1000);
  const transport = new MockTransport(caps()); vi.spyOn(transport, 'probe').mockImplementation(async () => { permitted = false; return caps(); });
  const r = commandRequest(f);
  try { expect(await relay.execute(r.raw, r.headers, transport)).toMatchObject({ state: 'rejected', reason: 'relay_binding_changed' }); expect(transport.executions).toBe(0); expect(f.store.snapshot().commands).toEqual([]); }
  finally { f.store.close(); }
});
it('mock history returns synthetic normalized shapes and rejects a foreign generation/cursor', async () => {
  const transport = new MockTransport(caps());
  const page = await transport.history('fixture-generation', null);
  expect(page.events).toHaveLength(8); expect(page.cursor).toBe('1');
  expect((await transport.history('fixture-generation', page.cursor)).events).toEqual([]);
  await expect(transport.history('replacement-generation', null)).rejects.toThrow('cursor mismatch');
  await expect(transport.history('fixture-generation', 'foreign-cursor')).rejects.toThrow('cursor mismatch');
});
