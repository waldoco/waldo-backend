import { expect, it, vi } from 'vitest';
import { iMessageEventSchema } from '@waldo/contracts';
import { admitIMessageOwnerTurn, type IMessageAdmissionGrant } from '../src/channels/imessage/admission';
import type { OwnerRoute } from '../src/identity/owner-directory';
import type { OwnerTurnEnvelope } from '../src/channels/owner-turn-envelope';
import { syntheticIMessageBinding, syntheticIMessageEvents } from '../../contracts/src/channels/imessage-v1-fixtures';
import { createFixtureIMessageMediaStore, mediaScope, type IMessageMediaDeps, type IMessageMediaScope, type IMessageMediaStatus } from '../src/channels/imessage/media';
import { toBase64 } from '../src/channels/telegram-media';

const grant = { binding: syntheticIMessageBinding, revision: 'synthetic-revision', doName: 'synthetic-owner-do' };
const fixture = () => {
  const directory = { byPresence: vi.fn(async () => ({ doName: grant.doName, subject: grant.binding.subject, timezone: null })) };
  const authority = { resolve: vi.fn(() => grant as IMessageAdmissionGrant | null), current: vi.fn((_grant: IMessageAdmissionGrant) => true) };
  const admitted = vi.fn((_route: OwnerRoute, _turn: OwnerTurnEnvelope, _media: readonly IMessageMediaStatus[]) => undefined);
  return { directory, authority, admitted };
};
it('unknown or missing authority reaches no directory or private-context admission', async () => {
  const f = fixture();
  f.authority.resolve.mockReturnValue(null as never);
  await expect(admitIMessageOwnerTurn(syntheticIMessageEvents.text, f, f.admitted)).rejects.toThrow('not admitted');
  expect(f.directory.byPresence).not.toHaveBeenCalled(); expect(f.admitted).not.toHaveBeenCalled();
});
it('preserves ordered mixed attachments, captions and explicit ordinary/native audio unsupported results', async () => {
  const f = fixture();
  const files = await Promise.all(['image', 'document', 'audio', 'audio'].map(async (kind, i) => {
    const bytes = new TextEncoder().encode('synthetic-content-' + i);
    const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
    return { bytes, file: { reference: 'ref-' + i, sourceMessageGuid: syntheticIMessageEvents.text.messageGuid,
      filename: 'fixture-' + i, mimeType: kind + '/synthetic', byteLength: bytes.length, sha256,
      caption: 'caption-' + i, kind, nativeVoice: i === 3 } };
  }));
  const event = { ...syntheticIMessageEvents.text, text: '', attachments: files.map(f => f.file) };
  const store = createFixtureIMessageMediaStore(files.map(({ bytes, file }) => ({
    scope: mediaScope(grant, event as never, file as never), bytes, mimeType: file.mimeType, kind: file.kind as never,
  })), f.authority.current);
  const media: IMessageMediaDeps = { store, content: async (source, bytes) => {
    if (source.file.kind === 'audio') return { state: 'unsupported', reason: source.file.nativeVoice ? 'native_voice_unavailable' : 'audio_unavailable', mimeType: source.file.mimeType, kind: source.file.kind };
    return { state: 'loaded', mimeType: source.file.mimeType, kind: source.file.kind, attachment: {
      kind: source.file.kind === 'image' ? 'image' : 'file', mime_type: source.file.mimeType, filename: source.file.filename, data_base64: toBase64(bytes),
    } };
  } };
  await admitIMessageOwnerTurn(event, { ...f, media }, f.admitted);
  const [, turn, statuses] = f.admitted.mock.calls[0]!;
  expect(turn.attachments!.map(a => a.filename)).toEqual(['fixture-0', 'fixture-1']);
  expect(turn.attachmentRefs!.map(a => a.caption)).toEqual(['caption-0', 'caption-1', 'caption-2', 'caption-3']);
  expect(statuses.map((s: { state: string }) => s.state)).toEqual(['loaded', 'loaded', 'unsupported', 'unsupported']);
  expect(statuses[3]!.scope.file.nativeVoice).toBe(true);
});
it.each([
  { senderHandle: 'forged-handle' }, { bridgeId: 'wrong-bridge' }, { accountId: 'wrong-account' }, { chatGuid: 'wrong-chat' },
  { isGroup: true }, { service: 'SMS' }, { service: 'RCS' }, { isFromMe: true },
])('refuses hostile sender/service/audience scope before owner lookup: %j', async change => {
  const f = fixture();
  await expect(admitIMessageOwnerTurn({ ...syntheticIMessageEvents.text, ...change }, f, f.admitted)).rejects.toThrow('not admitted');
  expect(f.directory.byPresence).not.toHaveBeenCalled(); expect(f.admitted).not.toHaveBeenCalled();
});
it('revoked authority and absent authority fail closed', async () => {
  const f = fixture(); f.authority.current.mockReturnValue(false);
  await expect(admitIMessageOwnerTurn(syntheticIMessageEvents.text, f, f.admitted)).rejects.toThrow('not admitted');
  await expect(admitIMessageOwnerTurn(syntheticIMessageEvents.text, { directory: f.directory }, f.admitted)).rejects.toThrow('not admitted');
  expect(f.directory.byPresence).not.toHaveBeenCalled(); expect(f.admitted).not.toHaveBeenCalled();
});
it.each(['revoke', 'replace-account'])('fences %s while owner lookup is awaited', async mode => {
  const f = fixture(); let active = grant;
  f.authority.current.mockImplementation(g => JSON.stringify(g) === JSON.stringify(active));
  f.directory.byPresence.mockImplementation(async () => {
    active = mode === 'revoke' ? null as never : { ...grant, revision: 'replacement', binding: { ...grant.binding, accountId: 'replacement' } };
    return { doName: grant.doName, subject: grant.binding.subject, timezone: null };
  });
  await expect(admitIMessageOwnerTurn(syntheticIMessageEvents.text, f, f.admitted)).rejects.toThrow('not admitted');
  expect(f.admitted).not.toHaveBeenCalled();
});
it('rejects a foreign or missing directory owner rather than falling back', async () => {
  const f = fixture(); f.directory.byPresence.mockResolvedValue({ doName: 'other-owner', subject: grant.binding.subject, timezone: null });
  await expect(admitIMessageOwnerTurn(syntheticIMessageEvents.text, f, f.admitted)).rejects.toThrow('not admitted');
  f.directory.byPresence.mockResolvedValue(null as never);
  await expect(admitIMessageOwnerTurn(syntheticIMessageEvents.text, f, f.admitted)).rejects.toThrow('not admitted');
  expect(f.admitted).not.toHaveBeenCalled();
});
const mediaFixture = async () => {
  const f = fixture(); const bytes = new TextEncoder().encode('fixture-image-bytes');
  const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
  const file = { reference: 'opaque-reference', sourceMessageGuid: syntheticIMessageEvents.text.messageGuid,
    filename: 'fixture.png', mimeType: 'image/png', byteLength: bytes.length, sha256, caption: 'original caption', kind: 'image' as const, nativeVoice: false };
  const event = iMessageEventSchema.parse({ ...syntheticIMessageEvents.text, attachments: [file] });
  const scope = mediaScope(grant, event, file);
  const store = createFixtureIMessageMediaStore([{ scope, bytes, mimeType: file.mimeType, kind: file.kind }], f.authority.current);
  const content = vi.fn(async (_scope: IMessageMediaScope, input: Uint8Array) => ({
    state: 'loaded' as const, kind: file.kind, mimeType: file.mimeType,
    attachment: { kind: 'image' as const, filename: file.filename, mime_type: file.mimeType, data_base64: toBase64(input) },
  }));
  return { ...f, bytes, file, event, scope, media: { store, content } };
};
it.each(['issue', 'read', 'content'] as const)('rechecks revocation after awaited media %s before private-context admission', async step => {
  const f = await mediaFixture();
  if (step === 'content') {
    f.media.content.mockImplementation(async () => { f.authority.current.mockReturnValue(false); return { state: 'loaded', kind: f.file.kind, mimeType: f.file.mimeType, attachment: { kind: 'image', filename: f.file.filename, mime_type: f.file.mimeType, data_base64: toBase64(f.bytes) } }; });
  } else {
    const original = f.media.store[step];
    f.media.store = { ...f.media.store, [step]: async (...args: never[]) => {
      const result = await (original as (...args: never[]) => Promise<unknown>)(...args);
      f.authority.current.mockReturnValue(false); return result;
    } } as typeof f.media.store;
  }
  await expect(admitIMessageOwnerTurn(f.event, f, f.admitted)).rejects.toThrow('not admitted');
  expect(f.admitted).not.toHaveBeenCalled();
});
it.each(['hash', 'size', 'type', 'kind', 'source', 'path', 'url'])('rejects mismatched or abusive media %s', async change => {
  const f = await mediaFixture();
  const altered = { ...f.file, ...(change === 'hash' ? { sha256: '0'.repeat(64) } : change === 'size' ? { byteLength: f.file.byteLength + 1 } :
    change === 'type' ? { mimeType: 'text/plain' } : change === 'kind' ? { kind: 'document' } : change === 'source' ? { sourceMessageGuid: 'foreign-message' } :
    { reference: change === 'path' ? '../../private/chat.db' : 'http://169.254.169.254/latest/meta-data' }) };
  const event = { ...f.event, attachments: [altered] };
  if (['hash', 'size', 'type', 'kind'].includes(change)) {
    f.media.store = { issue: async () => ({}), read: async () => ({ bytes: f.bytes, mimeType: f.file.mimeType, kind: f.file.kind }) };
  }
  await expect(admitIMessageOwnerTurn(event, f, f.admitted)).rejects.toThrow();
  expect(f.admitted).not.toHaveBeenCalled();
});
it('tickets are one-use and bound to owner/presence/account/chat/source/revision with no ambient authority', async () => {
  const f = await mediaFixture();
  const ticket = await f.media.store.issue(f.scope);
  for (const key of ['ownerId', 'presenceId', 'bridgeId', 'accountId', 'chatGuid']) {
    const changed = { ...f.scope, grant: { ...grant, binding: { ...grant.binding, [key]: 'foreign' } } };
    await expect(f.media.store.read(ticket, changed)).rejects.toThrow('ticket rejected');
  }
  await expect(f.media.store.read(ticket, { ...f.scope, partIndex: f.scope.partIndex + 1 })).rejects.toThrow('ticket rejected');
  await expect(f.media.store.read(ticket, { ...f.scope, grant: { ...grant, revision: 'stale' } })).rejects.toThrow('ticket rejected');
  await expect(f.media.store.read({}, f.scope)).rejects.toThrow('ticket rejected');
  await f.media.store.read(ticket, f.scope);
  await expect(f.media.store.read(ticket, f.scope)).rejects.toThrow('ticket rejected');
  const fresh = await f.media.store.issue(f.scope); f.authority.current.mockReturnValue(false);
  await expect(f.media.store.read(fresh, f.scope)).rejects.toThrow('ticket rejected');
  await expect(createFixtureIMessageMediaStore([]).issue(f.scope)).rejects.toThrow('ticket rejected');
});
it('excess source arrays fail before directory/media work and never truncate', async () => {
  const f = await mediaFixture();
  const issue = vi.spyOn(f.media.store, 'issue');
  await expect(admitIMessageOwnerTurn({ ...f.event, attachments: Array.from({ length: 5 }, () => f.file) }, f, f.admitted)).rejects.toThrow('excess');
  expect(f.directory.byPresence).not.toHaveBeenCalled(); expect(issue).not.toHaveBeenCalled(); expect(f.admitted).not.toHaveBeenCalled();
});
it('a content adapter cannot swap bytes or disguise native audio as an image', async () => {
  const f = await mediaFixture();
  f.media.content.mockImplementation(async (_scope, bytes) => {
    bytes[0] = bytes[0]! ^ 1; return { state: 'loaded', kind: f.file.kind, mimeType: f.file.mimeType,
      attachment: { kind: 'image', filename: f.file.filename, mime_type: f.file.mimeType, data_base64: toBase64(bytes) } };
  });
  await expect(admitIMessageOwnerTurn(f.event, f, f.admitted)).rejects.toThrow('mismatch');
  await expect(admitIMessageOwnerTurn({ ...f.event, attachments: [{ ...f.file, nativeVoice: true }] }, f, f.admitted)).rejects.toThrow('mismatch');
  expect(f.admitted).not.toHaveBeenCalled();
});
it('directory route mutation during media work cannot cross the owner boundary', async () => {
  const f = await mediaFixture();
  const route = { doName: grant.doName, subject: grant.binding.subject, timezone: null };
  f.directory.byPresence.mockResolvedValue(route);
  const original = f.media.content.getMockImplementation()!;
  f.media.content.mockImplementation(async (scope, bytes) => {
    route.doName = 'foreign-owner'; route.subject = 'foreign-subject'; return original(scope, bytes);
  });
  await admitIMessageOwnerTurn(f.event, f, f.admitted);
  expect(f.admitted.mock.calls[0]![0]).toEqual({ doName: grant.doName, subject: grant.binding.subject, timezone: null });
});
it.each(['identical', 'conflicting'])('ambiguous %s duplicate references reject before owner lookup', async kind => {
  const f = await mediaFixture();
  const duplicate = kind === 'identical' ? f.file : { ...f.file, filename: 'different.png', sha256: '0'.repeat(64) };
  await expect(admitIMessageOwnerTurn({ ...f.event, attachments: [f.file, duplicate] }, f, f.admitted)).rejects.toThrow('ambiguous');
  expect(f.directory.byPresence).not.toHaveBeenCalled(); expect(f.admitted).not.toHaveBeenCalled();
});
it('account replacement while reading media invalidates the old grant before admission', async () => {
  const f = await mediaFixture(); let active = grant;
  f.authority.current.mockImplementation(g => JSON.stringify(g) === JSON.stringify(active));
  const original = f.media.store.read;
  f.media.store = { ...f.media.store, read: async (ticket, scope) => {
    const source = await original(ticket, scope);
    active = { ...grant, revision: 'new-account-revision', binding: { ...grant.binding, accountId: 'new-account' } };
    return source;
  } };
  await expect(admitIMessageOwnerTurn(f.event, f, f.admitted)).rejects.toThrow('not admitted');
  expect(f.media.content).not.toHaveBeenCalled(); expect(f.admitted).not.toHaveBeenCalled();
});
