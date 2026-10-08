import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { createScopedCuratedSkillCapability } from '../src/skills/curated-host';
import { CURATED_PREPARATION_SKILL } from '../src/skills/curated-owner';

it('owner identity is checked once per effect dispatch; other calls only check the run scope', async () => {
  const stub = env.RUNTIME_DO.get(env.RUNTIME_DO.idFromName('owner-identity-dispatch'));
  await runInDurableObject(stub, async (_, state) => {
    const owner = 'prn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const scope = { runId: 'run', attempt: 'attempt', deadline: Date.now() + 60000, signal: new AbortController().signal, admit() {}, commit<T>(work: () => T) { return work(); } };
    const calls = { current: 0, dispatch: 0 };
    const capability = createScopedCuratedSkillCapability(state.storage.sql, {
      owner, turnId: 'turn-1', trigger: 'user_message', ownerText: 'load',
      assertCurrent: async () => { calls.current += 1; }, assertDispatch: async () => { calls.dispatch += 1; },
    }, scope);
    const load = capability.handlers.find(handler => handler.name === 'skills_load')!;
    const ctx = { authenticatedUserId: owner, turnId: 'turn-1', trigger: 'user_message', runScope: scope, toolArgSourceTaint: null } as never;
    await load.handle({ name: CURATED_PREPARATION_SKILL.name, version: 1 }, ctx);
    expect(calls.dispatch).toBe(1);
    expect(calls.current).toBe(2);
  });
});
