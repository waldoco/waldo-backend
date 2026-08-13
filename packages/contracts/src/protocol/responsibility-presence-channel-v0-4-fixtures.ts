import { z } from 'zod';
import {
  channelPresenceV04Schema,
  conversationCommandRequestV04Schema,
  deliveryIntentV04Schema,
  deliverySettlementV04Schema,
  normalizedInboundEnvelopeV04Schema,
  responsibilityCaptureCommandRequestV04Schema,
  surfaceCapabilityManifestV04Schema,
} from './responsibility-presence-channel-v0-4';

const file = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const schema = (value: z.ZodType, name: string) => ({
  ...(z.toJSONSchema(value, { target: 'draft-2020-12', io: 'input', reused: 'ref' }) as object),
  $id: `urn:waldo:protocol:responsibility-presence-channel:0.4:${name}`,
  'x-waldo-validation-level': 'structural-plus-runtime-invariants',
});

export function buildResponsibilityPresenceChannelV04Bundle(
  hashHex: (value: string) => string,
): Record<string, string> {
  const digest = `sha256:${hashHex('fixture')}`;
  const manifestRef = { id: 'channel_manifest_fixture', version: '1.0.0', digest };
  const adapter = {
    category: 'channel_adapter',
    id: 'fake_channel_fixture',
    version: '1.0.0',
    manifest: manifestRef,
  };
  const presence = { category: 'presence', id: 'presence_fixture', registrationRevision: 1 };
  const valid = {
    'surface-capability.valid.json': surfaceCapabilityManifestV04Schema.parse({
      protocolVersion: '0.4',
      id: 'surface_fixture',
      version: '1.0.0',
      commands: ['conversation.send', 'responsibility.capture'],
      projections: ['conversation', 'responsibility_status'],
      offlineCommands: 'none',
    }),
    'channel-presence.valid.json': channelPresenceV04Schema.parse({
      protocolVersion: '0.4',
      presence,
      adapter,
      externalAccountRef: 'external_account_fixture',
      state: 'linked',
      capabilityManifest: manifestRef,
    }),
    'normalized-inbound.valid.json': normalizedInboundEnvelopeV04Schema.parse({
      protocolVersion: '0.4',
      trust: 'untrusted_content',
      adapter,
      sourceAccountRef: 'external_account_fixture',
      conversationRef: 'conversation_fixture',
      messageRef: 'message_fixture',
      dedupeKey: 'dedupe_fixture',
      content: 'Handle this fixture.',
      contentDigest: digest,
      receivedAt: '2026-08-13T12:00:00.000Z',
    }),
    'conversation-command-request.valid.json': conversationCommandRequestV04Schema.parse({
      protocolVersion: '0.4',
      requestId: 'conversation_request_fixture',
      presenceRegistrationId: presence.id,
      clientIssuedAt: '2026-08-13T12:00:00.000Z',
      commandType: 'conversation.send',
      payload: { content: 'Continue this work.', contentDigest: digest },
    }),
    'responsibility-capture-command-request.valid.json':
      responsibilityCaptureCommandRequestV04Schema.parse({
        protocolVersion: '0.4',
        requestId: 'capture_request_fixture',
        presenceRegistrationId: presence.id,
        clientIssuedAt: '2026-08-13T12:00:00.000Z',
        commandType: 'responsibility.capture',
        payload: { userStatement: 'Handle this fixture.', statementDigest: digest },
      }),
    'delivery-intent.valid.json': deliveryIntentV04Schema.parse({
      protocolVersion: '0.4',
      id: 'delivery_fixture',
      ownerId: 'owner_fixture',
      revision: 1,
      presence,
      adapter,
      projectionRef: 'projection_fixture',
      projectionDigest: digest,
      contentRef: 'content_fixture',
      contentDigest: digest,
      dedupeKey: 'delivery_dedupe_fixture',
      state: 'pending_delivery',
      createdAt: '2026-08-13T12:01:00.000Z',
    }),
    'delivery-settlement.valid.json': deliverySettlementV04Schema.parse({
      protocolVersion: '0.4',
      id: 'settlement_fixture',
      ownerId: 'owner_fixture',
      deliveryIntentId: 'delivery_fixture',
      deliveryIntentRevision: 1,
      adapter,
      state: 'delivered',
      transportMessageRef: 'transport_message_fixture',
      observationDigest: digest,
      observedAt: '2026-08-13T12:02:00.000Z',
    }),
  };
  const rejected = [
    {
      name: 'client-owned-authority',
      value: { ...valid['normalized-inbound.valid.json'], authorityGrant: 'attacker' },
    },
    {
      name: 'transport-done-closes-outcome',
      value: { ...valid['delivery-settlement.valid.json'], outcomeState: 'completed' },
    },
    { name: 'channel-as-presence', value: adapter },
    {
      name: 'conversation-client-owned-owner',
      value: { ...valid['conversation-command-request.valid.json'], ownerId: 'owner_attacker' },
    },
    {
      name: 'capture-client-owned-authority',
      value: {
        ...valid['responsibility-capture-command-request.valid.json'],
        authorityGrant: 'grant_attacker',
      },
    },
  ];
  const bundle: Record<string, string> = {
    'surface-capability.schema.json': file(
      schema(surfaceCapabilityManifestV04Schema, 'surface-capability'),
    ),
    'channel-presence.schema.json': file(schema(channelPresenceV04Schema, 'channel-presence')),
    'normalized-inbound.schema.json': file(
      schema(normalizedInboundEnvelopeV04Schema, 'normalized-inbound'),
    ),
    'conversation-command-request.schema.json': file(
      schema(conversationCommandRequestV04Schema, 'conversation-command-request'),
    ),
    'responsibility-capture-command-request.schema.json': file(
      schema(
        responsibilityCaptureCommandRequestV04Schema,
        'responsibility-capture-command-request',
      ),
    ),
    'delivery-intent.schema.json': file(schema(deliveryIntentV04Schema, 'delivery-intent')),
    'delivery-settlement.schema.json': file(
      schema(deliverySettlementV04Schema, 'delivery-settlement'),
    ),
    'presence-channel.rejections.json': file({ protocolVersion: '0.4', cases: rejected }),
  };
  for (const [path, value] of Object.entries(valid)) bundle[path] = file(value);
  const hashes = Object.fromEntries(
    Object.entries(bundle).map(([path, value]) => [path, `sha256:${hashHex(value)}`]),
  );
  bundle['manifest.json'] = file({
    protocolVersion: '0.4',
    family: 'responsibility-presence-channel',
    files: hashes,
  });
  return bundle;
}
