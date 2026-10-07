import {expect,it,vi} from 'vitest';
import {commonOwnerMemory} from '../src/channels/common-owner-memory';
import type {Claim,ClaimStore} from '../src/memory/claims';
const row=(id:number,extra:Partial<Claim>={}):Claim=>({id,kind:'preference',text:'Prefers morning meetings',source:'stated',evidence:'Owner said so',origin:'owner',status:'active',source_ref:'original-owner-message',verification_status:'owner-grounded',created_at:'2026-10-07T00:00:00Z',last_seen_at:'2026-10-07T00:00:00Z',seen_count:1,...extra});
const setup=()=>{let held:string[]=[];const recall=vi.fn(()=>[row(1),row(2,{kind:'health',text:'Sensitive health material'}),row(3,{origin:'untrusted'}),row(4,{valid_to:'2026-10-07T00:00:01Z'}),row(5,{status:'superseded'})]);const store={recall,incompleteTopics:()=>held} as unknown as ClaimStore;return {projection:commonOwnerMemory(store),recall,hold:()=>{held=['held'];}};};
it('projects only current owner memory, never health or external provenance',()=>{const s=setup();expect(s.projection.recall('meetings',8).map(r=>r.id)).toEqual([1]);});
it('pending forget fails closed before reading any retained memory',()=>{const s=setup();s.hold();expect(()=>s.projection.recall('meetings',8)).toThrow('forgetting coverage');expect(s.recall).not.toHaveBeenCalled();});
it('projection rechecks pending forget after source read',()=>{const s=setup();s.recall.mockImplementation(()=>{s.hold();return [row(1)];});expect(()=>s.projection.recall('meetings',8)).toThrow('forgetting coverage');});

it('unverifiable and future claims are not silently promoted as current owner facts',()=>{const s=setup();s.recall.mockReturnValue([row(1,{source_ref:null}),row(2,{verification_status:'provisional'}),row(3,{valid_from:'2099-01-01T00:00:00Z'}),row(4,{valid_from:'invalid'})]);expect(s.projection.recall('meetings',8)).toEqual([]);});
