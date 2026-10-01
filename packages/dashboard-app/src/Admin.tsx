import { useState } from 'react';
import { inviteStatus,pageRows,quota,submitInvite,type AdminRecord } from './admin-model';
export type AdminState = {kind:'loading'}|{kind:'absent'}|{kind:'error'}|{kind:'ready';data:AdminRecord};
const when=(iso:string|null)=>iso ? new Date(iso).toLocaleString('en') : 'Not recorded';
const honesty='Copy it now and send it yourself. Waldo did not email anyone.';
export function AdminPanel({state,onRefresh}:{state:AdminState;onRefresh:()=>Promise<void>}) {
 const [search,setSearch]=useState('');const [status,setStatus]=useState('all');const [ownerStatus,setOwnerStatus]=useState('all');
 const [ownerPage,setOwnerPage]=useState(1);const [invitePage,setInvitePage]=useState(1);const [email,setEmail]=useState('');
 const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [receipt,setReceipt]=useState<{message:string;code:string|null;link:string|null}|null>(null);
 const receiptView = receipt&&<section className="panel" role="status"><h2>{receipt.code?'Invite prepared. Copy it now.':'Invite revoked.'}</h2>{receipt.code&&<><label>{receipt.link ? 'Recipient signup link' : 'One-time code'}<input readOnly value={receipt.link ?? receipt.code} onFocus={e=>e.currentTarget.select()}/></label><p>Copy this link or code before dismissing the receipt or leaving this page. Reloading loses this receipt. It will not appear in the list.</p></>}<p>{receipt.message}</p><button onClick={()=>setReceipt(null)}>Dismiss receipt</button></section>;
 if(state.kind==='loading')return <p role="status">Checking access…</p>;
 if(state.kind==='absent')return <section className="panel"><h1>Page not found.</h1><a href="#/today">Return to Today</a></section>;
 if(state.kind==='error')return <>{receiptView}<section className="panel" role="alert"><h1>This page is unavailable.</h1><p>The protected read could not be loaded or has an unsupported projection.</p><button onClick={()=>void onRefresh()}>Retry</button> <a href="/console/admin">Open existing controls</a></section></>;
 const data=state.data; const allowance=quota(data.current_issuer.issued_count);
 const matching=(value:string|null)=>(value??'').toLowerCase().includes(search.trim().toLowerCase());
 const owners=pageRows(data.owners.filter(o=>matching(o.email)&&(ownerStatus==='all'||o.state===ownerStatus)),ownerPage);
 const invites=pageRows(data.invites.filter(i=>matching(i.email)&&(status==='all'||inviteStatus(i,data.as_of)===status)),invitePage);
 const act=async(action:'invite.create'|'invite.revoke',value:string)=>{
  setBusy(true);setError('');setReceipt(null);
  try{setReceipt(await submitInvite(data,action,value));setEmail('');await onRefresh();}
  catch(e){setError(e instanceof Error?e.message:'The result is unavailable. Refresh before retrying.');}
  finally{setBusy(false);}
 };
 const pager=(name:string,info:typeof owners|typeof invites,setPage:(n:number)=>void)=><nav className="table-pager" aria-label={`${name} pages`}><button disabled={info.current===1} onClick={()=>setPage(info.current-1)}>Previous</button><span>{info.total} matching records · Page {info.current} of {info.pages}</span><button disabled={info.current===info.pages} onClick={()=>setPage(info.current+1)}>Next</button></nav>;
 return <>
  <div className="page-heading"><span className="eyebrow">Restricted controls</span><h1>Invite management.</h1><button disabled={busy} onClick={()=>void onRefresh()}>Refresh records</button><p>Access records and one-use invitations. Joining Waldo does not share another owner’s data.</p></div>
  <section className="panel admin-issue"><h2>Create an invitation</h2><p><strong>{data.current_issuer.email??'Current issuer'}: {allowance.used} of 5 codes issued · {allowance.remaining} remaining</strong></p><p>Used, revoked and expired codes still count. Revoking does not restore quota. Codes expire after 14 days and are email-bound.</p><p>A code is shown once, stored hashed and cannot be recovered. {honesty}</p>
   <form onSubmit={e=>{e.preventDefault();void act('invite.create',email);}}><label>Recipient email<input type="email" required value={email} onChange={e=>setEmail(e.target.value)} disabled={busy||!!receipt?.code||!allowance.remaining}/></label><button disabled={busy||!!receipt?.code||!allowance.remaining}>Create one-use code</button></form>
   {!allowance.remaining&&<p role="status">All five codes have been issued. Creating another invitation is unavailable under the existing policy.</p>}
  </section>
  {receiptView}
  {error&&<p role="alert">{error} <button disabled={busy} onClick={()=>void onRefresh()}>Refresh records</button> <a href="/console/admin">Existing admin controls</a></p>}
  <div className="admin-filters"><label>Search recipient or owner email<input type="search" value={search} onChange={e=>{setSearch(e.target.value);setOwnerPage(1);setInvitePage(1);}}/></label></div>
  <section className="panel"><div className="connection-heading"><h2>Owners</h2><label>Owner state<select value={ownerStatus} onChange={e=>{setOwnerStatus(e.target.value);setOwnerPage(1);}}><option value="all">All states</option>{[...new Set(data.owners.map(o=>o.state))].map(s=><option key={s}>{s}</option>)}</select></label></div>
   <div className="table-scroll" tabIndex={0} role="region" aria-label="Owner records"><table><thead><tr>{['Email','State','Channel presences','Created','Issued quota'].map(h=><th key={h} scope="col">{h}</th>)}</tr></thead><tbody>{owners.rows.map(o=><tr key={o.id}><td>{o.email??'No email recorded'}</td><td>{o.state}</td><td>{o.presences.join(', ')||'None recorded'}</td><td>{when(o.created_at)}</td><td>{o.issued_count} of 5 used</td></tr>)}</tbody></table></div>
   {!owners.total&&<p>{data.owners.length?'No owners match these filters.':'No owner records were returned.'}</p>}{pager('Owners',owners,setOwnerPage)}
  </section>
  <section className="panel"><div className="connection-heading"><h2>Invites</h2><label>Invite status<select value={status} onChange={e=>{setStatus(e.target.value);setInvitePage(1);}}>{['all','open','used','revoked','expired'].map(s=><option key={s} value={s}>{s==='all'?'All statuses':s}</option>)}</select></label></div>
   <div className="table-scroll" tabIndex={0} role="region" aria-label="Invite records"><table><thead><tr>{['Email','Status','Issuer','Created','Expiry','Action'].map(h=><th key={h} scope="col">{h}</th>)}</tr></thead><tbody>{invites.rows.map(i=>{
    const issuer=data.owners.find(o=>o.id===i.issued_by);const s=inviteStatus(i,data.as_of);
    return <tr key={i.id}><td>{i.email??'No email recorded'}</td><td><span className={`access-label ${s}`}>{s}</span></td><td>{i.issued_by ? (i.issuer_email??'Issuer email unavailable') : 'Issuer not recorded'}{issuer&&<small className="issuer-quota">{issuer.issued_count} of 5 used · revoke does not restore quota</small>}</td><td>{when(i.created_at)}</td><td>{when(i.expires_at)}</td><td>{s==='open'?<button disabled={busy||!!receipt?.code} aria-label={`Revoke invitation for ${i.email??'unrecorded email'}`} onClick={()=>void act('invite.revoke',i.id)}>Revoke</button>:'—'}</td></tr>;
   })}</tbody></table></div>
   {!invites.total&&<p>{data.invites.length?'No invites match these filters.':'No invite records were returned.'}</p>}{pager('Invites',invites,setInvitePage)}
  </section>
  <p className="muted">Filters and pages cover all records returned by the protected read, as of {when(data.as_of)}. Refresh to check current eligibility. Codes cannot be recovered or resent. {honesty}</p>
 </>;
}
