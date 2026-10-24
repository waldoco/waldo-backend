// Synthetic records with the reviewed Memory v1 projection shape; never imported by the app.
const common={version:1,state:'available',complete:true,unavailable_claim_count:0,actions:[]};
const claim={id:'synthetic-owner:claim:1',local_id:1,kind:'preference',text:'<script>claim</script>',source:'inferred',origin:'shared',status:'active',evidence:{kind:'writer_note',text:'A writer note'},source_reference:{state:'unverified',link:null,visibility:'withheld_unverified_pointer',retrievable:false},recorded_at:'2026-10-01T01:00:00Z',writer_seen_count:1};
export const response=(query:string)=>{
 const p=new URLSearchParams(query),view=p.get('view');
 if(view==='claims')return {...common,view,items:[claim],page:{limit:25,returned:1,total:1,next_cursor:null}};
 return {...common,view:'detail',kind:'claim',item:claim,linked_interpretation_ids:[]};
};
