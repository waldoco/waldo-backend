import {PatternExplorer} from './Constellation';
export {PatternExplorer} from './Constellation';
import {ControlsPanel} from './Controls';
import {MemoryActions} from './MemoryActions';
import {useEffect,useState} from 'react';
import {fetchMemory,memoryItemLink,MemoryReadError,type Claim,type Interpretation,type MemoryStatus,type MemoryPage,type MemoryDetail,type MemoryPattern} from './memory-model';
import {SignInRequired} from './model';
const label=(item:Claim|Interpretation)=>'text' in item?item.text:item.label;
const recorded=(value:string)=>Number.isNaN(Date.parse(value))?'Time unavailable':new Date(value).toLocaleString('en');
const source=(value:string)=>value==='inferred'?'Waldo’s inference':value==='stated'?'You said this':value==='confirmed'?'You confirmed this':'Recorded source: '+value;
const origin=(value:string)=>({owner:'Owner',agent:'Agent',shared:'Shared · untrusted provenance',untrusted:'Untrusted origin',legacy:'Legacy origin'}[value]??'Origin unavailable');
export function MemoryReadNotice({data}:{data:MemoryStatus}) {
 if(data.state==='available'&&data.complete)return null;
 return <div className="memory-read-notice" role="status"><strong>{data.state==='unavailable'?'Memory unavailable':'Incomplete Memory read'}</strong><p>These are only the records available in this read. Missing or withheld records are not an empty Memory or proof of completed removal.</p>{data.unavailable_claim_count>0&&<p>{data.unavailable_claim_count} claims withheld during removal. Retained text may still require a removal retry.</p>}</div>;
}
export function MemoryList({data,onNext,onRestart}:{data:MemoryPage;onNext:()=>void;onRestart:()=>void}) {
 const patterns=data.view==='interpretations';
 return <><MemoryReadNotice data={data}/><div className="memory-list-toolbar"><p>{data.page.returned} returned · {data.page.total} available {patterns?'patterns':'Spots'} in this read</p><button onClick={onRestart}>Refresh list</button></div>
 <div className="memory-record-list">{data.items.map(item=><a className="memory-record" key={item.id} href={memoryItemLink(patterns?'constellation':'spots',item.id)}>
  <span className="memory-record-symbol" aria-hidden="true">{patterns?'✧':'◦'}</span><div><h2>{label(item)}</h2>{'text' in item?<><p className="memory-meta">{origin(item.origin)} · {source(item.source)} · {item.kind} · {item.status}</p><p className="muted">Recorded {recorded(item.recorded_at)}</p></>:<><p>{item.summary}</p><p className="memory-meta">Tentative interpretation · Stored status: {item.stored_status} · {item.support.claim_ids.length} saved supporting Spots</p></>}</div><span aria-hidden="true">→</span>
 </a>)}</div>
 {!data.items.length&&data.complete&&data.state==='available'&&<section className="panel"><h2>{data.page.total===0?`No saved ${patterns?'patterns':'Spots'} returned.`:'No records returned on this page.'}</h2><p>{data.page.total===0?'This is the complete available list in this read.':'Records may have changed since the previous page. Return to the first page or refresh the list.'}</p></section>}
 <nav className="memory-pagination" aria-label="Memory list pages"><button onClick={onRestart}>First page</button><button disabled={!data.page.next_cursor} onClick={onNext}>Next page</button></nav></>;
}
export function MemoryDetailView({data}:{data:MemoryDetail}) {
 const item=data.item,pattern=data.kind==='interpretation';
 return <><MemoryReadNotice data={data}/><a href={`#/memory/${pattern?'constellation':'spots'}`}>← Back to {pattern?'patterns':'Spots'}</a><section className="memory-item-detail panel"><span className="eyebrow">{pattern?'Tentative interpretation':'Saved Spot'}</span><h2>{label(item)}</h2>
 {'text' in item?<><p className="memory-meta">{origin(item.origin)} · {source(item.source)} · {item.kind} · {item.status}</p><dl><dt>Recorded source</dt><dd>{item.source||'Unavailable'}</dd><dt>Writer note — not proof of truth</dt><dd>{item.evidence.text||'No writer note recorded.'}</dd><dt>Source pointer withheld</dt><dd>{item.source_reference.state==='unverified'?'An unverified pointer is recorded. It is not an original-message link.':'No retrievable original-message source is available.'}</dd><dt>Recorded</dt><dd>{recorded(item.recorded_at)}</dd><dt>Writer seen count</dt><dd>{item.writer_seen_count??'Unavailable'} · not independently verified observations</dd></dl></>:<><p>{item.summary}</p><p className="memory-meta">Stored status: {item.stored_status} · {item.domain||'Domain unavailable'}</p><p>Strength: {item.estimate===null?'unavailable':item.estimate} · uncalibrated model estimate, not probability of truth.</p><p>Supporting observations are not independently verified.</p><a className="button-link" href={`${memoryItemLink('constellation',item.id)}&explore=1`}>Explore saved connections</a></>}
 {data.kind==='claim'?<><h3>Linked saved patterns</h3>{data.linked_interpretation_ids.length?<ul>{data.linked_interpretation_ids.map((id,i)=><li key={id}><a href={memoryItemLink('constellation',id)}>Inspect linked pattern {i+1}</a></li>)}</ul>:<p>No linked patterns were returned.</p>}</>:<><h3>Saved supporting Spots</h3><ul>{data.support_claim_ids.map((id,i)=><li key={id}><a href={memoryItemLink('spots',id)}>Inspect supporting Spot {i+1}</a></li>)}</ul>{data.support_unavailable_count>0&&<p>{data.support_unavailable_count} supporting Spots unavailable.</p>}</>}

 </section></>;
}
function locationState(){if(typeof window==='undefined')return {id:null,explore:false};const raw=window.location.hash.split('?')[1]??'',p=new URLSearchParams(raw);return {id:p.get('id'),explore:p.get('explore')==='1'};}
export function MemoryPanel({subview}:{subview:'spots'|'constellation'|'profile'}) {
 const [location,setLocation]=useState(locationState);const [cursor,setCursor]=useState<string|null>(null);const [retry,setRetry]=useState(0);
 const [state,setState]=useState<{kind:'loading'}|{kind:'ready';data:MemoryPage|MemoryDetail|MemoryPattern}|{kind:'error';message:string;code?:string;signedOut:boolean}>({kind:'loading'});
 useEffect(()=>{const change=()=>{setLocation(locationState());setCursor(null);};window.addEventListener('hashchange',change);return()=>window.removeEventListener('hashchange',change);},[]);
 useEffect(()=>{setCursor(null);},[subview]);
 useEffect(()=>{
  if(subview==='profile')return;
  const abort=new AbortController();setState({kind:'loading'});
  const params=new URLSearchParams(location.id?location.explore&&subview==='constellation'?{view:'pattern',id:location.id,max_nodes:'12',max_links:'20'}:{view:'detail',id:location.id}:{view:subview==='spots'?'claims':'interpretations',limit:'25'});
  if(cursor)params.set('cursor',cursor);
  fetchMemory(params,abort.signal).then(data=>{if(!abort.signal.aborted)setState({kind:'ready',data});}).catch(e=>{if(!abort.signal.aborted)setState({kind:'error',message:e instanceof Error?e.message:'Memory unavailable.',code:e instanceof MemoryReadError?e.code:undefined,signedOut:e instanceof SignInRequired});});return()=>abort.abort();
 },[subview,location.id,location.explore,cursor,retry]);
 const restart=()=>{setCursor(null);setRetry(n=>n+1);};
 return <><div className="page-heading"><span className="eyebrow">Correctable context</span><h1>Memory.</h1><p>Inspect saved context. Keep the evidence visible and the interpretations yours.</p></div><nav className="memory-tabs" aria-label="Memory subviews">{(['spots','constellation','profile'] as const).map(v=><a href={`#/memory/${v}`} aria-current={v===subview?'page':undefined} key={v}>{v==='spots'?'Spots':v==='constellation'?'Constellation':'Profile'}</a>)}</nav>
 {subview==='profile'?<ControlsPanel key="profile" view="profile" embedded/>:state.kind==='loading'?<p role="status">Loading your saved {location.id?'item':subview==='spots'?'Spots':'patterns'}…</p>:state.kind==='error'?<section className="panel" role="alert"><h2>Memory unavailable.</h2><p>{state.message}</p>{state.signedOut?<a href="/console/signin">Sign in</a>:<><button onClick={restart}>{state.code==='cursor_invalid'?'Restart list':'Retry read'}</button> <a href={`#/memory/${subview}`}>Back to list</a></>}</section>:state.data.view==='detail'?<MemoryDetailView data={state.data}/>:state.data.view==='pattern'?<PatternExplorer data={state.data} onRestart={restart} onNext={()=>setCursor(state.data.view==='pattern'?state.data.expand.next_cursor:null)}/>:<MemoryList data={state.data} onRestart={restart} onNext={()=>setCursor(state.data.view==='claims'||state.data.view==='interpretations'?state.data.page.next_cursor:null)}/>}
 {location.id&&subview!=='profile'&&<MemoryActions key={location.id} id={location.id} onChanged={restart}/>}
 </>;
}
