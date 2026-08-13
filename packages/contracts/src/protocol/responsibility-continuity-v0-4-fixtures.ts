import { z } from 'zod';
import {
  openLoopDispositionCommandV04Schema,
  openLoopV04Schema,
  reEntryPointV04Schema,
} from './responsibility-continuity-v0-4';
const file = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
const schema = (v: z.ZodType, n: string) => ({
  ...(z.toJSONSchema(v, { target: 'draft-2020-12', io: 'input', reused: 'ref' }) as object),
  $id: `urn:waldo:protocol:responsibility-continuity:0.4:${n}`,
  'x-waldo-validation-level': 'structural-plus-runtime-invariants',
});
export function buildResponsibilityContinuityV04Bundle(
  hashHex: (value: string) => string,
): Record<string, string> {
  const digest = `sha256:${hashHex('fixture')}`;
  const reentry = reEntryPointV04Schema.parse({
    protocolVersion: '0.4',
    id: 'reentry_fixture',
    ownerId: 'owner_fixture',
    revision: 1,
    subject: { kind: 'outcome', id: 'outcome_fixture', revision: 1 },
    mode: 'verification',
    summary: 'Verify the remaining consequence.',
    lastStableEventId: 'event_fixture',
    nextAction: { kind: 'verify', ref: 'check_fixture' },
    requiredContextRecipeRef: 'recipe_fixture',
    requiredContextRecipeDigest: digest,
    evidenceGapRefs: ['gap_fixture'],
    artifactRefs: [],
    eventCursor: 1,
    expiresAt: null,
  });
  const loop = openLoopV04Schema.parse({
    protocolVersion: '0.4',
    id: 'loop_fixture',
    ownerId: 'owner_fixture',
    revision: 1,
    outcome: { id: 'outcome_fixture', revision: 1 },
    workUnit: null,
    unresolvedConsequence: { kind: 'unverified', ref: 'consequence_fixture' },
    responsibleParty: { kind: 'waldo', ref: null },
    nextTrigger: { kind: 'manual', ref: 'trigger_fixture' },
    evidenceGapRefs: ['gap_fixture'],
    reEntryPointId: reentry.id,
    attentionClass: 'normal',
    state: 'open',
    updatedAt: '2026-08-13T12:00:00.000Z',
  });
  const disposition = openLoopDispositionCommandV04Schema.parse({
    protocolVersion: '0.4',
    requestId: 'disposition_fixture',
    commandType: 'open_loop.disposition',
    presenceRegistrationId: 'presence_fixture',
    aggregate: { kind: 'open_loop', id: loop.id, expectedRevision: 1 },
    disposition: 'resolve',
    acceptanceId: 'acceptance_fixture',
    reEntryPointId: null,
    clientIssuedAt: '2026-08-13T12:01:00.000Z',
  });
  const bundle: Record<string, string> = {
    'open-loop.schema.json': file(schema(openLoopV04Schema, 'open-loop')),
    're-entry-point.schema.json': file(schema(reEntryPointV04Schema, 're-entry-point')),
    'open-loop-disposition-command.schema.json': file(
      schema(openLoopDispositionCommandV04Schema, 'open-loop-disposition-command'),
    ),
    'open-loop.valid.json': file(loop),
    're-entry-point.valid.json': file(reentry),
    'open-loop-disposition-command.valid.json': file(disposition),
    'continuity.rejections.json': file({
      protocolVersion: '0.4',
      cases: [
        { name: 'provider-done-closes-loop', value: { ...loop, providerDone: true } },
        { name: 'inline-context', value: { ...reentry, context: 'full transcript' } },
        {
          name: 'resolve-without-acceptance',
          value: { ...disposition, acceptanceId: null },
        },
      ],
    }),
  };
  bundle['manifest.json'] = file({
    protocolVersion: '0.4',
    family: 'responsibility-continuity',
    files: Object.fromEntries(Object.entries(bundle).map(([p, v]) => [p, `sha256:${hashHex(v)}`])),
  });
  return bundle;
}
