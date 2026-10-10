import { appDeletePreparedV1Schema, appRightsInventoryV1Schema } from '../../../contracts/src/app/rights';

const escape = (value: string) => value.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
const scriptJson = (value: unknown) => JSON.stringify(value).replace(/[<>&]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);

// The root renders this only after current console-owner/CSRF admission and
// rightsJobs.prepare. Final authority is the reviewed submit capability; the
// page never retains an ambient session for post-revocation status reads.
export const consoleDeleteReview = (input: unknown, scope: unknown): Response => {
  const prepared = appDeletePreparedV1Schema.parse(input), inventory = appRightsInventoryV1Schema.parse(scope);
  if (prepared.receipt.kind !== 'delete' || prepared.receipt.state !== 'prepared' || prepared.receipt.inventory_revision !== inventory.revision
    || new Set(prepared.receipt.phases.map(phase => phase.store)).size !== inventory.stores.length
    || inventory.stores.some(store => !prepared.receipt.phases.some(phase => phase.store === store.store))) throw new Error('rights_review_scope_changed');
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const claim = { receipt: prepared.receipt.receipt_id, submission: prepared.submission_capability, status: prepared.status_capability,
    status_expires_at: prepared.status_expires_at, stores: inventory.stores.map(store => store.store) };
  const rows = inventory.stores.map(store => `<li><strong>${escape(store.store.replace(/_/g, ' '))}</strong> — ${escape(store.explanation)}</li>`).join('');
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Review account deletion</title>
<style nonce="${nonce}">body{max-width:760px;margin:32px auto;padding:0 20px;font:17px/1.55 system-ui;background:#fafaf8;color:#222}li{margin:12px 0}button{font:inherit;padding:12px 16px;margin:8px 12px 8px 0;border:1px solid #aaa;border-radius:8px;cursor:pointer}button:disabled{cursor:wait;opacity:.65}#confirm{background:#8d2020;color:white}pre{white-space:pre-wrap;overflow-wrap:anywhere}small{display:block;color:#555}</style></head><body>
<h1>Review account deletion</h1><p>Confirming stops new work and access, revokes sessions and devices, and begins cleanup of the managed stores below. Account deletion cannot be undone. Cleanup stays incomplete while a provider write or managed store is unconfirmed.</p>
<ul>${rows}</ul><p>Already sent messages and provider records, backups, retained audit, and offline device copies have the limits shown above. This receipt does not certify those copies erased.</p>
<button id="confirm" type="button">Confirm deletion</button><button id="status" type="button">Check cleanup status</button><button id="save" type="button">Save private status receipt</button>
<small>Save the status receipt or keep this page open to check cleanup after signout. It cannot open your files or make changes. Status access expires ${escape(new Date(prepared.status_expires_at).toISOString())}.</small>
<pre id="receipt" role="status" aria-live="polite">Prepared. No deletion has been submitted.</pre>
<script nonce="${nonce}">
const claim=${scriptJson(claim)};
const output=document.getElementById('receipt'), confirmButton=document.getElementById('confirm'), statusButton=document.getElementById('status');
let submitted=false;
const show=receipt=>{
 if(!receipt||receipt.version!=='rights.v1'||receipt.receipt_id!==claim.receipt||receipt.kind!=='delete'||!Array.isArray(receipt.phases)||!Array.isArray(receipt.limits))throw Error('unconfirmed');
 const phases=receipt.phases.map(phase=>{if(!claim.stores.includes(phase.store)||!['pending','running','completed','failed','retained','outside_control'].includes(phase.state))throw Error('unconfirmed');return phase.store.replaceAll('_',' ')+': '+phase.state;});
 output.textContent='Cleanup: '+receipt.state+'\\n'+phases.join('\\n')+'\\nLimits: '+receipt.limits.join(', ');
};
const post=async(path,body)=>{const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);try{const response=await fetch(path,{method:'POST',credentials:'omit',signal:controller.signal,headers:{'content-type':'application/json'},body:JSON.stringify(body)});if(!response.ok)throw Error('unconfirmed');show(await response.json());}finally{clearTimeout(timer);}};
confirmButton.addEventListener('click',async()=>{if(submitted)return;submitted=true;confirmButton.disabled=true;output.textContent='Deletion submitted. Waiting for the cleanup receipt.';try{await post('/app/v1/rights/delete/submit',{submission_capability:claim.submission,confirmed:true});}catch{output.textContent='Submission is unconfirmed. Check cleanup status before taking any further action.';}});
statusButton.addEventListener('click',async()=>{statusButton.disabled=true;try{await post('/app/v1/rights/receipts/status',{status_capability:claim.status});}catch{output.textContent='Cleanup status is unavailable. The last outcome remains unconfirmed. Keep the private status receipt and check again.';}finally{statusButton.disabled=false;}});
document.getElementById('save').addEventListener('click',()=>{const bytes=JSON.stringify({version:'rights-status.v1',receipt_id:claim.receipt,status_capability:claim.status,status_expires_at:claim.status_expires_at}),url=URL.createObjectURL(new Blob([bytes],{type:'application/json'})),anchor=document.createElement('a');anchor.href=url;anchor.download='waldo-cleanup-status-'+claim.receipt+'.json';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
</script></body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
    'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` } });
};
