// Owner-scoped read projection. No initializer, model calls, URLs or mutation helpers.
export const MEMORY_GRAPH_PATH='/console/dashboard/api/v1/memory';
type Row=Record<string,unknown>;
const text=(v:unknown)=>typeof v==='string'?v:'';
const id=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0;
const finite=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)?v:null;
const ref=(scope:string,kind:string,n:number)=>`${scope}:${kind}:${n}`;
export const projectMemoryGraph=(input:Readonly<{scope:string;claims:readonly Row[];nodes:readonly Row[];edges:readonly Row[];complete:boolean;unavailable?:boolean;purgePending?:boolean}>)=>{
 let partial=!input.complete;const suppressed=input.claims.filter(c=>c.status==='purging'||c.status==='forgotten');
 const claims=input.claims.filter(c=>id(c.id)&&['active','promoted'].includes(text(c.status))&&!text(c.text).includes('[forgotten]')).map(c=>({id:ref(input.scope,'claim',c.id as number),local_id:c.id as number,kind:text(c.kind),text:text(c.text),source:text(c.source),origin:['owner','agent','shared','untrusted'].includes(text(c.origin))?text(c.origin):'legacy',status:text(c.status),evidence:{kind:'writer_note' as const,text:text(c.evidence)},source_reference:{state:text(c.source_ref)?'unverified' as const:'unavailable' as const,link:null},recorded_at:text(c.created_at),writer_seen_count:finite(c.seen_count)}));
 const byId=new Map(claims.map(c=>[c.local_id,c]));
 // Pending purge can leave labels/summaries/edges quoting a forgotten claim.
 // Fail closed for interpretations until existing purge completes, not a delete guarantee.
 const nodes=suppressed.length||input.purgePending?[]:input.nodes.filter(n=>id(n.id)&&!text(n.label).includes('[forgotten]')&&!text(n.summary).includes('[forgotten]')).map(n=>{
  let support:number[]=[];let valid=true;try{const value=JSON.parse(text(n.supporting_spots));if(!Array.isArray(value)||!value.every(id))valid=false;else support=[...new Set(value)];}catch{valid=false}
  const available=support.filter(i=>byId.has(i));if(!valid||available.length!==support.length)partial=true;
  const sourceRefs=new Set(input.claims.filter(c=>available.includes(c.id as number)).map(c=>text(c.source_ref)).filter(Boolean));
  const estimate=finite(n.strength);
  return{id:ref(input.scope,'node',n.id as number),local_id:n.id as number,type:'interpretation' as const,label:text(n.label),summary:text(n.summary),domain:text(n.domain),stored_status:text(n.status),recorded_active_at:text(n.last_confirmed),estimate:estimate!==null&&estimate>=0&&estimate<=1?estimate:null,estimate_kind:'uncalibrated_model_estimate' as const,support:{state:!valid?'invalid' as const:available.length===support.length?'stored_links' as const:'incomplete' as const,claim_ids:available.map(i=>ref(input.scope,'claim',i)),unavailable_count:support.length-available.length,distinct_source_refs:sourceRefs.size,independent_observations:'unverified' as const}};
 });
 const nodeIds=new Set(nodes.map(n=>n.local_id));
 const associations=suppressed.length||input.purgePending?[]:input.edges.filter(e=>id(e.from_id)&&id(e.to_id)&&e.from_id!==e.to_id&&nodeIds.has(e.from_id)&&nodeIds.has(e.to_id)).map(e=>({from:ref(input.scope,'node',e.from_id as number),to:ref(input.scope,'node',e.to_id as number),relation:text(e.relation),state:'unverified_association' as const,estimate:finite(e.strength)!==null&&Number(e.strength)>=0&&Number(e.strength)<=1?Number(e.strength):null,writer_evidence_count:finite(e.evidence_count)!==null&&Number.isSafeInteger(e.evidence_count)&&Number(e.evidence_count)>=1?Number(e.evidence_count):null,evidence_links:[] as string[]}));
 if(suppressed.length||input.purgePending)partial=true;
 return{version:1 as const,state:input.unavailable?'unavailable' as const:partial?'partial' as const:'available' as const,complete:!partial&&!input.unavailable,claims,nodes,associations,unavailable_claim_count:suppressed.length,actions:[] as string[]};
};
export const readMemoryGraph=(sql:Pick<SqlStorage,'exec'>,scope:string)=>{
 const tables=new Set(sql.exec<{name:string}>("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('claims','constellation_nodes','constellation_edges','purge_pending')").toArray().map(r=>r.name));
 const read=(name:string):Row[]=>tables.has(name)?sql.exec<Record<string,SqlStorageValue>>(`SELECT * FROM ${name}`).toArray():[];
 const claims=read('claims');const pending=new Set(read('purge_pending').map(r=>r.claim_id));
 const safe=claims.map(c=>pending.has(c.id)?{...c,status:'purging'}:c);
 const purgeKnown=tables.has('purge_pending');
 return projectMemoryGraph({scope,claims:safe,nodes:purgeKnown?read('constellation_nodes'):[],edges:purgeKnown?read('constellation_edges'):[],purgePending:pending.size>0,complete:['claims','constellation_nodes','constellation_edges','purge_pending'].every(t=>tables.has(t)),unavailable:!tables.has('claims')});
};
