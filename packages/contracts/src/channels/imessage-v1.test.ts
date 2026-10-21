import { describe, expect, it } from 'vitest';
import { opaqueIMessageIdSchema } from './imessage-v1';
describe('iMessage v1 identifiers', () => {
  it('preserves opaque GUIDs and rejects blank, numeric and control-bearing IDs', () => {
    expect(opaqueIMessageIdSchema.parse('iMessage;+;chat-opaque')).toBe('iMessage;+;chat-opaque');
    for (const invalid of ['', ' ', 42, 'guid\n', ' guid']) expect(opaqueIMessageIdSchema.safeParse(invalid).success).toBe(false);
  });
});

import { iMessageEventSchema, iMessageCommandSchema, iMessageResultSchema, disabledIMessageCapabilities, iMessageCapabilitiesSchema } from './imessage-v1';
import { syntheticIMessageEvents, syntheticIMessageCommand } from './imessage-v1-fixtures';
describe('iMessage v1 synthetic protocol', () => {
  it.each(Object.entries(syntheticIMessageEvents))('preserves %s fixture identity without transport coercion', (_name, input) => {
    const parsed = iMessageEventSchema.parse(input);
    expect(parsed.messageGuid).toBe(input.messageGuid);
    expect(parsed).toEqual(input);
  });
  it('preserves URL instruction, reply parts and ordered attachment-only media', () => {
    expect(iMessageEventSchema.parse(syntheticIMessageEvents.urlBalloon)).toMatchObject({ text: 'Read https://example.invalid/research and compare it', messageGuid: 'fixture-message' });
    expect(iMessageEventSchema.parse(syntheticIMessageEvents.replyPart).partIndex).toBe(2);
    const media = iMessageEventSchema.parse(syntheticIMessageEvents.multipleFiles);
    expect('attachments' in media && media.attachments.map(a => a.reference)).toEqual(['fixture-photo', 'fixture-document']);
    expect(syntheticIMessageEvents.audio.attachments[0].nativeVoice).toBe(false);
  });
  it.each(['SMS', 'RCS'])('keeps %s distinct from iMessage', service => {
    expect(iMessageEventSchema.parse({ ...syntheticIMessageEvents.text, service }).service).toBe(service);
    expect(iMessageCommandSchema.safeParse({ ...syntheticIMessageCommand(), service }).success).toBe(false);
  });
  it('rejects unsupported operations, fallback, identity and attachment mismatch', () => {
    const c = syntheticIMessageCommand();
    for (const bad of [{ ...c, operation: 'apple_pay' }, { ...c, allowSMSFallback: true }, { ...c, ownerId: 'other' }, { ...c, target: { ...c.target, accountId: 'other' } }, { ...c, target: { ...c.target, chatGuid: 'other' } }, { ...c, target: { ...c.target, bridgeId: 'other' } }]) expect(iMessageCommandSchema.safeParse(bad).success).toBe(false);
    expect(iMessageEventSchema.safeParse({ ...syntheticIMessageEvents.customReaction, target: { ...syntheticIMessageEvents.customReaction.target, accountId: 'other' } }).success).toBe(false);
    expect(iMessageEventSchema.safeParse({ ...syntheticIMessageEvents.audio, attachments: [{ ...syntheticIMessageEvents.audio.attachments[0], sourceMessageGuid: 'other' }] }).success).toBe(false);
    expect(iMessageEventSchema.safeParse({ ...syntheticIMessageEvents.text, kind: 'apple_pay' }).success).toBe(false);
  });
  it('requires exact mutation targets and external actor metadata', () => {
    const c = syntheticIMessageCommand();
    expect(iMessageCommandSchema.safeParse({ ...c, operation: 'edit', attachments: undefined }).success).toBe(false);
    expect(iMessageEventSchema.safeParse({ ...syntheticIMessageEvents.customReaction, actorHandle: undefined }).success).toBe(false);
  });
  it('never upgrades a local record into recipient delivery', () => {
    const c = syntheticIMessageCommand();
    const record = { version: 1, commandId: c.commandId, target: c.target, state: 'local_recorded', messageGuid: 'actual-guid', evidence: { kind: 'local_database', reference: 'fixture-record' } };
    expect(iMessageResultSchema.parse(record).state).toBe('local_recorded');
    expect(iMessageResultSchema.safeParse({ ...record, state: 'delivered' }).success).toBe(false);
    expect(iMessageResultSchema.safeParse({ ...record, state: 'delivered', evidence: undefined }).success).toBe(false);
  });
  it('defaults every live feature off and requires evidence for verified probes', () => {
    const caps = disabledIMessageCapabilities('bridge', 'account');
    expect(Object.values(caps.features).every(f => !f.receive && !f.send && !f.verified && !f.exactTarget)).toBe(true);
    expect(iMessageCapabilitiesSchema.safeParse({ ...caps, features: { ...caps.features, text: { ...caps.features.text, verified: true } } }).success).toBe(false);
  });
});
it('rejects empty sends, invalid formatting ranges and path-bearing filenames', () => {
  const c = syntheticIMessageCommand();
  expect(iMessageCommandSchema.safeParse({ ...c, text: '', attachments: [] }).success).toBe(false);
  expect(iMessageCommandSchema.safeParse({ ...c, formatting: [{ start: 0, length: ('text' in c ? c.text.length : 0) + 1, style: 'bold' }] }).success).toBe(false);
  for (const filename of ['/Users/private/file.pdf', '../file.pdf', 'a\\file.pdf', '.', '..']) {
    expect(iMessageEventSchema.safeParse({ ...syntheticIMessageEvents.audio, attachments: [{ ...syntheticIMessageEvents.audio.attachments[0], filename }] }).success).toBe(false);
  }
});
it('requires a declared trusted audience without deriving it from opaque chat GUIDs', () => {
  const c = syntheticIMessageCommand();
  expect(iMessageCommandSchema.safeParse({ ...c, binding: { ...c.binding, conversationKind: undefined } }).success).toBe(false);
});
