import { expect,it } from 'vitest';
import { providerStateDigest,SyntheticProviderCustody,type SyntheticProviderStateV1,type EffectRequest } from '../evals/native-provider-state';
const states:readonly SyntheticProviderStateV1[]=[{version:1,provenance:'synthetic_only',owner_id:'a',families:{calendar:[{owner_id:'a',id:'existing',etag:'v1',title:'Fixed',start:'2026-10-01T10:00:00Z',end:'2026-10-01T11:00:00Z'}]},receipts:[]},{version:1,provenance:'synthetic_only',owner_id:'b',families:{calendar:[{owner_id:'b',id:'existing',title:'Control canary'}]},receipts:[]}];
const move:EffectRequest={owner_id:'a',kind:'calendar.move',target:'existing',idempotency_key:'move1',approved_revision:'v2',payload:{expected_etag:'v1',start:'2026-10-01T12:00:00Z',end:'2026-10-01T13:00:00Z'}};
it('canonical state digest ignores object/family row ordering and receipt recursion, preserves exact values',()=>{
 const s=states[0]!;const reordered={...s,families:{calendar:s.families.calendar!.map(r=>Object.fromEntries(Object.entries(r).reverse()) as typeof r)}};
 expect(providerStateDigest(reordered)).toBe(providerStateDigest(s));
 expect(()=>providerStateDigest({...s,families:{calendar:[{owner_id:'a',id:'x',bad:undefined}]}})).toThrow();
 expect(()=>providerStateDigest({...s,families:{calendar:[...s.families.calendar!,...s.families.calendar!]}})).toThrow();
});
it('moves exact event revision once and readbacks original intent after lost response without touching control',()=>{
 const p=new SyntheticProviderCustody(states,()=> '2026-10-01T09:00:00Z');const control=p.readback('b');
 const receipt=p.apply(move,['calendar.move']);expect(receipt.before_digest).not.toBe(receipt.after_digest);
 expect(p.intentReadback('a','calendar.move','move1')).toEqual(receipt);
 expect(p.apply(move,['calendar.move'])).toEqual(receipt);expect(p.readback('a').receipts).toHaveLength(1);expect(p.readback('b')).toEqual(control);
 expect(()=>p.apply({...move,payload:{...move.payload as object,start:'changed'}},['calendar.move'])).toThrow('conflict');
});
it('rejects missing authority/revision/foreignowner/unsupportedshape before changing state',()=>{
 const p=new SyntheticProviderCustody(states,()=> '2026-10-01T09:00:00Z');const before=p.readback('a');
 for(const [r,grant] of [[move,[]],[{...move,approved_revision:null},['calendar.move']],[{...move,owner_id:'foreign'},['calendar.move']],[{...move,kind:'order.submit'},['order.submit']],[{...move,payload:{...move.payload as object,expected_etag:'stale'}},['calendar.move']]] as const)expect(()=>p.apply(r as EffectRequest,grant as readonly EffectRequest['kind'][])).toThrow();
 expect(p.readback('a')).toEqual(before);
});
it('draft and send custody retain exact immutable approved bytes, no actual network/provider access',()=>{
 const p=new SyntheticProviderCustody(states,()=> '2026-10-01T09:00:00Z');
 const draft:EffectRequest={owner_id:'a',kind:'mail.draft',target:'draft1',idempotency_key:'d1',approved_revision:null,payload:{recipient:'fictional@example.invalid',subject:'Test',body:'Exact body',attachment_digest:'sha256:synthetic'}};
 p.apply(draft,['mail.draft']);expect(p.readback('a').families.drafts?.[0]?.body).toBe('Exact body');
 const send:EffectRequest={...draft,kind:'mail.send',target:'send1',idempotency_key:'s1',approved_revision:'approval-rev1'};
 p.apply(send,['mail.send']);expect(p.readback('a').families.sent?.[0]?.recipient).toBe('fictional@example.invalid');
 expect(()=>p.apply({...send,payload:{...send.payload as object,body:'Changed body'}},['mail.send'])).toThrow('conflict');
});
import { applyUnderExactApproval,syntheticPayloadDigest,type SyntheticExactApproval } from '../evals/native-provider-state';
it('exact approval binds owner/kind/target/revision/full payload and current validity, not a revision label alone',()=>{
 const p=new SyntheticProviderCustody(states,()=> '2026-10-01T09:00:00Z');
 const grant:SyntheticExactApproval={owner_id:'a',kind:'calendar.move',target:'existing',approved_revision:'v2',payload_digest:syntheticPayloadDigest(move.payload),effective_at:'2026-10-01T08:00:00Z',expires_at:'2026-10-01T10:00:00Z'};
 for(const changed of [{...move,owner_id:'b'},{...move,target:'other'},{...move,approved_revision:'v3'},{...move,payload:{...move.payload as object,start:'2026-10-01T13:00:00Z'}},{...move,payload:{...move.payload as object,extra:'unreviewed'}}])expect(()=>applyUnderExactApproval(p,changed,grant,'2026-10-01T09:00:00Z')).toThrow('approval');
 expect(()=>applyUnderExactApproval(p,move,grant,grant.expires_at)).toThrow('approval');
 expect(p.readback('a')).toEqual(states[0]);
 expect(applyUnderExactApproval(p,move,grant,'2026-10-01T09:00:00Z').state).toBe('applied');
});
