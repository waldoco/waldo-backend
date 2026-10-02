// Synthetic records with the reviewed Memory v1 projection shape; never imported by the app.
const common={version:1,state:'available',complete:true,unavailable_claim_count:0,actions:[]};
const claim={id:'synthetic-owner:claim:1',local_id:1,kind:'preference',text:'<script>claim</script>',source:'inferred',origin:'shared',status:'active',evidence:{kind:'writer_note',text:'A writer note'},source_reference:{state:'unverified',link:null,visibility:'withheld_unverified_pointer',retrievable:false},recorded_at:'2026-10-01T01:00:00Z',writer_seen_count:1};
const node=(n:number)=>({id:`synthetic-owner:node:${n}`,local_id:n,type:'interpretation',label:`Pattern ${n===1?'A':'B'}`,summary:'Tentative rhythm',domain:'day',stored_status:n===1?'active':'stale',recorded_active_at:'2026-10-01T01:00:00Z',estimate:.4,estimate_kind:'uncalibrated_model_estimate',support:{state:'stored_links',claim_ids:[claim.id],unavailable_count:0,distinct_source_refs:1,independent_observations:'unverified'}});
export const response=(query:string)=>{
 const p=new URLSearchParams(query),view=p.get('view');
 if(view==='claims'||view==='interpretations'){const items=view==='claims'?[claim]:[node(1),node(2)];return {...common,view,items,page:{limit:25,returned:items.length,total:items.length,next_cursor:null}};}
 if(view==='detail')return p.get('id')?.includes(':claim:')?{...common,view,kind:'claim',item:claim,linked_interpretation_ids:[node(1).id]}:{...common,view,kind:'interpretation',item:node(1),support_claim_ids:[claim.id],support_unavailable_count:0};
 return {...common,view:'pattern',center:node(1),nodes:[node(2)],associations:[{from:node(1).id,to:node(2).id,relation:'possible support',state:'unverified_association',estimate:.3,writer_evidence_count:1,evidence_links:[]}],showing:{nodes:1,of_nodes:1,links:1,of_links:1},truncated:false,omitted_links:0,expand:{next_cursor:null,links_capped:false,capped_links_recoverable:false,capped_links:0}};
};
