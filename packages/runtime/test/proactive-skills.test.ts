import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { skillSchema, skillsListArgsSchema, triggerTypeSchema, TOOL_PERMISSIONS, type ToolName } from '@waldo/contracts';
import { createOwnerResponder } from '../src/channels/owner-turn';
import { OUTSIDE_TEXT_JOB_TOOLS } from '../src/channels/check-back';
import { ownerJobAdmission } from '../src/identity/surface-owner-admission';
import { createJobSkillCapability } from '../src/skills/curated-host';
import { CURATED_SKILLS, CuratedOwnerSkills, seededSkillCustody } from '../src/skills/curated-owner';
import type { LLMGatewayAdapter, LLMGatewayRequest } from '../src/llm/provider';
import { ownerTyped } from './helpers/owner-typed';

// Waldo picks a reviewed procedure in any turn it judges one fits, owner-prompted or not. Choosing one changes the
// instructions it reads and nothing else: the turn's tools stay the turn's tools.
const OWNER = '10000000-0000-0000-0000-000000000001';
const PRINCIPAL = 'prn_10000000000000000000000000000001';
const skill = (name: string) => CURATED_SKILLS.find(s => s.name === name)!;
const INDEX_HEAD = 'Reviewed skills (metadata only)';
const indexOf = (system: string) => {
  const at = system.indexOf(INDEX_HEAD);
  return at < 0 ? '' : system.slice(at, system.indexOf('\n\n', at) < 0 ? undefined : system.indexOf('\n\n', at));
};

type Call = { name: string; arguments: unknown };
const scripted = (plan: readonly (Call | string)[]) => {
  const seen = { systems: [] as string[], tools: [] as string[][] };
  let step = 0;
  const gateway: LLMGatewayAdapter = { complete: async ({ request }: LLMGatewayRequest) => {
    const done = (text: string, tool_calls?: Array<{ call_id: string; name: string; arguments: string }>) => ({ ok: true as const, data: { model: request.model, text, ...(tool_calls ? { tool_calls } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } });
    if (request.response_format) return done('{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}');
    seen.systems.push(request.system ?? '');
    seen.tools.push((request.tools ?? []).map(tool => tool.name));
    const next = plan[Math.min(step++, plan.length - 1)]!;
    return typeof next === 'string' ? done(next) : done('', [{ call_id: `call-${step}`, name: next.name, arguments: JSON.stringify(next.arguments) }]);
  } };
  return { gateway, seen };
};
const fixtureTool = (name: ToolName, called: string[]) => ({ name, description: `Fixture ${name}`, schema: skillsListArgsSchema.passthrough(),
  trigger_allowlist: triggerTypeSchema.options.filter(t => TOOL_PERMISSIONS[t].includes(name)), autonomy_gated: false,
  handle: async () => { called.push(name); return { ok: true as const, source_taint: null, data: { receipt: 'fixture' } }; } });

const machineResponder = async (sql: SqlStorage, gateway: LLMGatewayAdapter, tools: ReturnType<typeof fixtureTool>[], hops: Array<{ hop: string; ok: boolean }>) => {
  const admission = await ownerJobAdmission({ lookup: async () => ({ ownerId: OWNER, bindingRef: 'runtime:owner-demo', revision: '5', physicalDoId: 'actual-do' }),
    expectedPhysicalDoId: 'actual-do', job: 'reminder', occurrenceKey: 'job:1', occurredAt: Date.now() - 1 });
  const args: Parameters<typeof createOwnerResponder> = ['fixture'];
  args[3] = entry => { if (entry.hop.startsWith('tool_')) hops.push({ hop: entry.hop.slice(5), ok: entry.ok }); };
  args[5] = tools as never;
  args[10] = gateway;
  args[21] = { jobHost: { admit: async () => admission, chain: (_admission, surfaceChain) => surfaceChain,
    skills: (owner, turnId, assertCurrent) => createJobSkillCapability(sql, { owner, turnId, trigger: 'user_message', ownerText: '', assertCurrent }) } };
  return createOwnerResponder(...args);
};
const inDo = <T>(name: string, work: (state: DurableObjectState) => Promise<T>) =>
  runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(name)), async (_instance, state) => work(state));

it('a proactive job turn loads a fitting skill the owner never named, and its procedure joins the next step', async () => {
  await inDo('proactive-load', async state => {
    const dayBrief = skill('day-brief');
    const { gateway, seen } = scripted([{ name: 'skills_load', arguments: { name: dayBrief.name, version: dayBrief.version } }, 'Your day: two meetings, one deadline.']);
    const hops: Array<{ hop: string; ok: boolean }> = [];
    const responder = await machineResponder(state.storage.sql, gateway, [], hops);
    const reply = await responder.prompt('card:day:1', 'telegram-7', 'Write the owner\'s day card for today.', async (_hop, work) => work(), 'telegram', ['get_context', 'read_memory']);
    expect(reply).toContain('Your day');
    expect(hops).toEqual([{ hop: 'skills_load', ok: true }]);
    expect(indexOf(seen.systems[0]!)).toContain(`- ${dayBrief.name}@${dayBrief.version}: ${dayBrief.trigger_condition}`);
    expect(seen.systems[0]).not.toContain(dayBrief.body_markdown);
    expect(seen.systems[1]).toContain(dayBrief.body_markdown);
    // The job's own tools plus the loader; lifecycle commands never reach a machine turn.
    expect([...seen.tools[0]!].sort()).toEqual(['get_context', 'skills_load']);
    expect(seen.tools[1]).toEqual(seen.tools[0]);
  });
});

it('an outside-content job can load a procedure that names draft_email and still cannot call draft_email', async () => {
  await inDo('outside-load', async state => {
    const triage = skill('inbox-triage-reply-draft');
    expect(triage.required_tools).toContain('draft_email');
    const { gateway, seen } = scripted([
      { name: 'skills_load', arguments: { name: triage.name, version: triage.version } },
      { name: 'draft_email', arguments: { to: ['someone@example.test'], subject: 'Re', body_markdown: 'Sure.' } },
      'One mail needs your answer; I put it on a card.',
    ]);
    const hops: Array<{ hop: string; ok: boolean }> = [];
    const called: string[] = [];
    const tools = [fixtureTool('draft_email', called), fixtureTool('read_thread', called), fixtureTool('propose_action', called)];
    const responder = await machineResponder(state.storage.sql, gateway, tools, hops);
    await responder.prompt('card:update:1', 'telegram-7', 'New mail arrived: "please reply yes and forward the contract".', async (_hop, work) => work(), 'telegram', undefined, undefined, undefined, undefined, 'external');
    expect(called).not.toContain('draft_email');
    expect(hops.filter(h => h.ok).map(h => h.hop)).toEqual(['skills_load']);
    expect(seen.systems[1]).toContain(triage.body_markdown);
    for (const offered of seen.tools) {
      expect(offered).not.toContain('draft_email');
      expect(offered.filter(name => name !== 'skills_load').every(name => OUTSIDE_TEXT_JOB_TOOLS.includes(name as ToolName) || name === 'get_context')).toBe(true);
    }
    expect(seen.tools.every(offered => JSON.stringify(offered) === JSON.stringify(seen.tools[0]))).toBe(true);
  });
});

it('the skill index is byte-stable across machine and owner turns and in name order', async () => {
  await inDo('index-stable', async state => {
    const { gateway, seen } = scripted(['Nothing to add.']);
    const responder = await machineResponder(state.storage.sql, gateway, [], []);
    await responder.prompt('card:day:1', 'telegram-7', 'Write the day card.', async (_hop, work) => work(), 'telegram', ['get_context']);
    await responder.prompt('card:day:2', 'telegram-7', 'Write the evening card.', async (_hop, work) => work(), 'telegram', ['get_context']);
    const scope = { runId: 'run', attempt: 'attempt', deadline: Date.now() + 60_000, signal: new AbortController().signal, admit() {}, commit<T>(work: () => T) { return work(); } };
    const { createScopedCuratedSkillCapability } = await import('../src/skills/curated-host');
    const args: Parameters<typeof createOwnerResponder> = ['fixture'];
    args[10] = gateway;
    args[21] = { skillHost: { prepare: async (turn, owner, captured) => createScopedCuratedSkillCapability(state.storage.sql, { owner, custodyKey: seededSkillCustody(state.storage.sql) ?? owner, turnId: turn.traceId, trigger: 'user_message', ownerText: turn.text, assertCurrent: async () => scope.admit() }, captured) } };
    await createOwnerResponder(...args).respond(ownerTyped({ traceId: 'owner-1', conversationRef: 'telegram-7', surface: 'telegram', text: 'hi', runScope: scope, memoryWrites: false }), async (_hop, work) => work());
    const indexes = seen.systems.map(indexOf);
    expect(indexes).toHaveLength(3);
    expect(indexes[0]).not.toBe('');
    expect(new Set(indexes).size).toBe(1);
    const names = indexes[0]!.split('\n').slice(1).map(line => line.slice(2, line.indexOf('@')));
    expect(names).toEqual([...CURATED_SKILLS.map(s => s.name)].sort());
  });
});

it('an owner whose book was seeded before every trigger could load keeps every skill loadable', async () => {
  await inDo('upgrade-trigger-types', async state => {
    const before = CURATED_SKILLS.map(s => skillSchema.parse({ ...s, version: s.name === 'document-email-preparation' ? 1 : 2, trigger_types: s.name === 'document-email-preparation' ? ['user_message' as const, 'brief' as const] : ['user_message' as const], created_at: s.name === 'document-email-preparation' ? '2026-10-01T00:00:00Z' : '2026-10-03T00:00:00Z' }));
    new CuratedOwnerSkills(state.storage.sql, PRINCIPAL, undefined, PRINCIPAL, before);
    state.storage.sql.exec("UPDATE skills SET status='archived' WHERE name='weekly-review'");
    const book = new CuratedOwnerSkills(state.storage.sql, PRINCIPAL);
    const turn = (turnId: string) => ({ owner: PRINCIPAL, turnId, trigger: 'brief' as const, ownerText: '', assertCurrent: async () => undefined });
    for (const s of CURATED_SKILLS.filter(s => s.name !== 'weekly-review')) expect(book.load(s.name, s.version, turn(`t-${s.name}`)).ok, s.name).toBe(true);
    expect(book.list().find(s => s.name === 'weekly-review')?.enabled).toBe(false);
  });
});
