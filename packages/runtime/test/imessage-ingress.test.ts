import { describe, expect, it } from 'vitest';
import { syntheticIMessageBinding, syntheticIMessageEvents } from '../../contracts/src/channels/imessage-v1-fixtures';
import { admittedIMessageTurn } from '../src/channels/imessage/ingress';
import { ownerTurnAttachments } from '../src/channels/owner-turn-envelope';
it('normalizes already-admitted opaque iMessage identities without fabricated numeric updates', () => {
  const turn = admittedIMessageTurn(syntheticIMessageEvents.replyPart, syntheticIMessageBinding);
  expect(turn.messageRef).toEqual({ id: 'fixture-message', conversationRef: turn.conversationRef, bridgeRef: 'fixture-bridge', accountRef: 'fixture-account', partIndex: 2, threadOriginatorId: 'fixture-thread' });
  expect(turn.service).toBe('iMessage');
  expect(turn.replyTo?.sourceTaint).toBe('external');
  expect(turn.replyTo?.messageId).toBe('fixture-parent');
});
describe('iMessage admitted seam fail closed', () => {
  it.each([
    { ...syntheticIMessageEvents.text, accountId: 'other' },
    { ...syntheticIMessageEvents.text, senderHandle: 'unknown@example.invalid' },
    { ...syntheticIMessageEvents.text, service: 'SMS' },
    { ...syntheticIMessageEvents.text, service: 'RCS' },
    { ...syntheticIMessageEvents.text, isFromMe: true },
    syntheticIMessageEvents.group, syntheticIMessageEvents.customReaction, syntheticIMessageEvents.edit,
  ])('refuses unsupported, shared, unbound or cross-account turns', event => {
    expect(() => admittedIMessageTurn(event, syntheticIMessageBinding)).toThrow();
  });
  it('rejects absent/unverified binding before any responder exists', () => {
    for (const binding of [null, { ...syntheticIMessageBinding, verified: false }]) expect(() => admittedIMessageTurn(syntheticIMessageEvents.text, binding)).toThrow();
  });
  it('preserves attachment-only ordered refs without fetching private media', () => {
    const turn = admittedIMessageTurn(syntheticIMessageEvents.multipleFiles, syntheticIMessageBinding);
    expect(turn.attachmentRefs?.map(a => a.reference)).toEqual(['fixture-photo', 'fixture-document']);
    expect(ownerTurnAttachments(turn)).toBeUndefined();
    expect(admittedIMessageTurn(syntheticIMessageEvents.audio, syntheticIMessageBinding).text).toBe('');
  });
  it('preserves singleton compatibility and rejects ambiguous or excess loaded media', () => {
    const a = { kind: 'image' as const, filename: 'fixture.png', mime_type: 'image/png', data_base64: 'AA==' };
    const turn = admittedIMessageTurn(syntheticIMessageEvents.text, syntheticIMessageBinding);
    expect(ownerTurnAttachments({ ...turn, attachment: a })).toEqual([a]);
    expect(ownerTurnAttachments({ ...turn, attachments: [a, { ...a, filename: 'second.png' }] })?.map(a => a.filename)).toEqual(['fixture.png', 'second.png']);
    expect(() => ownerTurnAttachments({ ...turn, attachment: a, attachments: [a] })).toThrow();
    expect(() => ownerTurnAttachments({ ...turn, attachments: [a, a, a, a, a] })).toThrow();
  });
});
it('rejects group audience declared by the trusted binding even when event claims private', () => {
  expect(() => admittedIMessageTurn(syntheticIMessageEvents.text, { ...syntheticIMessageBinding, conversationKind: 'group' })).toThrow();
});
