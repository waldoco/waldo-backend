// Provider events carry source revisions, never owner authority or tool commands.
import type {IsolatedSourceWorld,WorldFixture} from './isolated-source-world';
import type {NativeCaseBundleV1} from '../evals/native-case-bundle';
type Turn=NativeCaseBundleV1['turns'][number];
export const validateNativeSourceEvent=(fixture:WorldFixture,owner:string,turn:Turn):void=>{
 const payload=turn.payload as Record<string,unknown>|null;
 if(turn.kind!=='provider_event'||!payload||Object.keys(payload).sort().join(',')!=='id,owner_id,patch,source'||payload.owner_id!==owner||typeof payload.source!=='string'||typeof payload.id!=='string')throw new Error('unbound native source event');
 const matches=(fixture.revisions??[]).filter(r=>r.at===turn.at&&r.owner_id===owner&&r.source===payload.source&&r.id===payload.id&&JSON.stringify(r.patch)===JSON.stringify(payload.patch));
 if(matches.length!==1)throw new Error('native event requires one exact declared revision');
};
export const advanceNativeSourceEvent=(world:IsolatedSourceWorld,fixture:WorldFixture,owner:string,turn:Turn):void=>{
 validateNativeSourceEvent(fixture,owner,turn);
 const upcoming=(fixture.revisions??[]).filter(r=>Date.parse(r.at)>Date.parse(world.now())&&Date.parse(r.at)<=Date.parse(turn.at));
 if(upcoming.length!==1||upcoming[0]!.at!==turn.at||upcoming[0]!.owner_id!==owner)throw new Error('native event would advance undeclared revisions');
 world.advance(turn.at);
};
