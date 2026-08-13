import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';
import { buildResponsibilityPresenceChannelV04Bundle } from './responsibility-presence-channel-v0-4-fixtures';
import {
  channelAdapterRefV04Schema, conversationCommandRequestV04Schema, deliverySettlementV04Schema,
  normalizedInboundEnvelopeV04Schema, presenceRefV04Schema, responsibilityCaptureCommandRequestV04Schema,
  surfaceCapabilityManifestV04Schema,
} from './responsibility-presence-channel-v0-4';

const digest = `sha256:${'a'.repeat(64)}`;
const manifest = { id: 'channel_manifest', version: '1.0.0', digest };
const adapter = { category: 'channel_adapter', id: 'fake_channel', version: '1.0.0', manifest };
const inbound = { protocolVersion: '0.4', trust: 'untrusted_content', adapter,
  sourceAccountRef: 'external_account', conversationRef: 'conversation', messageRef: 'message',
  dedupeKey: 'dedupe', content: 'Please capture this.', contentDigest: digest,
  receivedAt: '2026-08-13T12:00:00.000Z' };

describe('responsibility presence/channel v0.4', () => {
  it('round-trips shared fake consumers and compiles JSON Schema', () => {
    for (const consumer of ['desktop', 'mobile', 'telegram', 'discord']) {
      expect(normalizedInboundEnvelopeV04Schema.parse({ ...inbound, messageRef: `${consumer}_message` }).trust)
        .toBe('untrusted_content');
    }
    const ajv = new Ajv2020({ strict: false });
    expect(ajv.compile(surfaceCapabilityManifestV04Schema.toJSONSchema())({
      protocolVersion: '0.4', id: 'surface', version: '1.0.0', commands: ['conversation.send'],
      projections: ['conversation'], offlineCommands: 'none',
    })).toBe(true);
  });

  it('keeps adapter categories pairwise distinct', () => {
    expect(presenceRefV04Schema.safeParse(adapter).success).toBe(false);
    expect(channelAdapterRefV04Schema.safeParse({ category: 'presence', id: 'p', registrationRevision: 1 }).success).toBe(false);
  });

  it.each(['ownerId', 'authorityGrant', 'credential', 'acceptance', 'closure', 'rawHealth', 'fullTranscript', 'composedPrompt'])
  ('rejects forbidden untrusted field %s', (field) => {
    expect(normalizedInboundEnvelopeV04Schema.safeParse({ ...inbound, [field]: 'attacker' }).success).toBe(false);
  });

  it('keeps transport settlement observation-only', () => {
    const base = { protocolVersion: '0.4', id: 'settlement', ownerId: 'owner', deliveryIntentId: 'intent',
      deliveryIntentRevision: 1, adapter, state: 'delivered', transportMessageRef: 'remote_message',
      observationDigest: digest, observedAt: '2026-08-13T12:01:00.000Z' };
    expect(deliverySettlementV04Schema.parse(base).state).toBe('delivered');
    expect(deliverySettlementV04Schema.safeParse({ ...base, outcomeState: 'completed' }).success).toBe(false);
  });

  it('keeps conversation and capture commands strict and non-authoritative', () => {
    const base = { protocolVersion: '0.4', requestId: 'request', presenceRegistrationId: 'presence', clientIssuedAt: '2026-08-13T12:00:00.000Z' };
    expect(conversationCommandRequestV04Schema.safeParse({ ...base, commandType: 'conversation.send', payload: { content: 'hello', contentDigest: digest }, ownerId: 'owner' }).success).toBe(false);
    expect(responsibilityCaptureCommandRequestV04Schema.parse({ ...base, commandType: 'responsibility.capture', payload: { userStatement: 'Handle this', statementDigest: digest } }).commandType).toBe('responsibility.capture');
  });

  it('rejects every catalogued presence/channel attack at its declared boundary', () => {
    const bundle = buildResponsibilityPresenceChannelV04Bundle(() => 'a'.repeat(64));
    const catalogue = JSON.parse(bundle['presence-channel.rejections.json']!) as {
      cases: Array<{ name: string; value: unknown }>;
    };
    expect(catalogue.cases.map(({ name }) => name)).toEqual([
      'client-owned-authority',
      'transport-done-closes-outcome',
      'channel-as-presence',
    ]);
    const validators = [normalizedInboundEnvelopeV04Schema, deliverySettlementV04Schema, presenceRefV04Schema];
    catalogue.cases.forEach(({ name, value }, index) => {
      expect(validators[index]!.safeParse(value).success, name).toBe(false);
    });
  });
});
