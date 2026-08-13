import { z } from 'zod';
import { channelPresenceV04Schema, deliveryIntentV04Schema, deliverySettlementV04Schema,
  normalizedInboundEnvelopeV04Schema, surfaceCapabilityManifestV04Schema } from './responsibility-presence-channel-v0-4';

const file = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const schema = (value: z.ZodType, name: string) => ({ ...z.toJSONSchema(value, { target: 'draft-2020-12', io: 'input', reused: 'ref' }) as object,
  $id: `urn:waldo:protocol:responsibility-presence-channel:0.4:${name}` });

export function buildResponsibilityPresenceChannelV04Bundle(hashHex: (value: string) => string): Record<string, string> {
  const digest = `sha256:${hashHex('fixture')}`;
  const manifestRef = { id: 'channel_manifest_fixture', version: '1.0.0', digest };
  const adapter = { category: 'channel_adapter', id: 'fake_channel_fixture', version: '1.0.0', manifest: manifestRef };
  const presence = { category: 'presence', id: 'presence_fixture', registrationRevision: 1 };
  const valid = {
    'surface-capability.valid.json': surfaceCapabilityManifestV04Schema.parse({ protocolVersion: '0.4', id: 'surface_fixture', version: '1.0.0', commands: ['conversation.send', 'responsibility.capture'], projections: ['conversation', 'responsibility_status'], offlineCommands: 'none' }),
    'channel-presence.valid.json': channelPresenceV04Schema.parse({ protocolVersion: '0.4', presence, adapter, externalAccountRef: 'external_account_fixture', state: 'linked', capabilityManifest: manifestRef }),
    'normalized-inbound.valid.json': normalizedInboundEnvelopeV04Schema.parse({ protocolVersion: '0.4', trust: 'untrusted_content', adapter, sourceAccountRef: 'external_account_fixture', conversationRef: 'conversation_fixture', messageRef: 'message_fixture', dedupeKey: 'dedupe_fixture', content: 'Handle this fixture.', contentDigest: digest, receivedAt: '2026-08-13T12:00:00.000Z' }),
    'delivery-intent.valid.json': deliveryIntentV04Schema.parse({ protocolVersion: '0.4', id: 'delivery_fixture', ownerId: 'owner_fixture', revision: 1, presence, adapter, projectionRef: 'projection_fixture', projectionDigest: digest, contentRef: 'content_fixture', contentDigest: digest, dedupeKey: 'delivery_dedupe_fixture', state: 'pending_delivery', createdAt: '2026-08-13T12:01:00.000Z' }),
    'delivery-settlement.valid.json': deliverySettlementV04Schema.parse({ protocolVersion: '0.4', id: 'settlement_fixture', ownerId: 'owner_fixture', deliveryIntentId: 'delivery_fixture', deliveryIntentRevision: 1, adapter, state: 'delivered', transportMessageRef: 'transport_message_fixture', observationDigest: digest, observedAt: '2026-08-13T12:02:00.000Z' }),
  };
  const rejected = [{ name: 'client-owned-authority', value: { ...valid['normalized-inbound.valid.json'], authorityGrant: 'attacker' } },
    { name: 'transport-done-closes-outcome', value: { ...valid['delivery-settlement.valid.json'], outcomeState: 'completed' } },
    { name: 'channel-as-presence', value: adapter }];
  const bundle: Record<string, string> = {
    'surface-capability.schema.json': file(schema(surfaceCapabilityManifestV04Schema, 'surface-capability')),
    'channel-presence.schema.json': file(schema(channelPresenceV04Schema, 'channel-presence')),
    'normalized-inbound.schema.json': file(schema(normalizedInboundEnvelopeV04Schema, 'normalized-inbound')),
    'delivery-intent.schema.json': file(schema(deliveryIntentV04Schema, 'delivery-intent')),
    'delivery-settlement.schema.json': file(schema(deliverySettlementV04Schema, 'delivery-settlement')),
    'presence-channel.rejections.json': file({ protocolVersion: '0.4', cases: rejected }),
  };
  for (const [path, value] of Object.entries(valid)) bundle[path] = file(value);
  const hashes = Object.fromEntries(Object.entries(bundle).map(([path, value]) => [path, `sha256:${hashHex(value)}`]));
  bundle['manifest.json'] = file({ protocolVersion: '0.4', family: 'responsibility-presence-channel', files: hashes });
  return bundle;
}
