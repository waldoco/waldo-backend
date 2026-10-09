import { expect, it, vi } from 'vitest';
import { iMessageEventSchema } from '@waldo/contracts';
import { syntheticIMessageEvents } from '../../contracts/src/channels/imessage-v1-fixtures';
import { fixture, digest } from './connector-fixtures';
import { createRelayAdmitter, type RelayAdmitterDeps } from '../../runtime/src/channels/imessage/relay-ingest';
import { createFixtureIMessageMediaStore, mediaScope } from '../../runtime/src/channels/imessage/media';
import { correlateReceipt } from '../src/connector/receipts';
function setup(decision: 'acknowledge' | 'hold' = 'acknowledge') {
    const f = fixture(), grant = { binding: f.account.binding, revision: 'synthetic-revision', doName: 'synthetic-owner-do' };
    const authority = { resolve: vi.fn(() => grant as typeof grant | null), current: vi.fn(() => true) };
    const directory = { byPresence: vi.fn(async () => ({ doName: grant.doName, subject: grant.binding.subject, timezone: null })) };
    const onAdmittedTurn = vi.fn(), receiptSink = vi.fn(), nonTurnSink = vi.fn(), onNotAdmitted = vi.fn(() => decision);
    const deps: RelayAdmitterDeps = { admission: { authority, directory }, onAdmittedTurn, receiptSink, nonTurnSink, onNotAdmitted };
    let sequence = 0;
    const admit = (input: unknown = syntheticIMessageEvents.text) => { const event = iMessageEventSchema.parse({ ...input as object, eventId: 'synthetic-event-' + (++sequence), cursor: { databaseGeneration: 'fixture-generation', value: 'synthetic-cursor-' + sequence } }); const r = f.signed(event); f.relay.admit(r.body, r.headers); return r; };
    return { ...f, grant, authority, directory, deps, onAdmittedTurn, receiptSink, nonTurnSink, onNotAdmitted, admit, flush: () => f.relay.flush(createRelayAdmitter(deps)) };
}
it('I1/I8 real signed admit/flush enters seam once, exact raw digest acknowledged', async () => { const f = setup(); const r = f.admit(); expect(f.relayStore.snapshot().events[0]!.digest).toBe(digest(r.body)); await f.flush(); expect(f.onAdmittedTurn).toHaveBeenCalledTimes(1); expect(f.onAdmittedTurn.mock.calls[0]![1]).toMatchObject({ surface: 'imessage' }); expect(f.relayStore.snapshot().events[0]!.state).toBe('acknowledged'); await f.flush(); expect(f.onAdmittedTurn).toHaveBeenCalledTimes(1); });
it('I2 receipts reach correlated/uncorrelated sink with no turn', async () => { const f = setup(); f.mailboxStore.transaction(s => s.sentMessages.push({ bridgeId: f.account.binding.bridgeId, accountId: f.account.binding.accountId, messageGuid: 'synthetic-guid', commandId: 'synthetic-command', state: 'local_recorded' })); const evidence: Array<{
    commandId: string | null;
    classification: string;
}> = []; f.deps = { ...f.deps, receiptSink: event => { const c = correlateReceipt(f.mailboxStore, event); evidence.push({ ...c, classification: c.commandId ? 'correlated' : 'uncorrelated' }); } }; const { text, attachments, kind, ...base } = syntheticIMessageEvents.text; for (const messageGuid of ['synthetic-guid', 'synthetic-unmatched'])
    f.admit({ ...base, kind: 'receipt', state: 'read', target: { ...f.command().target, messageGuid } }); await f.relay.flush(createRelayAdmitter(f.deps)); expect(evidence).toEqual([{ commandId: 'synthetic-command', classification: 'correlated' }, { commandId: null, classification: 'uncorrelated' }]); expect(f.onAdmittedTurn).not.toHaveBeenCalled(); expect(f.directory.byPresence).not.toHaveBeenCalled(); });
it('I3 every non-message kind acknowledges without directory or turn', async () => { const f = setup(); const { text, attachments, kind, ...base } = syntheticIMessageEvents.text; for (const event of [syntheticIMessageEvents.customReaction, syntheticIMessageEvents.edit, { ...base, kind: 'typing', active: true }, { ...base, kind: 'poll', pollGuid: 'synthetic-poll', action: 'unknown', options: [], selectedOptionIds: [] }, { ...base, kind: 'unsupported', bundleId: 'synthetic-bundle' }])
    f.admit(event); await f.flush(); expect(f.nonTurnSink).toHaveBeenCalledTimes(5); expect(f.onAdmittedTurn).not.toHaveBeenCalled(); expect(f.directory.byPresence).not.toHaveBeenCalled(); expect(f.relayStore.snapshot().events.every(e => e.state === 'acknowledged')).toBe(true); });
it.each(['acknowledge', 'hold'] as const)('I4 unknown sender policy %s preserves order and no lookup', async (decision) => { const f = setup(decision); f.authority.resolve.mockReturnValue(null); f.admit(); f.admit(); if (decision === 'hold') {
    await expect(f.flush()).rejects.toThrow('held');
    expect(f.relayStore.snapshot().events.map(e => e.state)).toEqual(['pending', 'pending']);
    expect(f.onNotAdmitted).toHaveBeenCalledTimes(1);
}
else {
    await f.flush();
    expect(f.onNotAdmitted).toHaveBeenCalledTimes(2);
    expect(f.relayStore.snapshot().events.every(e => e.state === 'acknowledged')).toBe(true);
} expect(f.directory.byPresence).not.toHaveBeenCalled(); expect(f.onAdmittedTurn).not.toHaveBeenCalled(); });
it.each(['directory', 'media'] as const)('I5 revocation after %s blocks callback', async (step) => { const f = setup(); if (step === 'directory') {
    f.directory.byPresence.mockImplementation(async () => { f.authority.current.mockReturnValue(false); return { doName: f.grant.doName, subject: f.grant.binding.subject, timezone: null }; });
    f.admit();
}
else {
    const bytes = new TextEncoder().encode('synthetic-media');
    const hash = digest('synthetic-media');
    const file = { reference: 'synthetic-ref', sourceMessageGuid: syntheticIMessageEvents.text.messageGuid, filename: 'synthetic-file', mimeType: 'image/synthetic', byteLength: bytes.length, sha256: hash, kind: 'image' as const, nativeVoice: false };
    const event = iMessageEventSchema.parse({ ...syntheticIMessageEvents.text, attachments: [file] });
    const admittedEvent = iMessageEventSchema.parse(JSON.parse(f.admit(event).body));
    const store = createFixtureIMessageMediaStore([{ scope: mediaScope(f.grant, admittedEvent, file), bytes, mimeType: file.mimeType, kind: file.kind }], f.authority.current);
    const read = store.read;
    f.deps = { ...f.deps, admission: { ...f.deps.admission, media: { store: { ...store, read: async (ticket, scope) => { const result = await read(ticket, scope); f.authority.current.mockReturnValue(false); return result; } }, content: async () => { throw Error('synthetic-unreachable'); } } } };
} await f.relay.flush(createRelayAdmitter(f.deps)); expect(f.onAdmittedTurn).not.toHaveBeenCalled(); expect(f.onNotAdmitted).toHaveBeenCalledWith(expect.anything(), 'not_admitted'); });
it.each([{ isGroup: true }, { service: 'SMS' }, { service: 'RCS' }, { isFromMe: true }])('I6 excluded audience/service %j never becomes turn', async (patch) => { const f = setup(); f.admit({ ...syntheticIMessageEvents.text, ...patch }); await f.flush(); expect(f.onAdmittedTurn).not.toHaveBeenCalled(); expect(f.directory.byPresence).not.toHaveBeenCalled(); expect(f.onNotAdmitted).toHaveBeenCalledWith(expect.anything(), 'not_admitted'); });
it('I7 absent rejection policy fails at construction', () => { const f = setup(); expect(() => createRelayAdmitter({ ...f.deps, onNotAdmitted: undefined } as never)).toThrow('policy_required'); });
it('callback failures, even admission-shaped errors, stay pending', async () => { const f = setup(); f.onAdmittedTurn.mockRejectedValue(Error('iMessage turn not admitted')); f.admit(); await expect(f.flush()).rejects.toThrow('not admitted'); expect(f.onNotAdmitted).not.toHaveBeenCalled(); expect(f.relayStore.snapshot().events[0]!.state).toBe('pending'); });
it('media unavailable is a reason code; hold policy retains body', async () => { const f = setup('hold'); f.admit(syntheticIMessageEvents.audio); await expect(f.flush()).rejects.toThrow('held'); expect(f.onNotAdmitted).toHaveBeenCalledWith(expect.anything(), 'media_unavailable'); expect(f.relayStore.snapshot().events[0]!.body).toBeDefined(); });
