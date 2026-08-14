import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';
import { buildResponsibilityPresenceChannelV04Bundle } from './responsibility-presence-channel-v0-4-fixtures';
import {
  channelAdapterRefV04Schema,
  conversationCommandRequestV04Schema,
  deliverySettlementV04Schema,
  normalizedInboundEnvelopeV04Schema,
  presenceRefV04Schema,
  responsibilityCaptureCommandRequestV04Schema,
  surfaceCapabilityManifestV04Schema,
} from './responsibility-presence-channel-v0-4';

const digest = `sha256:${'a'.repeat(64)}`;
const manifest = { id: 'channel_manifest', version: '1.0.0', digest };
const adapter = { category: 'channel_adapter', id: 'fake_channel', version: '1.0.0', manifest };
const inbound = {
  protocolVersion: '0.4',
  trust: 'untrusted_content',
  adapter,
  sourceAccountRef: 'external_account',
  conversationRef: 'conversation',
  messageRef: 'message',
  dedupeKey: 'dedupe',
  content: 'Please capture this.',
  contentDigest: digest,
  receivedAt: '2026-08-13T12:00:00.000Z',
};

describe('responsibility presence/channel v0.4', () => {
  it('round-trips distinct fake consumer wire shapes through one contract', () => {
    const fakeConsumers = [
      () => ({ ...inbound, messageRef: 'desktop_message' }),
      () => JSON.parse(JSON.stringify({ ...inbound, messageRef: 'mobile_message' })),
      () => ({
        ...inbound,
        adapter: { ...adapter, id: 'telegram' },
        sourceAccountRef: 'telegram_user',
        messageRef: 'telegram_update',
      }),
      () => ({
        ...inbound,
        adapter: { ...adapter, id: 'discord' },
        conversationRef: 'discord_channel',
        messageRef: 'discord_event',
      }),
    ];
    for (const consume of fakeConsumers) {
      const parsed = normalizedInboundEnvelopeV04Schema.parse(consume());
      expect(normalizedInboundEnvelopeV04Schema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(
        parsed,
      );
      expect(parsed.trust).toBe('untrusted_content');
    }
    const ajv = new Ajv2020({ strict: false });
    expect(
      ajv.compile(surfaceCapabilityManifestV04Schema.toJSONSchema())({
        protocolVersion: '0.4',
        id: 'surface',
        version: '1.0.0',
        commands: ['conversation.send'],
        projections: ['conversation'],
        offlineCommands: 'none',
      }),
    ).toBe(true);
  });

  it('publishes conversation and capture command artifacts for fake consumers', () => {
    const bundle = buildResponsibilityPresenceChannelV04Bundle(() => 'a'.repeat(64));
    const pairs = [
      ['conversation-command-request', conversationCommandRequestV04Schema],
      ['responsibility-capture-command-request', responsibilityCaptureCommandRequestV04Schema],
    ] as const;
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    for (const [name, zodSchema] of pairs) {
      const value = JSON.parse(bundle[`${name}.valid.json`]!);
      expect(zodSchema.parse(value), name).toEqual(value);
      expect(ajv.compile(JSON.parse(bundle[`${name}.schema.json`]!))(value), name).toBe(true);
    }
  });

  it('keeps adapter categories pairwise distinct', () => {
    expect(presenceRefV04Schema.safeParse(adapter).success).toBe(false);
    expect(
      channelAdapterRefV04Schema.safeParse({
        category: 'presence',
        id: 'p',
        registrationRevision: 1,
      }).success,
    ).toBe(false);
  });

  it.each([
    'ownerId',
    'authorityGrant',
    'credential',
    'acceptance',
    'closure',
    'rawHealth',
    'fullTranscript',
    'composedPrompt',
  ])('rejects forbidden untrusted field %s', (field) => {
    expect(
      normalizedInboundEnvelopeV04Schema.safeParse({ ...inbound, [field]: 'attacker' }).success,
    ).toBe(false);
  });

  it('keeps transport settlement observation-only', () => {
    const base = {
      protocolVersion: '0.4',
      id: 'settlement',
      ownerId: 'owner',
      deliveryIntentId: 'intent',
      deliveryIntentRevision: 1,
      adapter,
      state: 'delivered',
      transportMessageRef: 'remote_message',
      observationDigest: digest,
      observedAt: '2026-08-13T12:01:00.000Z',
    };
    expect(deliverySettlementV04Schema.parse(base).state).toBe('delivered');
    expect(
      deliverySettlementV04Schema.safeParse({ ...base, outcomeState: 'completed' }).success,
    ).toBe(false);
  });

  it('keeps conversation and capture commands strict and non-authoritative', () => {
    const base = {
      protocolVersion: '0.4',
      requestId: 'request',
      presenceRegistrationId: 'presence',
      clientIssuedAt: '2026-08-13T12:00:00.000Z',
    };
    expect(
      conversationCommandRequestV04Schema.safeParse({
        ...base,
        commandType: 'conversation.send',
        payload: { content: 'hello', contentDigest: digest },
        ownerId: 'owner',
      }).success,
    ).toBe(false);
    expect(
      responsibilityCaptureCommandRequestV04Schema.parse({
        ...base,
        commandType: 'responsibility.capture',
        payload: { userStatement: 'Handle this', statementDigest: digest },
      }).commandType,
    ).toBe('responsibility.capture');
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
      'conversation-client-owned-owner',
      'capture-client-owned-authority',
    ]);
    const validators = [
      normalizedInboundEnvelopeV04Schema,
      deliverySettlementV04Schema,
      presenceRefV04Schema,
      conversationCommandRequestV04Schema,
      responsibilityCaptureCommandRequestV04Schema,
    ];
    catalogue.cases.forEach(({ name, value }, index) => {
      expect(validators[index]!.safeParse(value).success, name).toBe(false);
    });
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    expect(
      ajv.compile(JSON.parse(bundle['conversation-command-request.schema.json']!))(
        catalogue.cases[3]!.value,
      ),
    ).toBe(false);
    expect(
      ajv.compile(JSON.parse(bundle['responsibility-capture-command-request.schema.json']!))(
        catalogue.cases[4]!.value,
      ),
    ).toBe(false);
  });
});
