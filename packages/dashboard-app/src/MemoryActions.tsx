import {useEffect,useRef,useState} from 'react';
import {submitControl,ControlsActionError,type ControlAction,type ActionResult} from './controls-model';
import {ControlReceipt} from './Controls';
import {SignInRequired,StepUpRequired,confirmHref} from './model';
type MemoryActionRecord={csrf:string;revision:string;view:'memory';data:{id:string;status:string;review?:{label:string;note:string};actions:ControlAction[]}};
const allowed=['spot.confirm','spot.dismiss','spot.forget','spot.pin','spot.unpin','spot.edit','node.confirm','node.correct','node.forget'];
// An edited Spot's text and a corrected pattern's words, as the Worker bounds them.
const EDIT_MAX=1000,CORRECT_MAX=140;
export function readMemoryControls(value:unknown,id:string):MemoryActionRecord {
 const v=value as Record<string,unknown>|null;
 if(!v||v.version!==1||v.view!=='memory'||v.state!=='available'||typeof v.csrf!=='string'||!v.csrf||typeof v.revision!=='string'||!/^[a-f0-9]{64}$/.test(v.revision)||!v.data||typeof v.data!=='object')throw new Error('Memory controls are unavailable. Refresh this item.');
 const data=v.data as {id?:unknown;status?:unknown;review?:{label?:unknown;note?:unknown};actions?:unknown};
 if(data.id!==id||typeof data.status!=='string'||!Array.isArray(data.actions)||!data.actions.every(a=>allowed.includes(a)))throw new Error('Memory action eligibility is unavailable. Refresh this item.');
 if(data.status!=='purging'&&(!data.review||typeof data.review.label!=='string'||typeof data.review.note!=='string'))throw new Error('The action review is unavailable. Refresh this item.');
 return {csrf:v.csrf,revision:v.revision,view:'memory',data:{id,status:data.status,review:data.review?{label:data.review.label as string,note:data.review.note as string}:undefined,actions:data.actions}};
}
export async function fetchMemoryControls(id:string,signal?:AbortSignal){
 const response=await fetch(`/console/dashboard/api/v1/memory-controls?${new URLSearchParams({id})}`,{credentials:'same-origin',cache:'no-store',redirect:'error',headers:{accept:'application/json'},signal});
 if(response.status===401)throw new SignInRequired();
 if(!response.ok)throw new Error(response.status===404?'This item is no longer available. Refresh Memory.':'Memory controls could not load. Retry this protected read.');
 return readMemoryControls(await response.json(),id);
}
const labels:Partial<Record<ControlAction,string>>={'spot.confirm':'That’s right','spot.unpin':'Unpin','spot.dismiss':'Dismiss','spot.forget':'Forget this Spot','node.confirm':'That’s right','node.forget':'Forget this pattern'};
export function MemoryActions({id,onChanged}:{id:string;onChanged?:()=>void}) {
 const [record,setRecord]=useState<MemoryActionRecord|null>(null),[error,setError]=useState<string|null>(null),[retry,setRetry]=useState(0),[busy,setBusy]=useState(false),[result,setResult]=useState<ActionResult|null>(null);
 const flight=useRef(false),attempt=useRef<{record:MemoryActionRecord;action:ControlAction;value?:string;request:string}|null>(null),[draft,setDraft]=useState<string|null>(null),[stepUp,setStepUp]=useState(false);
 useEffect(()=>{const abort=new AbortController();setRecord(null);setError(null);fetchMemoryControls(id,abort.signal).then(data=>{if(!abort.signal.aborted)setRecord(data);}).catch(e=>{if(!abort.signal.aborted)setError(e instanceof Error?e.message:'Memory controls unavailable.');});return()=>abort.abort();},[id,retry]);
 const refresh=()=>{if(flight.current)return;setRetry(n=>n+1);};
 const perform=async()=>{const current=attempt.current;if(!current||flight.current)return;flight.current=true;setBusy(true);setError(null);try{const next=await submitControl(current.record,current.action,{id:current.record.data.id,value:current.value},current.request);setResult(next);if(next.receipt.state!=='unconfirmed'){attempt.current=null;setRetry(n=>n+1);onChanged?.();}}catch(e){setStepUp(e instanceof StepUpRequired);setError(e instanceof Error?e.message:'Outcome unavailable.');if(!(e instanceof ControlsActionError&&e.uncertain))attempt.current=null;}finally{flight.current=false;setBusy(false);}};
 const act=(action:ControlAction,value?:string)=>{if(!record||flight.current||attempt.current||error)return;if(action==='spot.forget'||action==='node.forget'){if(!window.confirm(action==='node.forget'?'Forget this pattern and its links? Supporting Spots remain.':'Forget this Spot? Removal may need retries if a store is unavailable.'))return;}attempt.current={record,action,value,request:crypto.randomUUID()};setResult(null);setStepUp(false);void perform();};
 const correcting=record?.data.actions.includes('node.correct')?'node.correct' as const:'spot.edit' as const;
 const editing=record?.data.actions.includes(correcting)?draft??record.data.review?.label??'':null,edited=editing?.trim()??'';
 return <section className="memory-action-recovery"><h3>Manage this memory</h3><p>Pin what Waldo should keep in mind on every turn, or correct a Spot in your own words. Writer notes and saved links remain evidence to inspect, not proof of truth.</p>
 {result&&<ControlReceipt result={result} onCheck={result.receipt.state==='unconfirmed'?()=>void perform():undefined} onRefresh={refresh} busy={busy}/>}
 {attempt.current&&!result&&<div role="alert"><p>This request is unresolved. Refreshing the read does not permit a new request.</p><button disabled={busy} onClick={()=>void perform()}>Check this request</button></div>}
 {error&&<div role="alert"><p>{error}</p>{stepUp&&<a className="button" href={confirmHref()}>Get an email code</a>}<button disabled={busy} onClick={refresh}>Refresh Memory controls</button></div>}
 {!record&&!error&&<p role="status">Loading supported Memory actions…</p>}
 {record&&<>{record.data.review&&<div className="panel"><span className="eyebrow">Current action review</span><h4>{record.data.review.label}</h4><p>{record.data.review.note}</p><p className="muted">Review this current saved item before acting. The note is not proof of truth.</p></div>}<div className="control-actions">{record.data.actions.filter(action=>action!=='spot.pin'&&action!=='spot.edit'&&action!=='node.correct').map(action=><button key={action} disabled={busy||!!error||!!attempt.current} onClick={()=>act(action)}>{action==='spot.forget'&&record.data.status==='purging'?'Retry forget':labels[action]}</button>)}</div>{record.data.actions.includes('spot.pin')&&<div className="control-actions"><button disabled={busy||!!error||!!attempt.current} onClick={()=>act('spot.pin','profile')}>Pin to profile</button><button disabled={busy||!!error||!!attempt.current} onClick={()=>act('spot.pin','facts')}>Pin to facts</button></div>}{editing!==null&&<form className="memory-edit" onSubmit={event=>{event.preventDefault();if(edited)act(correcting,edited);}}><label>{correcting==='node.correct'?'Correct this pattern in your words':'Correct this Spot in your words'}<textarea value={editing} maxLength={correcting==='node.correct'?CORRECT_MAX:EDIT_MAX} onChange={event=>setDraft(event.target.value)}/></label><button type="submit" disabled={busy||!!error||!!attempt.current||!edited}>Save edit</button></form>}{record.data.status==='purging'&&<p>Removal is incomplete. Retained text may still require a retry; this is not proof that every byte has been purged.</p>}{record.data.actions.includes('node.forget')&&<p>Forgetting a pattern leaves its supporting Spots. Forget those separately if needed.</p>}</>}
 </section>;
}
