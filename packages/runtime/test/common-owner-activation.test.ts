import {expect,it} from 'vitest';
import {commonOwnerActivation} from '../src/channels/common-owner-activation';
it('staging flag remains off without explicit opt-in and never enables production',()=>{expect(commonOwnerActivation({WALDO_ENVIRONMENT:'staging'},'a')).toBe(false);expect(commonOwnerActivation({WALDO_ENVIRONMENT:'production',COMMON_OWNER_TASKS:'1'},'a')).toBe(false);});
it('exact per-owner selector does not change others and has no substring or empty-owner match',()=>{const env={WALDO_ENVIRONMENT:'staging',COMMON_OWNER_TASKS:'1',COMMON_OWNER_DO_NAME:'owner-a'};expect(commonOwnerActivation(env,'owner-a')).toBe(true);for(const name of [undefined,'','owner-a-extra','owner-b'])expect(commonOwnerActivation(env,name)).toBe(false);});

const sources: Record<string, string> = import.meta.glob('../src/channels/telegram-owner-do.ts', { query: '?raw', import: 'default', eager: true });
it('an unselected owner is inactive for host, source and execution paths: the DO has one decision, not the global flag', () => {
  const env = { WALDO_ENVIRONMENT: 'staging', COMMON_OWNER_TASKS: '1', COMMON_OWNER_DO_NAME: 'owner-a' };
  expect(commonOwnerActivation(env, 'owner-a')).toBe(true);
  expect(commonOwnerActivation(env, 'owner-b')).toBe(false);
  expect(commonOwnerActivation({ ...env, WALDO_ENVIRONMENT: 'production' }, 'owner-a')).toBe(false);
  const source = Object.values(sources)[0]!;
  expect(source.match(/COMMON_OWNER_TASKS/g)).toBeNull();
  expect(source.match(/this\.commonActive\(\)/g)!.length).toBeGreaterThanOrEqual(5);
});
