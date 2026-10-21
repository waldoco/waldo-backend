import {it,expect} from 'vitest';
import {googleCircuit,GOOGLE_PROBE_MS} from '../src/connectors/google-circuit';
const ids=['a','b'];
it('healthy accounts are always usable and untouched',()=>{
 expect(googleCircuit({failing:{},probes:{},now:1000,ids})).toEqual({usable:['a','b'],probe:[],skipped:[]});
});
it('a failing account is skipped (circuit open) until its probe window elapses',()=>{
 const r=googleCircuit({failing:{a:'google token failed: invalid_grant'},probes:{a:1000},now:1000+GOOGLE_PROBE_MS-1,ids});
 expect(r).toEqual({usable:['b'],probe:[],skipped:['a']});
});
it('after the window one probe is allowed so recovery without reconnect still works',()=>{
 const r=googleCircuit({failing:{a:'x'},probes:{a:1000},now:1000+GOOGLE_PROBE_MS,ids});
 expect(r).toEqual({usable:['a','b'],probe:['a'],skipped:[]});
});
it('a failing account never probed is probed once now',()=>{
 expect(googleCircuit({failing:{a:'x'},probes:{},now:5,ids:['a']})).toEqual({usable:['a'],probe:['a'],skipped:[]});
});
it('only all-failing accounts inside the window leaves nothing usable',()=>{
 expect(googleCircuit({failing:{a:'x'},probes:{a:10},now:11,ids:['a']})).toEqual({usable:[],probe:[],skipped:['a']});
});
