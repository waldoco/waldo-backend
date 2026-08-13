import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';
import { channelAdapterRefV04Schema, presenceRefV04Schema } from './responsibility-presence-channel-v0-4';
import { buildResponsibilityExecutionV04Bundle } from './responsibility-execution-v0-4-fixtures';
import { executionAttemptV04Schema, executionEnvironmentRefV04Schema, executionRequestV04Schema,
  executorObservationV04Schema, observationMatchesExecutionAttemptV04, providerRefV04Schema } from './responsibility-execution-v0-4';

const digest = `sha256:${'b'.repeat(64)}`;
const manifest = { id: 'manifest', version: '1.0.0', digest };
const provider = { category: 'provider', id: 'provider', version: '1.0.0', modelRef: 'model', manifest };
const environment = { category: 'execution_environment', id: 'environment', version: '1.0.0', environmentKind: 'local', manifest };
const ref = { id: 'aggregate', revision: 1, digest };
const attempt = { protocolVersion: '0.4', id: 'attempt', ownerId: 'owner', executionRequestId: 'request', workUnit: ref,
  attemptNumber: 1, provider, environment, leaseId: 'lease', fencingGeneration: 2, cancellationGeneration: 3,
  state: 'running', createdAt: '2026-08-13T12:00:00.000Z', updatedAt: '2026-08-13T12:00:01.000Z' };
const observation = { protocolVersion: '0.4', id: 'observation', ownerId: 'owner', attemptId: 'attempt', environment,
  leaseId: 'lease', fencingGeneration: 2, cancellationGeneration: 3, sequence: 1, kind: 'ended', payloadRef: null,
  payloadDigest: null, observedAt: '2026-08-13T12:00:02.000Z' };

describe('responsibility execution v0.4', () => {
  it('keeps all four adapter categories pairwise disjoint', () => {
    const values = [provider, environment, { category: 'presence', id: 'presence', registrationRevision: 1 },
      { category: 'channel_adapter', id: 'channel', version: '1.0.0', manifest }];
    const schemas = [providerRefV04Schema, executionEnvironmentRefV04Schema, presenceRefV04Schema, channelAdapterRefV04Schema];
    schemas.forEach((schema, expected) => values.forEach((value, actual) => expect(schema.safeParse(value).success).toBe(expected === actual)));
  });

  it('binds observations to the exact lease, fence, cancellation and environment', () => {
    expect(observationMatchesExecutionAttemptV04(attempt, observation)).toBe(true);
    for (const patch of [{ fencingGeneration: 3 }, { cancellationGeneration: 4 }, { leaseId: 'other' }]) {
      expect(observationMatchesExecutionAttemptV04(attempt, { ...observation, ...patch })).toBe(false);
    }
  });

  it.each(['acceptance', 'verification', 'outcomeState', 'openLoopState', 'credential', 'composedPrompt', 'fullTranscript', 'rawHealth'])
  ('rejects observation truth/sensitive field %s', (field) => {
    expect(executorObservationV04Schema.safeParse({ ...observation, [field]: 'forbidden' }).success).toBe(false);
  });

  it('compiles execution JSON Schema and rejects category substitution', () => {
    const value = { protocolVersion: '0.4', id: 'request', ownerId: 'owner', outcome: ref, workUnit: ref, provider,
      environment, authorityCeiling: { tools: [], connectors: [], externalEffects: 'none', outcomeMutation: 'none', evidenceAdmission: 'none', verification: 'none', acceptance: 'none', closure: 'none' },
      contextProjectionRef: 'context', contextProjectionDigest: digest, cancellationGeneration: 1, requestedAt: '2026-08-13T12:00:00.000Z' };
    expect(executionRequestV04Schema.parse(value).provider.category).toBe('provider');
    expect(executionRequestV04Schema.safeParse({ ...value, provider: environment }).success).toBe(false);
    expect(new Ajv2020({ strict: false }).compile(executionRequestV04Schema.toJSONSchema())(value)).toBe(true);
  });

  it('treats executor ended as activity only', () => {
    expect(executorObservationV04Schema.parse(observation).kind).toBe('ended');
    expect(executionAttemptV04Schema.safeParse({ ...attempt, state: 'completed' }).success).toBe(false);
  });

  it('rejects every catalogued execution attack at its structural or freshness boundary', () => {
    const bundle = buildResponsibilityExecutionV04Bundle(() => 'b'.repeat(64));
    const catalogue = JSON.parse(bundle['execution.rejections.json']!) as {
      cases: Array<{ name: string; value: unknown }>;
    };
    expect(catalogue.cases.map(({ name }) => name)).toEqual([
      'provider-environment-confusion',
      'stale-fence-observation',
      'executor-done-closes-outcome',
    ]);
    expect(executionRequestV04Schema.safeParse(catalogue.cases[0]!.value).success).toBe(false);
    const stale = executorObservationV04Schema.parse(catalogue.cases[1]!.value);
    expect(observationMatchesExecutionAttemptV04(attempt, stale)).toBe(false);
    expect(executorObservationV04Schema.safeParse(catalogue.cases[2]!.value).success).toBe(false);
  });
});
