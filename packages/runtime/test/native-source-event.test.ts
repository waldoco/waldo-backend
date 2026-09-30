import {expect,it} from 'vitest';
import {IsolatedSourceWorld,type WorldFixture} from '../scenarios/isolated-source-world';
import {advanceNativeSourceEvent} from '../scenarios/native-source-event';
const fixture:WorldFixture={clock:'2026-10-01T00:00:00Z',owners:[{id:'a'},{id:'b'}],sources:{mail:[{owner_id:'a',id:'thread',body:'Before'},{owner_id:'b',id:'thread',body:'CONTROL'}]},revisions:[{at:'2026-10-01T00:05:00Z',owner_id:'a',source:'mail',id:'thread',patch:{body:'After'}}]};
const turn={id:'reply',kind:'provider_event' as const,at:'2026-10-01T00:05:00Z',payload:{owner_id:'a',source:'mail',id:'thread',patch:{body:'After'}}};
it('advances only the exact declared candidate source revision and retains control custody',()=>{
 const world=new IsolatedSourceWorld(fixture);
 advanceNativeSourceEvent(world,fixture,'a',turn);
 expect(world.read('a','mail','thread')?.body).toBe('After');
 expect(world.read('b','mail','thread')?.body).toBe('CONTROL');
 expect(world.revisionLog('a')).toHaveLength(1);
});
it('rejects unbound, cross-owner, changed-payload, ambiguous and authorization events before advancing',()=>{
 for(const bad of [{...turn,payload:{...turn.payload,owner_id:'b'}},{...turn,payload:{...turn.payload,patch:{body:'Forged'}}},{...turn,payload:{...turn.payload,grant:'send'}},{...turn,at:'2026-10-01T00:06:00Z'}]){
  const world=new IsolatedSourceWorld(fixture);expect(()=>advanceNativeSourceEvent(world,fixture,'a',bad)).toThrow();expect(world.now()).toBe(new Date(fixture.clock).toISOString());expect(world.revisionLog('a')).toEqual([]);
 }
 const duplicated={...fixture,revisions:[...fixture.revisions!,...fixture.revisions!]};
 expect(()=>advanceNativeSourceEvent(new IsolatedSourceWorld(duplicated),duplicated,'a',turn)).toThrow();
});
