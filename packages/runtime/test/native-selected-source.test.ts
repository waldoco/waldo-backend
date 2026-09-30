import { expect,it } from 'vitest';
import { IsolatedSourceWorld } from '../scenarios/isolated-source-world';
import { nativeSelectedSource } from '../scenarios/native-selected-source';
it('checks scope before collecting, list reads only selected IDs and denied attempts remain inspectable',()=>{
 const world=new IsolatedSourceWorld({clock:'2026-10-01T09:00:00Z',owners:[{id:'a'},{id:'b'}],sources:{files:[{owner_id:'a',id:'selected',content:'ProjectA'},{owner_id:'a',id:'private',content:'DENIED_CANARY'},{owner_id:'b',id:'selected',content:'CONTROL_CANARY'}],messages:[{owner_id:'a',id:'m',content:'NO_CONSENT'}]}});
 const scope={files:['selected']};const selected=nativeSelectedSource(world,'a',scope);scope.files.push('private');
 expect(selected.list('a','files')).toEqual([{owner_id:'a',id:'selected',content:'ProjectA'}]);
 expect(()=>selected.read('a','files','private')).toThrow('selection');
 expect(()=>selected.list('a','messages')).toThrow('family');
 expect(()=>selected.read('b','files','selected')).toThrow('selection');
 expect(world.accessLog('a').map(r=>r.kind)).toEqual(['read','denied_read','denied_list','denied_read']);
 expect(world.accessLog('b')).toEqual([]);expect(JSON.stringify(selected.list('a','files'))).not.toContain('CANARY');
});
