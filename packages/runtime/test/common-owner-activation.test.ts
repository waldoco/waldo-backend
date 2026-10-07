import {expect,it} from 'vitest';
import {commonOwnerActivation} from '../src/channels/common-owner-activation';
it('staging flag remains off without explicit opt-in and never enables production',()=>{expect(commonOwnerActivation({WALDO_ENVIRONMENT:'staging'},'a')).toBe(false);expect(commonOwnerActivation({WALDO_ENVIRONMENT:'production',COMMON_OWNER_TASKS:'1'},'a')).toBe(false);});
it('exact per-owner selector does not change others and has no substring or empty-owner match',()=>{const env={WALDO_ENVIRONMENT:'staging',COMMON_OWNER_TASKS:'1',COMMON_OWNER_DO_NAME:'owner-a'};expect(commonOwnerActivation(env,'owner-a')).toBe(true);for(const name of [undefined,'','owner-a-extra','owner-b'])expect(commonOwnerActivation(env,name)).toBe(false);});
