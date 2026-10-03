import { recallResultSchema, type ToolName } from '@waldo/contracts';
import type { ContextComposerDependencies } from '../../src/context-composer';
import type { OwnerMessageAdmission } from '../../src/identity/owner-message-admission';
import type { TelegramOwnerPrivateHost } from '../../src/channels/telegram-owner-do';
import type { LLMGatewayAdapter } from '../../src/llm/provider';

function sources(admission: OwnerMessageAdmission): ContextComposerDependencies {
  const identity = { principal_ref: admission.invocation.verified_authority.principal_ref, tenant_ref: admission.invocation.verified_authority.tenant_ref };
  const snapshot = { ...admission.snapshot, revision_ref: 'rev_11111111111111111111111111111111' };
  const source = (key: string, scope: 'system' | 'principal' = 'system') => ({ source_key: key.toLowerCase().replaceAll(' ', '-'), source_kind: 'runtime_metadata' as const, scope, source_taint: null, produced_at: snapshot.snapshot_at });
  const fragment = (key: string, scope: 'system' | 'principal' = 'system') => ({ text: key, source: source(key, scope) });
  return {
    staged_inputs: { resolve: async () => { throw new Error('admitted input adapter required'); } },
    materials: { load: async () => ({ ...identity, snapshot, identity: fragment('ADMITTED_MATERIAL_OWNER_BOUND_CANVAS', 'principal'), trigger_behaviour: fragment('Help the owner'), zone_modifier: fragment('Keep practical'), mode_template: fragment('Concise response'), soul_base: fragment('Be direct'), safety_rules: fragment('Respect permissions'), health: null, workspace: [], tool_outputs: [] }) },
    owner_binding: { bind: async () => ({ ...identity, snapshot, local_user_ref: 'private-owner', source: source('owner', 'principal') }) },
    system_skills: { list: async () => ({ rows: [], snapshot, source: source('skills') }) },
    system_skill_state: { load: async () => ({ ...identity, snapshot, source: source('skill-state', 'principal'), connected_connectors: [], dismissed_today: [], provisional_reverted: [], identity_drift: [], priority_pinned: [] }) },
    skill_budget: { countRenderedSkill: async () => ({ ok: false, code: 'unavailable' }), countRenderedBlock: async () => ({ ok: false, code: 'unavailable' }) },
    recall: { recall: async () => ({ ...identity, snapshot, status: 'failed', result: recallResultSchema.parse({ memory_hits: [], episode_hits: [], evolution_hits: [], query_used: 'No recall source', duration_ms: 0 }), source: null, capability: 'owner_bound_local_temporal_snapshot' }) },
  };
}

// Explicit synthetic authority for the existing hermetic ingress fixtures only.
export function admittedOwnerHost(doName: string, subject: string, gateway: LLMGatewayAdapter, tools: readonly ToolName[] = []): TelegramOwnerPrivateHost {
  const suffix = subject.padStart(12, '0');
  return {
    environment: 'staging', namespace: 'hermetic-owner-host', allowedDoNames: [doName],
    lookup: async (provider, suppliedSubject) => provider === 'telegram' && suppliedSubject === subject ? { owner_id: `10000000-0000-0000-0000-${suffix}`, presence_id: `20000000-0000-0000-0000-${suffix}`, state_version: 0, admission_revision: '9007199254740993', do_name: doName, provider, subject } : null,
    context: sources,
    access: async () => ({ grants: { status: 'available', tools }, connectors: { status: 'available', tools } }),
    connectorBacked: handler => tools.includes(handler.name as ToolName),
    gateway,
  };
}
